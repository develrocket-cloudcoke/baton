import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma, Request } from '@prisma/client';

export const publicPerson = { id: true, email: true, displayName: true } as const;
export const requestPeople = {
  senderTeam: { select: { id: true, name: true } },
  recipientTeam: { select: { id: true, name: true } },
  // 웹은 사람 이름을 조직 사용자 목록에서 찾아 쓰는데 그 목록은 ORG_ADMIN 만 받을 수 있다.
  // 발신자를 실어 보내지 않으면 일반 사용자 화면에 UUID 가 그대로 노출된다.
  sender: { select: publicPerson },
  recipient: { select: publicPerson },
} as const;

export async function isTeamRecipient(
  db: Prisma.TransactionClient,
  request: Request,
  userId: string,
) {
  return (
    request.senderUserId !== userId &&
    !!(await db.teamMembership.findFirst({
      where: {
        teamId: request.recipientTeamId,
        userId,
        user: {
          orgMemberships: {
            some: {
              orgId: (await db.team.findUniqueOrThrow({ where: { id: request.recipientTeamId } }))
                .orgId,
            },
          },
        },
      },
    }))
  );
}

export async function assertRecipient(
  db: Prisma.TransactionClient,
  request: Request,
  userId: string,
) {
  if (request.recipientUserId === userId) return;
  if (await isTeamRecipient(db, request, userId)) {
    if (request.claimedAt) throw new ConflictException('이미 다른 팀원이 처리 중');
    if (!request.recipientUserId && request.state !== 'DRAFT') return;
  }
  throw new ForbiddenException();
}

// 요청의 문서·첨부를 읽거나 올릴 수 있는 사람: 발신자, 확정된 수신자, 그리고 팀 전체 뿌리기 요청(미확정 또는 claim 됨)의
// 수신 팀원. 팀 간 요청(05 §3.1)에서는 수신자가 발신 팀 소속이 아니므로 팀 멤버십만으로는 판단할 수 없다 (W5d-2).
export async function canAccessRequestContent(
  db: Prisma.TransactionClient,
  request: Request,
  userId: string,
) {
  if (request.senderUserId === userId || request.recipientUserId === userId) return true;
  if (!request.recipientUserId || request.claimedAt) return isTeamRecipient(db, request, userId);
  return false;
}

export async function isOrgAdmin(
  db: Prisma.TransactionClient,
  request: Request,
  userId: string,
) {
  const teams = await db.team.findMany({
    where: { id: { in: [request.recipientTeamId, request.senderTeamId] } },
    select: { orgId: true },
  });
  const orgIds = Array.from(new Set(teams.map((t) => t.orgId)));
  if (orgIds.length === 0) return false;
  const adminMembership = await db.orgMembership.findFirst({
    where: {
      userId,
      orgId: { in: orgIds },
      role: 'ORG_ADMIN',
    },
  });
  return !!adminMembership;
}

export async function isSenderOnly(
  db: Prisma.TransactionClient,
  request: Request,
  userId: string,
) {
  if (request.recipientUserId === userId) return false;
  if (await isTeamRecipient(db, request, userId)) return false;
  if (await isOrgAdmin(db, request, userId)) return false;
  return request.senderUserId === userId;
}

