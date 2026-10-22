import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { APPROVAL_TTL_MS, CreateApprovalSchema, ApprovalDecisionSchema, truncateApprovalDetail } from '@baton/shared';
import { Prisma, ExecutionApproval } from '@prisma/client';
import { PrismaService } from '../prisma.service';

// 실행 행을 먼저 잠근다. 승인 생성/결정과 실행 종료를 같은 잠금 순서로 직렬화한다.
async function lockedExecution(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM Execution WHERE id = ${id} FOR UPDATE`;
  const execution = await tx.execution.findUnique({ where: { id }, include: { agent: true, request: true } });
  if (!execution) throw new NotFoundException();
  return execution;
}

export async function expireExecutionApprovals(tx: Prisma.TransactionClient, executionId: string, now = new Date()) {
  const rows = await tx.executionApproval.findMany({ where: { executionId, status: 'PENDING' } });
  for (const row of rows) await settle(tx, row, 'EXPIRED', null, now);
}

async function settle(tx: Prisma.TransactionClient, row: ExecutionApproval, status: 'ALLOWED' | 'DENIED' | 'EXPIRED', userId: string | null, now: Date) {
  const changed = await tx.executionApproval.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status, decidedByUserId: userId, decidedAt: now } });
  if (!changed.count) throw new ConflictException('이미 결정된 승인입니다.');
  const execution = await tx.execution.findUniqueOrThrow({ where: { id: row.executionId } });
  await tx.timelineEvent.create({ data: {
    requestId: execution.requestId, executionId: row.executionId,
    actorType: userId ? 'HUMAN' : 'SERVER', actorUserId: userId,
    eventType: 'execution.approval_decided',
    payload: { approvalId: row.id, executionId: row.executionId, toolName: row.toolName, detail: row.detail, reason: row.reason, status, decidedByUserId: userId },
  } });
  return { ...row, status, decidedAt: now, decidedByUserId: userId };
}

@Injectable()
export class ApprovalsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(deviceId: string, executionId: string, input: unknown) {
    const body = CreateApprovalSchema.parse(input);
    return this.prisma.$transaction(async (tx) => {
      const execution = await lockedExecution(tx, executionId);
      if (execution.agent.deviceId !== deviceId || execution.status !== 'RUNNING') throw new ForbiddenException();
      const snapshot = execution.agentCapabilitiesSnapshot as { policy?: { approval_mode?: string } } | null;
      if (snapshot?.policy?.approval_mode !== 'ask') throw new ForbiddenException('승인 대기 모드가 아닌 실행입니다.');
      const row = await tx.executionApproval.create({ data: {
        executionId, toolName: body.toolName, detail: truncateApprovalDetail(body.detail), reason: body.reason,
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
      } });
      await tx.timelineEvent.create({ data: {
        requestId: execution.requestId, executionId, agentId: execution.agentId, actorType: 'DESKTOP_AGENT',
        eventType: 'execution.approval_requested',
        payload: { approvalId: row.id, executionId, toolName: row.toolName, detail: row.detail, reason: row.reason, status: row.status, expiresAt: row.expiresAt.toISOString() },
      } });
      return { approvalId: row.id, expiresAt: row.expiresAt };
    });
  }

  async list(userId: string, executionId: string) {
    return this.prisma.$transaction(async (tx) => {
      const execution = await lockedExecution(tx, executionId);
      if (execution.executorUserId !== userId || execution.request.recipientUserId !== userId) {
        throw new ForbiddenException();
      }
      const rows = await tx.executionApproval.findMany({
        where: { executionId },
        orderBy: { createdAt: 'asc' },
      });
      const now = new Date();
      // 재접속해도 마감된 승인이 대기로 남지 않도록 데몬 폴링과 같은 잠금 아래 확정한다.
      const approvals = [];
      for (const row of rows) {
        approvals.push(
          row.status === 'PENDING' && (row.expiresAt <= now || execution.status !== 'RUNNING')
            ? await settle(tx, row, 'EXPIRED', null, now)
            : row,
        );
      }
      return approvals;
    });
  }

  private async resolve(id: string, principal: { deviceId: string } | { userId: string }, decision?: unknown) {
    const parsed = decision === undefined ? undefined : ApprovalDecisionSchema.parse(decision).decision;
    // REPEATABLE READ 스냅샷을 잠금 전에 만들지 않도록 ID 조회는 트랜잭션 밖에서 한다.
    const initial = await this.prisma.executionApproval.findUnique({ where: { id } });
    if (!initial) throw new NotFoundException();
    return this.prisma.$transaction(async (tx) => {
      const execution = await lockedExecution(tx, initial.executionId);
      if ('deviceId' in principal) {
        if (execution.agent.deviceId !== principal.deviceId) throw new ForbiddenException();
      } else if (execution.executorUserId !== principal.userId || execution.request.recipientUserId !== principal.userId) {
        // 요청자·팀 관리자도 확정 실행자를 대신해 타인의 컴퓨터에 권한을 줄 수 없다.
        throw new ForbiddenException();
      }
      // 첫 조회는 실행 ID를 얻기 위한 것뿐. 잠금을 얻은 뒤 최신 승인 상태를 읽는다.
      const row = await tx.executionApproval.findUniqueOrThrow({ where: { id } });
      const now = new Date();
      if (row.status === 'PENDING' && (row.expiresAt <= now || execution.status !== 'RUNNING')) {
        return { row: await settle(tx, row, 'EXPIRED', null, now), conflict: !!parsed };
      }
      if (!parsed) return { row, conflict: false };
      if (row.status !== 'PENDING') return { row, conflict: true };
      return { row: await settle(tx, row, parsed, 'userId' in principal ? principal.userId : null, now), conflict: false };
    });
  }

  async get(deviceId: string, id: string) {
    const { row } = await this.resolve(id, { deviceId });
    return { status: row.status, expiresAt: row.expiresAt };
  }

  async decide(userId: string, id: string, body: unknown) {
    const result = await this.resolve(id, { userId }, body);
    // 만료 저장을 롤백하지 않도록 트랜잭션이 커밋된 뒤 409를 반환한다.
    if (result.conflict) throw new ConflictException('이미 결정되었거나 마감된 승인입니다.');
    return { status: result.row.status };
  }
}
