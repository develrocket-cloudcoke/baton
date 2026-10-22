import { Prisma } from '@prisma/client';
export const presenceCutoff = () => new Date(Date.now() - 120_000);
export async function expirePresence(db: Prisma.TransactionClient, userId: string) {
  // 조회 시 DB도 갱신한다. MVP에서 별도 타이머 없이 화면과 저장 상태를 일치시킨다.
  await db.agent.updateMany({
    where: {
      ownerUserId: userId,
      status: { in: ['ONLINE', 'BUSY'] },
      OR: [{ lastSeenAt: null }, { lastSeenAt: { lte: presenceCutoff() } }],
    },
    data: { status: 'OFFLINE' },
  });
}
