import type { Prisma } from '@prisma/client';
import type { DesktopInboxItem, DesktopInboxResponse } from '@baton/shared';
import { requestInboxWhere, requestOutboxWhere } from '../requests/requests.service';

const recipientStates = ['SENT', 'DELIVERED', 'REVIEWING', 'ACCEPTED', 'READY_TO_RUN', 'RESULT_REVIEW', 'FAILED'] as const;

export function desktopInboxWhere(userId: string): Prisma.RequestWhereInput {
  return { OR: [
    { AND: [requestInboxWhere(userId), {
      state: { in: [...recipientStates] },
      // 웹에서는 남이 맡은 팀 요청도 보이지만 내 차례에서는 제외한다.
      OR: [{ recipientUserId: userId }, { recipientUserId: null, claimedAt: null }],
    }] },
    { AND: [requestOutboxWhere(userId), { state: 'RETURNED' }] },
  ] };
}

type InboxRow = {
  id: string; title: string; state: string; senderUserId: string;
  recipientUserId: string | null; claimedAt: Date | null; updatedAt: Date;
  senderTeam: { name: string }; recipientTeam: { name: string };
  executions: { executorUserId: string }[];
};

/** 입력은 반드시 desktopInboxWhere로 권한을 제한한 행이어야 한다. */
export function projectDesktopInbox(rows: InboxRow[], userId: string): DesktopInboxResponse {
  const items: DesktopInboxItem[] = [];
  for (const row of rows) {
    let reason: DesktopInboxItem['reason'];
    let role: DesktopInboxItem['role'] = 'recipient';
    if (row.state === 'RETURNED' && row.senderUserId === userId) {
      role = 'sender';
      reason = '보완 요청';
    } else {
      if (row.recipientUserId !== userId && (row.recipientUserId !== null || row.claimedAt !== null)) continue;
      switch (row.state) {
        case 'SENT': case 'DELIVERED': case 'REVIEWING': reason = '확인 필요'; break;
        case 'ACCEPTED': case 'READY_TO_RUN': reason = '실행 준비'; break;
        case 'RESULT_REVIEW': case 'FAILED':
          if (row.executions[0]?.executorUserId !== userId) continue;
          reason = row.state === 'RESULT_REVIEW' ? '결과 검토' : '실행 실패';
          break;
        default: continue;
      }
    }
    items.push({ id: row.id, title: row.title, state: row.state, role, reason,
      teamName: role === 'recipient' ? row.senderTeam.name : row.recipientTeam.name,
      updatedAt: row.updatedAt.toISOString() });
  }
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return { items: items.slice(0, 20), count: items.length };
}

export async function getDesktopInbox(db: Prisma.TransactionClient, userId: string): Promise<DesktopInboxResponse> {
  const rows = await db.request.findMany({
    where: desktopInboxWhere(userId), orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    select: {
      id: true, title: true, state: true, senderUserId: true, recipientUserId: true, claimedAt: true, updatedAt: true,
      senderTeam: { select: { name: true } }, recipientTeam: { select: { name: true } },
      executions: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, select: { executorUserId: true } },
    },
  });
  return projectDesktopInbox(rows, userId);
}
