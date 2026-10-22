import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { RequestState, TimelineEventType, TransitionActor, canTransition } from '@baton/shared';
import { PrismaService } from './prisma.service';
import { recordChildCompleted } from './requests/requests.service';

@Injectable()
export class BatonService {
  constructor(@Inject(PrismaService) private prisma: PrismaService) {}
  private guard(from: RequestState, to: RequestState, actor: TransitionActor) {
    if (!canTransition(from, to, actor)) throw new ConflictException('유효하지 않은 상태 전이');
  }
  private async get(id: string) {
    const value = await this.prisma.request.findUnique({
      where: { id },
      include: { revisions: true },
    });
    if (!value) throw new NotFoundException();
    return value;
  }
  async create(userId: string, body: any) {
    const revisionId = randomUUID();
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.request.create({
        data: {
          senderTeamId: body.senderTeamId,
          recipientTeamId: body.recipientTeamId,
          senderUserId: userId,
          recipientUserId: body.recipientUserId,
          title: body.title,
          currentRevisionId: revisionId,
        },
      });
      await tx.requestRevision.create({
        data: {
          id: revisionId,
          requestId: request.id,
          revisionNo: 1,
          originalInstruction: body.originalInstruction,
          documentVersionIds: [],
          artifactIds: [],
          createdByUserId: userId,
        },
      });
      await tx.timelineEvent.create({
        data: {
          requestId: request.id,
          actorType: 'HUMAN',
          actorUserId: userId,
          eventType: TimelineEventType.REQUEST_CREATED,
          payload: {},
        },
      });
      return request;
    });
  }
  async list(userId: string, inbox: boolean) {
    return this.prisma.request.findMany({
      where: inbox ? { recipientUserId: userId } : { senderUserId: userId },
      orderBy: { updatedAt: 'desc' },
    });
  }
  async detail(userId: string, id: string) {
    const value = await this.prisma.request.findFirst({
      where: { id, OR: [{ senderUserId: userId }, { recipientUserId: userId }] },
      include: { revisions: true, timelineEvents: true, executions: { include: { result: true } } },
    });
    if (!value) throw new NotFoundException();
    return value;
  }
  async send(userId: string, id: string) {
    const request = await this.get(id);
    if (request.senderUserId !== userId) throw new ForbiddenException();
    this.guard(request.state as RequestState, RequestState.SENT, TransitionActor.SENDER);
    await this.prisma.requestRevision.update({
      where: { id: request.currentRevisionId! },
      data: { sentAt: new Date() },
    });
    return this.prisma.request.update({ where: { id }, data: { state: 'SENT' } });
  }
  async recipient(
    userId: string,
    id: string,
    target: RequestState,
    event: TimelineEventType,
    reason?: string,
  ) {
    const request = await this.get(id);
    if (request.recipientUserId !== userId) throw new ForbiddenException();
    this.guard(request.state as RequestState, target, TransitionActor.RECIPIENT);
    if (target === RequestState.RETURNED && !reason)
      throw new ConflictException('반려 사유가 필요합니다.');
    const value = await this.prisma.request.update({
      where: { id },
      data: {
        state: target,
        returnReason: reason,
        acceptedAt: target === RequestState.ACCEPTED ? new Date() : undefined,
      },
    });
    await this.prisma.timelineEvent.create({
      data: {
        requestId: id,
        actorType: 'HUMAN',
        actorUserId: userId,
        eventType: event,
        payload: reason ? { reason } : {},
      },
    });
    return value;
  }
  async device(token: string) {
    const hash = createHash('sha256').update(token).digest('hex');
    const device = await this.prisma.device.findUnique({ where: { tokenHash: hash } });
    if (!device || device.revokedAt) throw new ForbiddenException();
    return device;
  }
  async execution(userId: string, requestId: string, body: any) {
    const request = await this.get(requestId);
    if (request.recipientUserId !== userId) throw new ForbiddenException();
    if (request.state !== 'FAILED')
      this.guard(
        request.state as RequestState,
        RequestState.READY_TO_RUN,
        TransitionActor.RECIPIENT,
      );
    const existing = await this.prisma.execution.findFirst({
      where: { projectId: body.projectId, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (existing) throw new ConflictException('Project 실행 중');
    const agent = await this.prisma.agent.findFirst({
      where: { id: body.agentId, ownerUserId: userId },
    });
    if (!agent) throw new ForbiddenException();
    return this.prisma.$transaction(async (tx) => {
      const execution = await tx.execution.create({
        data: {
          requestId,
          requestRevisionId: request.currentRevisionId!,
          executorUserId: userId,
          agentId: agent.id,
          projectId: body.projectId,
          additionalInstruction: body.additionalInstruction || '',
          effectiveInstructionRef: 'pending://instruction',
        },
      });
      const payload = {
        eventName: 'execution.command.requested',
        eventId: randomUUID(),
        executionId: execution.id,
        requestId,
        requestRevisionId: request.currentRevisionId,
        agentId: agent.id,
        projectId: body.projectId,
        policy: { repository_edit: 'allow', deployment_apply: 'deny' },
      };
      await tx.outboxEvent.create({
        data: {
          deviceId: agent.deviceId,
          executionId: execution.id,
          eventName: 'execution.command.requested',
          payload,
        },
      });
      await tx.request.update({ where: { id: requestId }, data: { state: 'READY_TO_RUN' } });
      return execution;
    });
  }
  async status(token: string, id: string, body: any) {
    const device = await this.device(token);
    const execution = await this.prisma.execution.findFirst({
      where: { id, agent: { deviceId: device.id } },
    });
    if (!execution) throw new ForbiddenException();
    if (body.status === 'RUNNING') {
      await this.prisma.execution.update({
        where: { id },
        data: { status: 'RUNNING', startedAt: new Date() },
      });
      await this.prisma.request.update({
        where: { id: execution.requestId },
        data: { state: 'RUNNING' },
      });
    }
    await this.prisma.timelineEvent.create({
      data: {
        requestId: execution.requestId,
        executionId: id,
        actorType: 'DESKTOP_AGENT',
        eventType: TimelineEventType.EXECUTION_PROGRESS_REPORTED,
        payload: body,
      },
    });
    return { ok: true };
  }
  async result(token: string, id: string, body: any, failed = false) {
    await this.device(token);
    const execution = await this.prisma.execution.findUniqueOrThrow({ where: { id } });
    await this.prisma.$transaction(async (tx) => {
      await tx.execution.update({
        where: { id },
        data: {
          status: failed ? 'FAILED' : 'SUCCEEDED',
          finishedAt: new Date(),
          failureReason: failed ? body.failureReason || 'failed' : null,
        },
      });
      await tx.request.update({
        where: { id: execution.requestId },
        data: { state: failed ? 'FAILED' : 'RESULT_REVIEW' },
      });
      if (!failed)
        await tx.result.upsert({
          where: { executionId: id },
          update: { summary: body.summary },
          create: {
            executionId: id,
            summary: body.summary,
            changedFiles: body.changedFiles || [],
            testSummary: body.testSummary,
            artifactIds: body.artifactIds || [],
          },
        });
    });
    return { ok: true };
  }
  async approve(userId: string, id: string) {
    const result = await this.prisma.result.findUnique({
      where: { id },
      include: { execution: { include: { request: true } } },
    });
    if (!result || result.execution.request.recipientUserId !== userId)
      throw new ForbiddenException();
    this.guard(
      result.execution.request.state as RequestState,
      RequestState.COMPLETED,
      TransitionActor.RECIPIENT,
    );
    await this.prisma.result.update({
      where: { id },
      data: {
        reviewStatus: 'APPROVED',
        reviewedByUserId: userId,
        reviewedAt: new Date(),
        sentAt: new Date(),
      },
    });
    await this.prisma.request.update({
      where: { id: result.execution.requestId },
      data: { state: 'COMPLETED', completedAt: new Date() },
    });
    if (result.execution.request.parentRequestId) await recordChildCompleted(this.prisma as any, result.execution.request.parentRequestId, result.execution.request.id, id);
    return { ok: true };
  }
  async outbox(token: string, last = '') {
    const device = await this.device(token);
    return this.prisma.outboxEvent.findMany({
      where: { deviceId: device.id, ...(last ? { id: { gt: last } } : {}) },
      orderBy: { createdAt: 'asc' },
    });
  }
}
