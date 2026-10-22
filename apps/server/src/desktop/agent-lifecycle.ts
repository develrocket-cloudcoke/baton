import { AgentProvider, Prisma } from '@prisma/client';

// MVP는 디바이스·provider마다 Agent 하나를 재사용한다. Device 행 잠금으로 동시 등록도 직렬화한다.
export async function canonicalAgent(
  tx: Prisma.TransactionClient,
  deviceId: string,
  provider: AgentProvider = 'CLAUDE_CODE',
) {
  // Prisma update의 사전 조회가 REPEATABLE READ 스냅샷을 만들지 않도록 SQL 잠금을 먼저 획득한다.
  await tx.$queryRaw`SELECT id FROM Device WHERE id = ${deviceId} FOR UPDATE`;
  const agents = await tx.agent.findMany({
    where: { deviceId, provider, status: { not: 'DISABLED' } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: {
      executions: {
        where: { status: { in: ['QUEUED', 'RUNNING'] } },
        select: { id: true },
        take: 1,
      },
    },
  });
  // 기존 중복은 진행 중인 실행의 Agent 우선, 그다음 최초 등록을 보존한다. FK·실행 이력은 삭제하지 않는다.
  const canonical = agents.find((agent) => agent.executions.length) ?? agents[0];
  if (canonical)
    await tx.agent.updateMany({
      where: {
        deviceId,
        provider,
        id: { not: canonical.id },
        status: { not: 'DISABLED' },
      },
      data: { status: 'DISABLED' },
    });
  return canonical;
}
