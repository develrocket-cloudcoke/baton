import { expireExecutionApprovals } from '../approvals/approvals.service';
import {
  acknowledgementMatches,
  AgentCapabilitiesSchema,
  clampAgentCapabilities,
  effectiveAgentCapabilities,
  ExecutionPolicySchema,
  executionApprovalProtections,
  UnenforceableProtectionSchema,
  type ExecutionCapabilitySnapshot,
  type UnenforceableProtection,
} from '@baton/shared';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Inject,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { assertRecipient, isOrgAdmin, isTeamRecipient } from '../requests/request-access';
import { redactExecutionForSender } from '../requests/sender-projection';
import { outboxEvents, webUrlBase } from '../desktop/outbox-events';
import { senderDisplayName } from '../common/sender-name';
import { recordChildCompleted } from '../requests/requests.service';

/** CLO-20: 하위 요청을 실행할 때 에이전트에게 넘기는 상위 요청 맥락(생성 시점 스냅샷). */
function formatParentContext(context: unknown): string {
  const c = (context && typeof context === 'object' ? context : {}) as {
    parentTitle?: string; parentInstruction?: string; parentResults?: Array<{ revisionNo?: number; summary?: string }>;
  };
  const lines = ['[상위 요청 맥락] 이 요청은 다른 팀이 진행 중인 요청을 돕기 위해 만들어졌습니다.', `상위 요청 제목: ${c.parentTitle ?? ''}`, '상위 요청 지시:', c.parentInstruction ?? ''];
  for (const r of c.parentResults ?? []) lines.push(`상위 요청 ${r.revisionNo ?? '?'}차 결과 요약: ${r.summary ?? ''}`);
  return lines.join('\n');
}

/**
 * CLO-108: 강제할 수 없는 보호가 승인되지 않았을 때의 409 본문.
 * 웹이 이 목록을 그대로 화면에 열거하고, 사용자가 고른 키를 acknowledgedRisks 로 되돌려 보낸다.
 */
function riskAcknowledgementRequired(
  protections: UnenforceableProtection[],
  acknowledged: string[],
) {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'execution.unenforceable_protections',
    message: protections.length
      ? '선택한 정책의 외부 작업 위험 또는 이 Agent가 강제할 수 없는 보호가 있습니다. 아래 항목을 모두 확인하고 acknowledgedRisks에 항목 키를 정확히 담아 다시 요청하십시오.'
      : '이 실행에는 승인이 필요한 항목이 없습니다. acknowledgedRisks를 비워서 다시 요청하십시오.',
    unenforceableProtections: protections,
    requiredAcknowledgements: protections.map((item) => item.key),
    acknowledgedRisks: acknowledged,
  });
}

@Injectable()
export class ExecutionsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private async requestForRecipient(requestId: string, userId: string) {
    const request = await this.prisma.request.findUnique({
      where: { id: requestId },
      include: { revisions: true },
    });
    if (!request) throw new NotFoundException('요청을 찾을 수 없습니다.');
    await assertRecipient(this.prisma, request, userId);
    if (request.recipientUserId !== userId) throw new ForbiddenException();
    return request;
  }

  async create(
    userId: string,
    requestId: string,
    body: {
      agentId: string;
      projectId: string;
      additionalInstruction: string;
      followUpInstruction?: string;
      model?: string | null;
      policy?: Partial<Record<string, string>>;
      acknowledgedRisks?: string[];
    },
  ) {
    const request = await this.requestForRecipient(requestId, userId);
    const sender = await this.prisma.user.findUnique({ where: { id: request.senderUserId } });
    if (!['ACCEPTED', 'FAILED', 'READY_TO_RUN', 'RESULT_REVIEW'].includes(request.state))
      throw new ConflictException('실행할 수 없는 요청 상태입니다.');
    const followUp = request.state === 'RESULT_REVIEW';
    const instruction = body.followUpInstruction ?? body.additionalInstruction;
    if (followUp && !instruction.trim())
      throw new BadRequestException('추가 작업 지시가 필요합니다.');
    if (!followUp && body.followUpInstruction)
      throw new ConflictException('결과 검토 상태에서만 추가 작업을 요청할 수 있습니다.');
    const [agent, project] = await Promise.all([
      this.prisma.agent.findFirst({
        where: { id: body.agentId, ownerUserId: userId, status: { not: 'DISABLED' } },
      }),
      this.prisma.project.findFirst({
        where: { id: body.projectId, ownerUserId: userId, agentId: body.agentId, status: 'ACTIVE' },
      }),
    ]);
    if (!agent || !project)
      throw new ForbiddenException('자신의 활성 Agent와 Project만 선택할 수 있습니다.');
    const revision = request.revisions.find((item) => item.id === request.currentRevisionId);
    if (!revision) throw new ConflictException('현재 revision이 없습니다.');
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM Device WHERE id = ${agent.deviceId} FOR UPDATE`;
      const enabled = await tx.agent.findFirst({
        where: { id: agent.id, status: { not: 'DISABLED' } },
      });
      if (!enabled) throw new ForbiddenException('비활성 Agent입니다.');
      const capabilities = effectiveAgentCapabilities(enabled.provider, enabled.capabilities);
      // 데몬이 보낸 원본 선언과 서버 상한으로 깎은 값의 차이를 스냅샷에 남긴다(CLO-110 H-2-1·M-6-1).
      const declared = AgentCapabilitiesSchema.safeParse(enabled.capabilities);
      const overDeclared = declared.success
        ? clampAgentCapabilities(enabled.provider, declared.data).overDeclared
        : [];
      // resume 은 같은 Agent·Project 일 때만 가능하다. 다른 에이전트로 넘기는 경우는
      // 세션을 이어갈 수 없으므로 새 세션에 원본 + 이전 결과를 다시 실어 보낸다.
      const previousForResume = await tx.execution.findFirst({
        where: { requestId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const sameTarget =
        !!previousForResume &&
        previousForResume.agentId === agent.id &&
        previousForResume.projectId === project.id;
      const nextRevision = !!previousForResume && previousForResume.requestRevisionId !== revision.id;
      // 제공자 세션은 로컬 프로젝트·실행자에 귀속된다. 다른 사람/프로젝트에는 넘기지 않는다.
      const resuming = (followUp || (nextRevision && capabilities.supportsResume)) && sameTarget &&
        previousForResume?.executorUserId === userId;
      const history = nextRevision ? await tx.execution.findMany({
        where: { requestId, requestRevisionId: { not: revision.id } },
        include: { result: true, requestRevision: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }) : [];
      const previousWork = history.map((e) => {
        const outcome = e.status === 'FAILED' ? `실패: ${e.failureReason ?? '실패 사유 없음'}`
          : e.result?.reviewStatus === 'APPROVED' ? `승인·전달된 결과: ${e.result.summary}`
          : '승인·전달된 결과 없음';
        return `${e.requestRevision.revisionNo}차 지시: ${e.requestRevision.originalInstruction}\n${outcome}`;
      }).join('\n\n');
      const completedChildren = await tx.request.findMany({
        where: { parentRequestId: requestId, state: 'COMPLETED' },
        include: { recipientTeam: { select: { name: true } }, executions: { include: { result: true } } },
      });
      const childWork = completedChildren.map((child) => {
        const summary = child.executions.flatMap((item) => item.result?.reviewStatus === 'APPROVED' ? [item.result.summary] : []).at(-1);
        return summary ? `하위 요청 (${child.recipientTeam.name}) 승인 결과: ${summary}` : null;
      }).filter(Boolean).join('\n\n');
      const completePreviousWork = [previousWork, childWork].filter(Boolean).join('\n\n');
      if (resuming && !capabilities.supportsResume)
        throw new ConflictException(
          '이 Agent는 세션 이어가기(supportsResume)를 지원하지 않아 추가 작업을 요청할 수 없습니다.',
        );
      const policy = ExecutionPolicySchema.parse(body.policy ?? {});
      // CLO-108(설계 06 §5.4 선택지 B): 강제할 수 없는 보호를 조용히 막지 않는다.
      // 요청한 정책과 기본 안전 기준이 요구하는 보호 중 이 Agent 가 못 막는 것을 전부 세어
      // 사람에게 항목으로 보여 주고, 그 키가 정확히 다 승인되었을 때만 실행한다.
      const previous = await tx.execution.findFirst({
        where: { requestId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      // 보안 검토 M-3: 세션에는 이전에 읽은 정보가 남는다. 현재 보호가 강해져도
      // 이전 위험 전문을 최소 승인 집합에 합쳐 이번 실행에서 다시 승인받는다.
      //
      // **이어가기(resume)일 때만이다.** 다른 에이전트로 넘기면 세션이 새로 시작해
      // 남은 정보가 없고, 데몬 게이트도 resumeSessionId 가 있을 때만 inherited 를
      // 센다. 여기서만 합치면 서버가 승인한 집합이 데몬이 계산한 집합보다 커져
      // 능력 불일치로 실행이 통째로 실패한다 (2026-09-21: 다른 모델로 추가 작업을
      // 넘길 때마다 재현).
      const inherited =
        resuming && previous?.claudeSessionId
          ? UnenforceableProtectionSchema.array().parse(previous.acknowledgedRisks ?? [])
          : [];
      const protections = executionApprovalProtections(capabilities, policy, inherited);
      const acknowledged = body.acknowledgedRisks ?? [];
      if (
        !acknowledgementMatches(
          protections.map((item) => item.key),
          acknowledged,
        )
      )
        throw riskAcknowledgementRequired(protections, acknowledged);
      // CLO-110(보안 검토 M-6-1): 승인 항목이 0 건이어도 실행 시점의 capability 를 통째로 남긴다.
      // 나중에 capability 가 바뀌어도 "그때 서버가 무엇을 근거로 이 승인 목록을 냈는가"를 읽을 수 있다.
      const capabilitiesSnapshot: ExecutionCapabilitySnapshot = {
        agentId: agent.id,
        agentProvider: enabled.provider,
        securityTier: capabilities.securityTier,
        capabilities,
        declaredCapabilities: (enabled.capabilities as unknown) ?? null,
        overDeclaredCapabilities: overDeclared,
        unenforceableProtectionKeys: protections.map((item) => item.key),
        policy,
        capturedAt: new Date().toISOString(),
      };
      // 프로젝트와 요청을 잠가 중복 실행 및 결과 승인과 추가 작업의 경합을 직렬화한다.
      const lockedProject = await tx.project.updateMany({
        where: { id: project.id, ownerUserId: userId, agentId: agent.id, status: 'ACTIVE' },
        data: { status: 'ACTIVE' },
      });
      if (!lockedProject.count) throw new ForbiddenException('프로젝트 상태가 변경되었습니다.');
      const changed = await tx.request.updateMany({
        where: { id: requestId, state: request.state, recipientUserId: userId, currentRevisionId: revision.id },
        data: { state: 'READY_TO_RUN' },
      });
      if (!changed.count) throw new ConflictException('요청 상태가 변경되었습니다.');
      const active = await tx.execution.findFirst({
        where: {
          OR: [{ projectId: project.id }, { requestId }],
          status: { in: ['QUEUED', 'RUNNING'] },
        },
      });
      if (active) throw new ConflictException('이미 실행 중인 요청 또는 프로젝트입니다.');

      if (followUp && (!previous || previous.status !== 'SUCCEEDED'))
        throw new ConflictException('추가 작업을 요청할 결과가 없습니다.');
      // 다른 에이전트로 넘기는 것을 허용한다 — 결과가 마음에 들지 않을 때 두 번째 의견을
      // 받는 경로다. 대신 세션을 못 이어가므로 아래에서 원본과 이전 결과를 함께 싣는다.
      const execution = await tx.execution.create({
        data: {
          requestId,
          requestRevisionId: revision.id,
          executorUserId: userId,
          agentId: agent.id,
          projectId: project.id,
          additionalInstruction: followUp ? instruction : body.additionalInstruction,
          model: body.model?.trim() || null,
          effectiveInstructionRef: `request-revision:${revision.id}`,
          previousExecutionId: followUp || request.state === 'FAILED' ? previous?.id : null,
          // 승인한 항목의 전문을 함께 남긴다. 나중에 capability 가 바뀌어도 그때 무엇을 승인했는지 읽을 수 있다.
          acknowledgedRisks: protections.length ? protections : undefined,
          riskAcknowledgedAt: protections.length ? new Date() : undefined,
          riskAcknowledgedByUserId: protections.length ? userId : undefined,
          // 승인 항목이 0 건인 실행에도 남긴다 — 위 세 필드가 전부 null 인 이유를 이 스냅샷이 설명한다.
          agentCapabilitiesSnapshot: capabilitiesSnapshot as unknown as Prisma.InputJsonValue,
        },
      });
      // 다른 에이전트로 넘기는 추가 작업이면 세션을 이어갈 수 없다. 이전 에이전트가 쓴
      // result.md 를 첨부로 함께 실어 "무엇을 이미 해봤는지" 를 알고 시작하게 한다.
      const carriedResult =
        followUp && !resuming && previousForResume
          ? await tx.result.findUnique({ where: { executionId: previousForResume.id } })
          : null;
      const carriedArtifacts = carriedResult
        ? await tx.artifact.findMany({
            where: {
              id: { in: (carriedResult.artifactIds as string[]) ?? [] },
              kind: 'RESULT_ATTACHMENT',
            },
          })
        : [];
      const [documentVersions, artifacts] = await Promise.all([
        tx.documentVersion.findMany({
          where: { id: { in: revision.documentVersionIds as string[] } },
          include: { document: true },
        }),
        tx.artifact.findMany({ where: { id: { in: revision.artifactIds as string[] } } }),
      ]);
      const payload = {
        eventName: 'execution.command.requested' as const,
        eventId: execution.id,
        executionId: execution.id,
        requestId,
        requestRevisionId: revision.id,
        agentId: agent.id,
        // 데몬은 설치된 provider 마다 Agent 를 따로 등록한다(04 §11.1.1). 어느 어댑터로
        // 돌릴지는 이 값으로 정해진다. 빠뜨리면 데몬이 추측해야 하고, 다른 provider 를
        // 고른 실행이 "Agent 와 명령이 일치하지 않습니다" 로 실패한다 (2026-09-21).
        provider: enabled.provider,
        projectId: project.id,
        teamId: request.senderTeamId,
        title: request.title,
        senderName: senderDisplayName(sender),
        webUrl: `${webUrlBase()}/requests/${requestId}`,
        originalInstruction: request.parentContext
          ? `${formatParentContext(request.parentContext)}\n\n[이 요청에서 부탁하는 것]\n${revision.originalInstruction}`
          : revision.originalInstruction,
        ...(nextRevision || childWork ? { previousWork: completePreviousWork, ...(nextRevision ? { resumeSessionId: resuming ? previousForResume?.claudeSessionId : null } : {}) } : {}),
        additionalInstruction: followUp ? instruction : body.additionalInstruction,
        model: execution.model,
        ...(followUp
          ? {
              followUpInstruction: instruction,
              // 같은 Agent·Project 일 때만 세션을 이어간다. 다른 에이전트면 null 이고,
              // 러너가 원본 맥락을 새 세션에 다시 싣는다.
              resumeSessionId: resuming ? (previousForResume?.claudeSessionId ?? null) : null,
            }
          : {}),
        attachments: [
          ...documentVersions.map((version) => ({
            id: version.id,
            filename: version.document.name,
            mimeType: version.document.mimeType,
            downloadUrl: `/v1/documents/versions/${version.id}/download`,
            sha256: version.contentSha256,
            kind: 'document' as const,
          })),
          ...artifacts.map((artifact) => ({
            id: artifact.id,
            filename: artifact.filename,
            mimeType: artifact.mimeType,
            downloadUrl: `/v1/artifacts/${artifact.id}`,
            sha256: artifact.sha256,
            kind: 'attachment' as const,
          })),
          ...carriedArtifacts.map((artifact) => ({
            id: artifact.id,
            // 원본 요청의 첨부와 구분되게 이름을 붙인다 (프롬프트에 그대로 나타난다).
            filename: `이전-시도-결과-${artifact.filename}`,
            mimeType: artifact.mimeType,
            downloadUrl: `/v1/artifacts/${artifact.id}`,
            sha256: artifact.sha256,
            kind: 'attachment' as const,
          })),
        ],
        // F4: 실행 준비 화면에서 고른 policy 를 기본값 위에 덮어쓴다.
        // 게이트가 평가한 값과 데몬이 받는 값이 어긋나지 않도록 같은 객체를 쓴다.
        policy,
        // CLO-108: 데몬 러너에 승인된 위험 항목 키 배열 전달
        acknowledgedRisks: protections.map((item) => item.key),
        inheritedRiskKeys: inherited.map((item) => item.key),
      };
      if (protections.length)
        await tx.timelineEvent.create({
          data: {
            requestId,
            requestRevisionId: revision.id,
            executionId: execution.id,
            actorType: 'HUMAN',
            actorUserId: userId,
            eventType: 'execution.risk_acknowledged',
            payload: {
              acknowledgedRisks: protections.map((item) => item.key),
              protections,
              agentProvider: enabled.provider,
              securityTier: capabilities.securityTier,
              // 목록을 계산한 근거를 이벤트에도 같이 남긴다(CLO-110 M-6-1).
              capabilities,
            },
          },
        });
      if (followUp)
        await tx.timelineEvent.create({
          data: {
            requestId,
            requestRevisionId: revision.id,
            executionId: execution.id,
            actorType: 'HUMAN',
            actorUserId: userId,
            eventType: 'execution.follow_up_requested',
            payload: {
              previousExecutionId: previous!.id,
              followUpInstruction: instruction,
              // 이어가기인지, 다른 에이전트로 넘긴 것인지 나중에 구분할 수 있어야 한다.
              resumeSessionId: resuming ? previous!.claudeSessionId : null,
              switchedAgent: !sameTarget,
              model: execution.model,
              carriedPreviousResult: carriedArtifacts.length > 0,
            },
          },
        });
      await tx.timelineEvent.createMany({
        data: [
          {
            requestId,
            requestRevisionId: revision.id,
            executionId: execution.id,
            actorType: 'HUMAN',
            actorUserId: userId,
            eventType: 'request.ready_to_run',
            payload: {},
          },
          {
            requestId,
            requestRevisionId: revision.id,
            executionId: execution.id,
            actorType: 'SERVER',
            eventType: 'execution.queued',
            payload: {},
          },
          {
            requestId,
            requestRevisionId: revision.id,
            executionId: execution.id,
            actorType: 'SERVER',
            eventType: 'execution.command_requested',
            payload,
          },
        ],
      });
      const outbox = await tx.outboxEvent.create({
        data: {
          deviceId: agent.deviceId,
          executionId: execution.id,
          eventName: 'execution.command.requested',
          payload,
        },
      });
      return { execution, outbox };
    });
    outboxEvents.emit('created', created.outbox);
    return created.execution;
  }

  async cancel(userId: string, id: string) {
    const execution = await this.prisma.execution.findUnique({
      where: { id },
      include: { request: true, agent: true },
    });
    if (!execution) throw new NotFoundException();
    await assertRecipient(this.prisma, execution.request, userId);
    if (execution.executorUserId !== userId) throw new ForbiddenException();
    if (
      !effectiveAgentCapabilities(execution.agent.provider, execution.agent.capabilities)
        .supportsCancel
    )
      throw new ConflictException('이 Agent는 안전한 취소(supportsCancel)를 지원하지 않습니다.');
    const result = await this.prisma.$transaction(async (tx) => {
      // create()·canonicalAgent()와 같은 순서로 Device를 먼저 잠근다.
      // Agent를 먼저 잠그고 OutboxEvent INSERT의 FK로 Device를 나중에 잠그면
      // Device→Agent 순서로 잠그는 GET /v1/agents와 데드락이 난다 (CLO-108 e2e에서 실측).
      await tx.$queryRaw`SELECT id FROM Device WHERE id = ${execution.agent.deviceId} FOR UPDATE`;
      // 상태 보고와 같은 행을 먼저 잠가 취소 뒤 늦은 결과가 실행을 되살리지 못하게 한다.
      const changed = await tx.execution.updateMany({
        where: { id, status: { in: ['QUEUED', 'RUNNING'] } },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      });
      if (!changed.count) throw new ConflictException('종료된 실행은 취소할 수 없습니다.');
      await expireExecutionApprovals(tx, id);
      await tx.request.update({
        where: { id: execution.requestId },
        data: { state: 'READY_TO_RUN' },
      });
      await tx.agent.updateMany({
        where: { id: execution.agentId, status: 'BUSY' },
        data: { status: 'ONLINE' },
      });
      const payload = {
        eventName: 'execution.command.cancel_requested',
        executionId: id,
        requestId: execution.requestId,
      };
      await tx.timelineEvent.createMany({
        data: [
          {
            requestId: execution.requestId,
            executionId: id,
            actorType: 'HUMAN',
            actorUserId: userId,
            eventType: 'execution.cancelled',
            payload: {},
          },
          {
            requestId: execution.requestId,
            executionId: id,
            actorType: 'HUMAN',
            actorUserId: userId,
            eventType: 'execution.command.cancel_requested',
            payload,
          },
          {
            requestId: execution.requestId,
            executionId: id,
            actorType: 'HUMAN',
            actorUserId: userId,
            eventType: 'request.ready_to_run',
            payload: { reason: 'execution.cancelled' },
          },
        ],
      });
      const outbox = await tx.outboxEvent.create({
        data: {
          deviceId: execution.agent.deviceId,
          executionId: id,
          eventName: payload.eventName,
          payload,
        },
      });
      return { outbox, execution: await tx.execution.findUniqueOrThrow({ where: { id } }) };
    });
    outboxEvents.emit('created', result.outbox);
    return result.execution;
  }

  async approve(userId: string, resultId: string) {
    const result = await this.prisma.result.findUnique({
      where: { id: resultId },
      include: { execution: { include: { request: true } } },
    });
    if (!result) throw new NotFoundException();
    await assertRecipient(this.prisma, result.execution.request, userId);
    if (result.execution.request.recipientUserId !== userId) throw new ForbiddenException();
    if (
      result.kind === 'PARTIAL' ||
      result.execution.request.state !== 'RESULT_REVIEW' ||
      result.reviewStatus !== 'PENDING'
    )
      throw new ConflictException('승인할 수 없는 결과 상태입니다.');
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const changed = await tx.request.updateMany({
        where: { id: result.execution.requestId, state: 'RESULT_REVIEW', recipientUserId: userId },
        data: { state: 'COMPLETED', completedAt: now },
      });
      if (!changed.count) throw new ConflictException('요청 상태가 변경되었습니다.');
      const latest = await tx.execution.findFirst({
        where: { requestId: result.execution.requestId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      if (latest?.id !== result.executionId)
        throw new ConflictException('최신 실행의 결과만 승인할 수 있습니다.');
      const updated = await tx.result.update({
        where: { id: resultId },
        data: { reviewStatus: 'APPROVED', reviewedByUserId: userId, reviewedAt: now, sentAt: now },
      });
      await tx.request.update({
        where: { id: result.execution.requestId },
        data: { state: 'COMPLETED', completedAt: now },
      });
      if (result.execution.request.parentRequestId) await recordChildCompleted(tx, result.execution.request.parentRequestId, result.execution.request.id, resultId);
      await tx.timelineEvent.createMany({
        data: [
          {
            requestId: result.execution.requestId,
            executionId: result.executionId,
            actorType: 'HUMAN',
            actorUserId: userId,
            eventType: 'result.approved',
            payload: { resultId },
          },
          {
            requestId: result.execution.requestId,
            executionId: result.executionId,
            actorType: 'HUMAN',
            actorUserId: userId,
            eventType: 'result.sent',
            payload: { resultId },
          },
          {
            requestId: result.execution.requestId,
            executionId: result.executionId,
            actorType: 'HUMAN',
            actorUserId: userId,
            eventType: 'request.completed',
            payload: {},
          },
        ],
      });
      return updated;
    });
  }

  async get(userId: string, id: string) {
    const execution = await this.prisma.execution.findUnique({
      where: { id },
      include: { request: true, result: true, agent: true },
    });
    if (!execution) throw new NotFoundException();

    const isSender = execution.request.senderUserId === userId;
    const isRecipient =
      execution.request.recipientUserId === userId || execution.executorUserId === userId;
    const isTeam = await isTeamRecipient(this.prisma, execution.request, userId);
    const isAdmin = await isOrgAdmin(this.prisma, execution.request, userId);

    if (!isSender && !isRecipient && !isTeam && !isAdmin) {
      throw new ForbiddenException();
    }
    // CLO-110(H-1): 발신자에게는 수신자의 provider·securityTier·capability 전문·승인 내역·비공개 지시를 내보내지 않는다.
    const senderOnly = isSender && !isRecipient && !isTeam && !isAdmin;
    const visible = senderOnly ? redactExecutionForSender(execution) : execution;
    if (execution.executorUserId !== userId || execution.request.recipientUserId !== userId)
      return visible;
    const approvals = await this.prisma.executionApproval.findMany({
      where: { executionId: id },
      orderBy: { createdAt: 'asc' },
    });
    return { ...visible, approvals };
  }
}
