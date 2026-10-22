import { expireExecutionApprovals } from '../approvals/approvals.service';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { getDesktopInbox } from './inbox';
import { canonicalAgent } from './agent-lifecycle';
import {
  AgentCapabilities,
  AgentHeartbeat,
  clampAgentCapabilities,
  RegisterAgent,
} from '@baton/shared';
import { PrismaService } from '../prisma.service';

@Injectable()
export class DesktopService {
  private readonly logger = new Logger(DesktopService.name);
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  private hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }
  /**
   * CLO-110(보안 검토 H-2-1): capability 는 데몬의 자기 선언이다. 서버 상한을 넘는 값은 저장 전에 깎는다.
   *
   * 스키마 검증만 하던 예전에는 CODEX 가 credentialPathDeny=true 를 한 번 보내면 그 Agent 의 실행에서
   * 승인 화면이 통째로 사라졌다. 이제 DB 에는 상한을 넘지 않는 값만 들어간다.
   * 상한을 넘긴 선언은 이상 징후이므로 provider·deviceId·필드 경로를 그대로 로그에 남긴다.
   */
  private clampCapabilities(
    provider: string,
    deviceId: string,
    capabilities: AgentCapabilities | undefined,
  ) {
    if (!capabilities) return undefined;
    const { capabilities: clamped, overDeclared } = clampAgentCapabilities(provider, capabilities);
    if (overDeclared.length)
      this.logger.warn(
        `capability 과대 선언을 서버 상한으로 깎았습니다. provider=${provider} deviceId=${deviceId} fields=${overDeclared.join(',')}`,
      );
    return clamped;
  }
  async device(authorization?: string) {
    const token = authorization?.replace(/^Bearer\s+/i, '');
    if (!token) throw new UnauthorizedException();
    const device = await this.prisma.device.findFirst({
      where: { revokedAt: null, tokenHash: this.hash(token) },
    });
    if (!device) throw new UnauthorizedException();
    await this.prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
    return device;
  }
  async inbox(authorization?: string) {
    const device = await this.device(authorization);
    return getDesktopInbox(this.prisma, device.userId);
  }
  async heartbeat(device: { id: string }, metadata: AgentHeartbeat) {
    const { agentId, capabilities, models, ...info } = metadata;
    const lastSeenAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      // provider 조회 전에 잠가 등록·capability 갱신과 같은 최신 스냅샷을 사용한다.
      await tx.$queryRaw`SELECT id FROM Device WHERE id = ${device.id} FOR UPDATE`;
      const reported = agentId
        ? await tx.agent.findFirst({ where: { id: agentId, deviceId: device.id } })
        : null;
      const canonical = await canonicalAgent(tx, device.id, reported?.provider);

      if (agentId && canonical?.id !== agentId)
        throw new ForbiddenException('이 디바이스의 활성 Agent만 보고할 수 있습니다.');
      await tx.device.update({ where: { id: device.id }, data: { ...info, lastSeenAt } });
      // 런타임 capability 갱신은 정상 경로다. 다만 provider 상한을 넘는 값은 저장하지 않는다.
      const clamped = agentId
        ? this.clampCapabilities(canonical!.provider, device.id, capabilities)
        : undefined;
      if (agentId)
        await tx.agent.update({
          where: { id: agentId },
          data: {
            lastSeenAt,
            ...(clamped ? { capabilities: clamped } : {}),
            // 모델 목록은 CLI 조회가 느려 등록 뒤 heartbeat 로 따라온다(설계 06).
            ...(models ? { models: models as unknown as Prisma.InputJsonValue } : {}),
            status: canonical!.status === 'BUSY' ? 'BUSY' : 'ONLINE',
          },
        });
    });
    return { ok: true, lastSeenAt };
  }
  async register(userId: string, name: string) {
    const token = randomBytes(32).toString('base64url');
    const device = await this.prisma.device.create({
      data: { userId, name, tokenHash: this.hash(token) },
    });
    return { deviceId: device.id, deviceToken: token };
  }
  async agent(deviceId: string, agentId: string) {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    const agent = device
      ? await this.prisma.agent.findFirst({
          where: { id: agentId, ownerUserId: device.userId, deviceId },
        })
      : null;
    if (!agent) throw new ForbiddenException();
    return agent;
  }
  async registerAgent(device: { id: string; userId: string }, body: RegisterAgent) {
    const capabilities = this.clampCapabilities(body.provider, device.id, body.capabilities);
    return this.prisma.$transaction(async (tx) => {
      const existing = await canonicalAgent(tx, device.id, body.provider);
      if (existing) {
        if (capabilities || body.models)
          await tx.agent.update({
            where: { id: existing.id },
            data: {
              ...(capabilities ? { capabilities } : {}),
              ...(body.models ? { models: body.models as unknown as Prisma.InputJsonValue } : {}),
            },
          });
        return { agentId: existing.id };
      }
      const agent = await tx.agent.create({
        data: {
          ownerUserId: device.userId,
          deviceId: device.id,
          provider: body.provider,
          capabilities,
          ...(body.models ? { models: body.models as unknown as Prisma.InputJsonValue } : {}),
          displayName:
            body.displayName ||
            { CLAUDE_CODE: 'Claude Code', CODEX: 'Codex', AGY: 'Antigravity' }[body.provider],
          status: 'ONLINE',
          lastSeenAt: new Date(),
        },
      });
      return { agentId: agent.id };
    });
  }
  async presence(device: { id: string }, agentId: string, status: string) {
    if (!['ONLINE', 'BUSY', 'OFFLINE'].includes(status))
      throw new ConflictException('유효하지 않은 Agent 상태입니다.');
    const agent = await this.agent(device.id, agentId);
    if (agent.status === 'DISABLED') throw new ForbiddenException('비활성 Agent입니다.');
    // 재-pairing은 Device ID를 유지하므로 다른 디바이스의 Agent를 재바인딩하지 않는다.
    const changed = await this.prisma.agent.updateMany({
      where: { id: agentId, status: { not: 'DISABLED' } },
      data: { status: status as 'ONLINE' | 'BUSY' | 'OFFLINE', lastSeenAt: new Date() },
    });
    if (!changed.count) throw new ForbiddenException('비활성 Agent입니다.');
    return { ok: true };
  }
  async registerProject(device: { id: string; userId: string }, body: any) {
    const agent = await this.agent(device.id, body.agentId);
    if (agent.status === 'DISABLED') throw new ForbiddenException('비활성 Agent입니다.');
    // 같은 에이전트의 같은 경로는 하나여야 한다. 무조건 create 하면 데몬이 재등록할 때마다
    // 행이 쌓이고, 실행 준비 화면의 프로젝트 목록에 같은 항목이 여러 번 나온다
    // (2026-09-18: 같은 경로가 3개까지 늘어나 있었다).
    const path = body.localPathHint || null;
    if (path) {
      const existing = await this.prisma.project.findFirst({
        where: { agentId: body.agentId, localPathHint: path, status: 'ACTIVE' },
      });
      if (existing) {
        if (body.displayName && body.displayName !== existing.displayName)
          await this.prisma.project.update({
            where: { id: existing.id },
            data: { displayName: body.displayName },
          });
        return { projectId: existing.id };
      }
    }
    const project = await this.prisma.project.create({
      data: {
        ownerUserId: device.userId,
        agentId: body.agentId,
        // 이름이 없으면 경로의 마지막 폴더명을 쓴다. 'Baton project' 로 뭉뚱그리면
        // 프로젝트가 여러 개일 때 화면에서 구분이 안 된다 (전수조사 결함 12).
        displayName: body.displayName || path?.split('/').filter(Boolean).pop() || 'Baton project',
        localPathHint: path,
      },
    });
    return { projectId: project.id };
  }
  async status(
    deviceId: string,
    executionId: string,
    body: { status: 'RUNNING' | 'PROGRESS'; phase?: string; message?: string; sessionId?: string },
  ) {
    const execution = await this.prisma.execution.findUnique({
      where: { id: executionId },
      include: { request: true },
    });
    if (!execution) throw new NotFoundException();
    await this.agent(deviceId, execution.agentId);
    if (body.status === 'RUNNING') {
      if (execution.request.state !== 'READY_TO_RUN')
        throw new ConflictException('READY_TO_RUN 상태에서만 시작할 수 있습니다.');
      return this.prisma.$transaction(async (tx) => {
        const changed = await tx.execution.updateMany({
          where: { id: executionId, status: 'QUEUED' },
          data: { status: 'RUNNING', startedAt: new Date(), claudeSessionId: body.sessionId },
        });
        if (!changed.count) throw new ConflictException('이미 시작되거나 취소된 실행입니다.');
        await tx.request.update({ where: { id: execution.requestId }, data: { state: 'RUNNING' } });
        await tx.agent.updateMany({
          where: { id: execution.agentId, status: { not: 'DISABLED' } },
          data: { status: 'BUSY', lastSeenAt: new Date() },
        });
        await tx.timelineEvent.create({
          data: {
            requestId: execution.requestId,
            executionId,
            actorType: 'DESKTOP_AGENT',
            agentId: execution.agentId,
            eventType: 'execution.started',
            payload: { message: body.message, sessionId: body.sessionId },
          },
        });
        return { ok: true };
      });
    }
    if (execution.status !== 'RUNNING' || execution.request.state !== 'RUNNING')
      throw new ConflictException('RUNNING 상태에서만 진행 상황을 보고할 수 있습니다.');
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.execution.updateMany({
        where: { id: executionId, status: 'RUNNING' },
        data: { claudeSessionId: body.sessionId, status: 'RUNNING' },
      });
      if (!changed.count) throw new ConflictException('이미 종료된 실행입니다.');
      await tx.timelineEvent.create({
        data: {
          requestId: execution.requestId,
          executionId,
          actorType: 'DESKTOP_AGENT',
          agentId: execution.agentId,
          eventType: 'execution.progress_reported',
          payload: { phase: body.phase, message: body.message },
        },
      });
    });
    return { ok: true };
  }
  async result(deviceId: string, executionId: string, body: any) {
    const execution = await this.prisma.execution.findUnique({
      where: { id: executionId },
      include: { request: true },
    });
    if (!execution) throw new NotFoundException();
    await this.agent(deviceId, execution.agentId);
    if (body.status === 'CANCELLED') {
      return this.prisma.$transaction(async (tx) => {
        // Result.executionId unique를 유지하며 취소 회차의 스냅샷만 보관한다. 승인 가능한 FINAL과 구분한다.
        const locked = await tx.execution.updateMany({
          where: { id: executionId, status: 'CANCELLED' },
          data: { status: 'CANCELLED' },
        });
        if (!locked.count) throw new ConflictException('취소 API 완료 후 부분 결과를 보고하세요.');
        const artifactIds = [...new Set<string>(body.artifactIds ?? [])];
        const count = await tx.artifact.count({
          where: {
            id: { in: artifactIds },
            requestId: execution.requestId,
            ownerUserId: execution.executorUserId,
          },
        });
        if (count !== artifactIds.length)
          throw new ForbiddenException('해당 요청에 업로드한 본인 산출물만 첨부할 수 있습니다.');
        const data = {
          kind: 'PARTIAL' as const,
          summary: body.summary,
          changedFiles: body.changedFiles,
          artifactIds,
        };
        const result = await tx.result.upsert({
          where: { executionId },
          create: { executionId, ...data },
          update: data,
        });
        await tx.timelineEvent.create({
          data: {
            requestId: execution.requestId,
            executionId,
            actorType: 'DESKTOP_AGENT',
            agentId: execution.agentId,
            eventType: 'result.partial_reported',
            payload: { resultId: result.id },
          },
        });
        return result;
      });
    }
    if (execution.status !== 'RUNNING' || execution.request.state !== 'RUNNING')
      throw new ConflictException('RUNNING 상태에서만 결과를 보고할 수 있습니다.');
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const changed = await tx.execution.updateMany({
        where: { id: executionId, status: 'RUNNING' },
        data: { status: body.status === 'FAILED' ? 'FAILED' : 'SUCCEEDED', finishedAt: now },
      });
      if (!changed.count) throw new ConflictException('이미 종료되거나 취소된 실행입니다.');
      await expireExecutionApprovals(tx, executionId, now);
      if (body.status === 'FAILED') {
        await tx.execution.update({
          where: { id: executionId },
          data: {
            status: 'FAILED',
            finishedAt: now,
            failureReason: body.failureReason,
            failureCode: body.failureCode ?? null,
          },
        });
        await tx.request.update({ where: { id: execution.requestId }, data: { state: 'FAILED' } });
        await tx.agent.updateMany({
          where: { id: execution.agentId, status: { not: 'DISABLED' } },
          data: { status: 'ONLINE' },
        });
        await tx.timelineEvent.create({
          data: {
            requestId: execution.requestId,
            executionId,
            actorType: 'DESKTOP_AGENT',
            agentId: execution.agentId,
            eventType: 'execution.failed',
            payload: {
              reason: body.failureReason,
              ...(body.failureCode ? { failureCode: body.failureCode } : {}),
            },
          },
        });
        // 데몬의 독립 검증 거부는 일반 실패와 별도로 감사한다. 보고 내용은
        // 디바이스의 관측값이며 서버 capability/승인 기록을 덮어쓰지 않는다.
        let mismatch: unknown;
        try {
          mismatch = JSON.parse(body.failureReason ?? '');
        } catch {
          mismatch = null;
        }
        if (
          mismatch &&
          typeof mismatch === 'object' &&
          'code' in mismatch &&
          mismatch.code === 'execution.capability_mismatch'
        ) {
          await tx.timelineEvent.create({
            data: {
              requestId: execution.requestId,
              executionId,
              actorType: 'DESKTOP_AGENT',
              agentId: execution.agentId,
              eventType: 'execution.capability_mismatch',
              payload: mismatch as Prisma.InputJsonValue,
            },
          });
        }
        return { ok: true };
      }
      const result = await tx.result.create({
        data: {
          executionId,
          summary: body.summary,
          changedFiles: body.changedFiles,
          testSummary: body.testSummary,
          resultDocumentVersionId: body.resultDocumentVersionId,
          artifactIds: body.artifactIds,
        },
      });
      await tx.execution.update({
        where: { id: executionId },
        data: { status: 'SUCCEEDED', finishedAt: now },
      });
      await tx.request.update({
        where: { id: execution.requestId },
        data: { state: 'RESULT_REVIEW' },
      });
      await tx.agent.updateMany({
        where: { id: execution.agentId, status: { not: 'DISABLED' } },
        data: { status: 'ONLINE' },
      });
      await tx.timelineEvent.createMany({
        data: [
          {
            requestId: execution.requestId,
            executionId,
            actorType: 'DESKTOP_AGENT',
            agentId: execution.agentId,
            eventType: 'execution.finished',
            payload: {},
          },
          {
            requestId: execution.requestId,
            executionId,
            actorType: 'SERVER',
            eventType: 'result.created',
            payload: { resultId: result.id },
          },
        ],
      });
      return result;
    });
  }
}
