import { effectiveAgentCapabilities } from '@baton/shared';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { presenceCutoff } from '../desktop/presence';
import { PrismaService } from '../prisma.service';
import { RequestState, TimelineEventType, TransitionActor, canTransition } from '@baton/shared';
import { Prisma, Request as RequestRow } from '@prisma/client';
import {
  assertRecipient,
  isOrgAdmin,
  isSenderOnly,
  isTeamRecipient,
  publicPerson,
  requestPeople,
} from './request-access';
import {
  filterAndRedactTimelineEventsForSender,
  redactExecutionForSender,
  redactResultForSender,
  redactTimelineEventForSender,
} from './sender-projection';
import { outboxEvents, webUrlBase } from '../desktop/outbox-events';
import { senderDisplayName } from '../common/sender-name';
/** 웹 받은함과 기기 조회가 같은 팀·조직 경계를 사용한다. */
export function requestInboxWhere(userId: string): Prisma.RequestWhereInput {
  return {
    state: { not: 'WITHDRAWN' },
    OR: [
      { recipientUserId: userId },
      {
        senderUserId: { not: userId },
        state: { not: 'DRAFT' },
        OR: [{ recipientUserId: null }, { claimedAt: { not: null } }],
        recipientTeam: {
          memberships: { some: { userId } },
          org: { memberships: { some: { userId } } },
        },
      },
    ],
  };
}

export function requestOutboxWhere(userId: string): Prisma.RequestWhereInput {
  return { senderUserId: userId };
}

type RevisionBody = {
  originalInstruction: string;
  documentVersionIds?: string[];
  artifactIds?: string[];
};
export async function recordChildCompleted(tx: Prisma.TransactionClient, parentRequestId: string, childRequestId: string, resultId: string) {
  return tx.timelineEvent.create({ data: { requestId: parentRequestId, actorType: 'SERVER', eventType: TimelineEventType.REQUEST_CHILD_COMPLETED,
    payload: { childRequestId, resultId } } });
}
export function projectDelegatedChildren(children: any[], senderOnly: boolean) {
  return children.map((child) => {
    const latestApprovedResultSummary = child.executions.flatMap((e: any) => e.result?.reviewStatus === 'APPROVED' ? [e.result.summary] : []).at(-1);
    return senderOnly
      ? { recipientTeam: child.recipientTeam, state: child.state }
      : { id: child.id, title: child.title, recipientTeam: child.recipientTeam, state: child.state, latestApprovedResultSummary };
  });
}
@Injectable()
export class RequestsService {
  constructor(@Inject(PrismaService) private prisma: PrismaService) {}
  private guard(from: RequestState, to: RequestState, actor: TransitionActor) {
    if (!canTransition(from, to, actor)) throw new ConflictException('유효하지 않은 상태 전이');
  }
  private async owned(id: string, userId: string) {
    const request = await this.prisma.request.findUnique({
      where: { id },
      include: { revisions: true },
    });
    if (!request) throw new NotFoundException();
    if (request.senderUserId !== userId && request.recipientUserId !== userId) {
      const isTeam =
        request.state !== 'DRAFT' &&
        (!request.recipientUserId || request.claimedAt) &&
        (await isTeamRecipient(this.prisma, request, userId));
      if (!isTeam && !(await isOrgAdmin(this.prisma, request, userId))) {
        throw new ForbiddenException();
      }
    }
    return request;
  }
  /**
   * CLO-110(H-1): 이 사람이 **발신자 시야**로만 보는가.
   * 확정 수신자·수신 팀원·관리자는 수신자/관리자 측이므로 전부 본다. 그 밖에서 owned() 를 통과한 사람은 발신자뿐이다.
   */
  private async senderOnly(request: RequestRow, userId: string) {
    return isSenderOnly(this.prisma, request, userId);
  }
  private async event(
    requestId: string,
    actorUserId: string,
    eventType: TimelineEventType,
    revisionId?: string,
    payload: object = {},
  ) {
    return this.prisma.timelineEvent.create({
      data: {
        requestId,
        requestRevisionId: revisionId,
        actorType: 'HUMAN',
        actorUserId,
        eventType,
        payload,
      },
    });
  }
  async create(userId: string, body: any) {
    return this.prisma.$transaction(async (tx) => {
      await this.validateRoute(
        tx,
        userId,
        body.senderTeamId,
        body.recipientTeamId,
        body.recipientUserId,
      );
      const request = await tx.request.create({
        data: {
          senderTeamId: body.senderTeamId,
          recipientTeamId: body.recipientTeamId,
          senderUserId: userId,
          recipientUserId: body.recipientUserId,
          title: body.title,
        },
      });
      const revision = await tx.requestRevision.create({
        data: {
          requestId: request.id,
          revisionNo: 1,
          originalInstruction: body.originalInstruction,
          documentVersionIds: body.documentVersionIds ?? [],
          artifactIds: body.artifactIds ?? [],
          createdByUserId: userId,
        },
      });
      const value = await tx.request.update({
        where: { id: request.id },
        data: { currentRevisionId: revision.id },
      });
      await tx.timelineEvent.create({
        data: {
          requestId: request.id,
          requestRevisionId: revision.id,
          actorType: 'HUMAN',
          actorUserId: userId,
          eventType: TimelineEventType.REQUEST_CREATED,
          payload: {},
        },
      });
      await tx.timelineEvent.create({
        data: {
          requestId: request.id,
          requestRevisionId: revision.id,
          actorType: 'HUMAN',
          actorUserId: userId,
          eventType: TimelineEventType.REQUEST_REVISION_CREATED,
          payload: { revisionNo: 1 },
        },
      });
      return value;
    });
  }
  async delegate(userId: string, parentId: string, body: any) {
    const parent = await this.prisma.request.findUnique({ where: { id: parentId }, include: { revisions: true } });
    if (!parent) throw new NotFoundException();
    const member = await this.prisma.teamMembership.findUnique({
      where: { teamId_userId: { teamId: parent.recipientTeamId, userId } },
    });
    if (!member) throw new ForbiddenException();
    if (!['ACCEPTED', 'READY_TO_RUN', 'RUNNING', 'RESULT_REVIEW'].includes(parent.state))
      throw new ConflictException('진행 중인 요청만 재위임할 수 있습니다.');
    const revision = parent.revisions.find((r) => r.id === parent.currentRevisionId);
    if (!revision) throw new ConflictException('현재 revision이 없습니다.');
    let ancestor: any = parent;
    while (ancestor) {
      if (ancestor.recipientTeamId === body.recipientTeamId) throw new BadRequestException('조상 팀으로 재위임할 수 없습니다.');
      if (!ancestor.parentRequestId) break;
      ancestor = await this.prisma.request.findUnique({ where: { id: ancestor.parentRequestId }, select: { id: true, recipientTeamId: true, parentRequestId: true } });
    }
    const revisionDocs = Array.isArray(revision.documentVersionIds) ? revision.documentVersionIds as string[] : [];
    const revisionArtifacts = Array.isArray(revision.artifactIds) ? revision.artifactIds as string[] : [];
    const selectedDocs: string[] = body.documentVersionIds ?? [];
    const selectedArtifacts: string[] = body.artifactIds ?? [];
    const selectedResults: string[] = body.resultIds ?? [];
    if (selectedDocs.some((x) => !revisionDocs.includes(x)) || selectedArtifacts.some((x) => !revisionArtifacts.includes(x)))
      throw new BadRequestException('부모의 현재 revision에 첨부된 항목만 상속할 수 있습니다.');
    const results = await this.prisma.result.findMany({ where: { execution: { requestId: parentId } }, include: { execution: { select: { requestRevision: { select: { revisionNo: true } } } } } });
    if (selectedResults.some((x) => !results.some((r) => r.id === x))) throw new BadRequestException('부모 요청의 결과만 상속할 수 있습니다.');
    const team = await this.prisma.team.findUniqueOrThrow({ where: { id: parent.recipientTeamId }, select: { id: true, name: true } });
    const parentContext = { parentTitle: parent.title, parentInstruction: revision.originalInstruction,
      parentResults: results.filter((r) => selectedResults.includes(r.id)).map((r) => ({ revisionNo: r.execution.requestRevision.revisionNo, summary: r.summary })) };
    const value = await this.prisma.$transaction(async (tx) => {
      await this.validateRoute(tx, userId, parent.recipientTeamId, body.recipientTeamId, body.recipientUserId);
      const child = await tx.request.create({ data: { senderTeamId: parent.recipientTeamId, recipientTeamId: body.recipientTeamId,
        senderUserId: userId, recipientUserId: body.recipientUserId, title: body.title, state: 'SENT',
        currentRevisionNo: 1, parentRequestId: parent.id, parentRevisionNo: parent.currentRevisionNo, parentContext } });
      const childRevision = await tx.requestRevision.create({ data: { requestId: child.id, revisionNo: 1,
        originalInstruction: body.instruction, documentVersionIds: selectedDocs, artifactIds: selectedArtifacts,
        createdByUserId: userId, sentAt: new Date() } });
      await tx.request.update({ where: { id: child.id }, data: { currentRevisionId: childRevision.id } });
      await tx.timelineEvent.create({ data: { requestId: child.id, requestRevisionId: childRevision.id, actorType: 'HUMAN', actorUserId: userId,
        eventType: TimelineEventType.REQUEST_CREATED, payload: { parentRequestId: parent.id } } });
      await tx.timelineEvent.create({ data: { requestId: child.id, requestRevisionId: childRevision.id, actorType: 'HUMAN', actorUserId: userId,
        eventType: TimelineEventType.REQUEST_REVISION_CREATED, payload: { revisionNo: 1 } } });
      await tx.timelineEvent.create({ data: { requestId: child.id, requestRevisionId: childRevision.id, actorType: 'HUMAN', actorUserId: userId,
        eventType: TimelineEventType.REQUEST_SENT, payload: {} } });
      await tx.timelineEvent.create({ data: { requestId: parent.id, requestRevisionId: parent.currentRevisionId, actorType: 'HUMAN', actorUserId: userId,
        eventType: TimelineEventType.REQUEST_DELEGATED, payload: { childRequestId: child.id, recipientTeamId: body.recipientTeamId } } });
      const target = await tx.team.findUniqueOrThrow({ where: { id: body.recipientTeamId } });
      const members = await tx.teamMembership.findMany({ where: { teamId: target.id, userId: { not: userId }, user: { orgMemberships: { some: { orgId: target.orgId } } } } });
      const recipientIds = body.recipientUserId ? [body.recipientUserId] : members.map((m) => m.userId);
      const deliveryPayload = { eventName: 'request.delivered', requestId: child.id, recipientTeam: { id: target.id, name: target.name }, recipientUserId: child.recipientUserId, recipientUserIds: recipientIds };
      await tx.timelineEvent.create({ data: { requestId: child.id, requestRevisionId: childRevision.id, actorType: 'HUMAN', actorUserId: userId,
        eventType: TimelineEventType.REQUEST_DELIVERED, payload: deliveryPayload } });
      const [devices, sender] = await Promise.all([tx.device.findMany({ where: { userId: { in: recipientIds }, revokedAt: null } }), tx.user.findUnique({ where: { id: userId } })]);
      const outbox: any[] = [];
      for (const device of devices) outbox.push(await tx.outboxEvent.create({ data: { deviceId: device.id, eventName: 'request.delivered', payload: {
        ...deliveryPayload, title: child.title, senderName: senderDisplayName(sender), revisionNo: 1, webUrl: `${webUrlBase()}/requests/${child.id}` } } }));
      return { child: await tx.request.findUniqueOrThrow({ where: { id: child.id } }), outbox };
    });
    for (const event of value.outbox) outboxEvents.emit('created', event);
    return value.child;
  }
  async recipients(userId: string, senderTeamId: string) {
    const sender = await this.prisma.team.findFirst({
      where: {
        id: senderTeamId,
        memberships: { some: { userId } },
        org: { memberships: { some: { userId } } },
      },
    });
    if (!sender) throw new ForbiddenException();
    const teams = await this.prisma.team.findMany({
      where: {
        orgId: sender.orgId,
        OR: [
          { id: senderTeamId },
          { incomingLinks: { some: { fromTeamId: senderTeamId, orgId: sender.orgId } } },
        ],
      },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        memberships: {
          where: {
            userId: { not: userId },
            user: { orgMemberships: { some: { orgId: sender.orgId } } },
          },
          select: {
            user: {
              select: {
                ...publicPerson,
                // 수신자 선택 화면의 온라인 뱃지. presence 와 같은 2분 기준을 쓴다.
                devices: {
                  where: { revokedAt: null, lastSeenAt: { gt: presenceCutoff() } },
                  select: { id: true },
                  take: 1,
                },
              },
            },
          },
        },
      },
    });
    return {
      teams: teams.map(({ memberships, ...team }) => ({
        ...team,
        members: memberships.map(({ user: { devices, ...user } }) => ({
          ...user,
          hasActiveDevice: devices.length > 0,
        })),
      })),
    };
  }
  private async validateRoute(
    tx: Prisma.TransactionClient,
    userId: string,
    senderTeamId: string,
    recipientTeamId: string,
    recipientUserId?: string | null,
  ) {
    const sender = await tx.team.findFirst({
      where: {
        id: senderTeamId,
        memberships: { some: { userId } },
        org: { memberships: { some: { userId } } },
      },
    });
    if (!sender) throw new ForbiddenException();
    const recipient = await tx.team.findFirst({
      where: {
        id: recipientTeamId,
        orgId: sender.orgId,
        ...(recipientUserId
          ? {
              memberships: {
                some: {
                  userId: recipientUserId,
                  user: { orgMemberships: { some: { orgId: sender.orgId } } },
                },
              },
            }
          : {}),
      },
    });
    if (
      !recipient ||
      (senderTeamId !== recipientTeamId &&
        !(await tx.teamLink.findUnique({
          where: { fromTeamId_toTeamId: { fromTeamId: senderTeamId, toTeamId: recipientTeamId } },
        })))
    )
      throw new ForbiddenException('허용되지 않은 수신 대상입니다.');
  }
  async list(userId: string, box?: string) {
    const inbox = requestInboxWhere(userId);
    const where =
      box === 'inbox'
        ? inbox
        : box === 'outbox'
          ? requestOutboxWhere(userId)
          : { OR: [requestOutboxWhere(userId), { ...inbox, state: undefined }] };
    const requests = await this.prisma.request.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: { ...requestPeople, revisions: { orderBy: { revisionNo: 'desc' }, take: 1 },
        timelineEvents: { where: { eventType: 'request.followup_sent' }, select: { requestRevisionId: true } } },
    });
    return requests.map(({ timelineEvents, parentRequestId, ...r }) => ({ ...r,
      isFollowup: timelineEvents.some((e) => e.requestRevisionId === r.currentRevisionId),
      isDelegated: !!parentRequestId,
      claimedBy: r.claimedAt ? r.recipient : null }));
  }
  async detail(userId: string, id: string) {
    const owned = await this.owned(id, userId);
    // 수신자의 비공개 추가 지시는 요청을 보낸 쪽에 내보내지 않는다(CLO-110 H-1-3).
    const senderOnly = await this.senderOnly(owned, userId);
    const value = await this.prisma.request.findUniqueOrThrow({
      where: { id },
      include: {
        ...requestPeople,
        revisions: { orderBy: { revisionNo: 'asc' } },
        artifacts: true,
        timelineEvents: { orderBy: { occurredAt: 'asc' } },
        // 웹은 마지막 항목을 최신 실행으로 본다. 정렬이 없으면 DB 순서(최신 먼저)라 재실행 뒤 이전 실패가 표시됐다 (W5d-2 수정)
        executions: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          include: { result: true, agent: true },
        },
        parent: true,
        children: { include: { recipientTeam: { select: { id: true, name: true } }, executions: { include: { result: true } } } },
      },
    });
    // CLO-141: 발신자에게는 승인 전 결과를 가린다. results/result/latestResult 와
    // executions[].result 네 군데가 모두 같은 행을 가리키므로 한 번에 정제한다.
    const projectResult = <T extends { reviewStatus?: unknown }>(result: T | null) =>
      result && senderOnly ? (redactResultForSender(result) as unknown as T) : result;
    const results = value.executions.flatMap((execution) =>
      execution.result ? [projectResult(execution.result)!] : [],
    );
    // 새 실행 중에는 이전 결과를 최신으로 오인하지 않도록 null을 반환한다.
    const candidate = value.executions.at(-1)?.result;
    const latestResult = projectResult(candidate?.kind === 'PARTIAL' ? null : (candidate ?? null));
    return {
      ...value,
      // 실행 산출물은 결과 경로에서만 공개한다. 승인 전 파일명도 요청 첨부로 노출하지 않는다.
      artifacts: value.artifacts.filter((artifact) => artifact.kind === 'REQUEST_ATTACHMENT'),
      children: projectDelegatedChildren(value.children, senderOnly),
      parent: value.parent ? {
        title: value.parent.title,
        context: value.parentContext,
        ...(value.parent.senderUserId === userId || value.parent.recipientUserId === userId || await this.prisma.teamMembership.findUnique({ where: { teamId_userId: { teamId: value.parent.recipientTeamId, userId } } }) ? { id: value.parent.id } : {}),
      } : null,
      isFollowup: value.timelineEvents.some((e) => e.eventType === 'request.followup_sent' && e.requestRevisionId === value.currentRevisionId),
      timelineEvents: await this.withAgentProviders(
        filterAndRedactTimelineEventsForSender(value.timelineEvents, senderOnly),
      ),
      executions: value.executions.map((execution) => {
        const projected = {
          ...execution,
          result: projectResult(execution.result),
          agent: {
            ...execution.agent,
            capabilities: effectiveAgentCapabilities(
              execution.agent.provider,
              execution.agent.capabilities,
            ),
          },
        };
        return senderOnly ? redactExecutionForSender(projected) : projected;
      }),
      results,
      result: latestResult,
      latestResult,
      claimedBy: value.claimedAt ? value.recipient : null,
    };
  }
  async updateDraft(userId: string, id: string, body: Partial<RevisionBody & { title: string }>) {
    const request = await this.owned(id, userId);
    if (request.senderUserId !== userId) throw new ForbiddenException();
    if (request.state !== 'DRAFT')
      throw new ConflictException('DRAFT 상태에서만 수정할 수 있습니다.');
    const revision = request.revisions.find((r) => r.id === request.currentRevisionId)!;
    await this.prisma.$transaction([
      this.prisma.request.update({ where: { id }, data: { title: body.title } }),
      this.prisma.requestRevision.update({
        where: { id: revision.id },
        data: {
          originalInstruction: body.originalInstruction,
          documentVersionIds: body.documentVersionIds,
          artifactIds: body.artifactIds,
        },
      }),
    ]);
    return this.detail(userId, id);
  }
  /**
   * CLO-141: 검토 중이던 결과를 "채택되지 않음"으로 닫는다. 반려·거절·폐기가 공유한다.
   *
   * `disclose` 가 켜져 있으면 그 결과의 **RESULT_ATTACHMENT(result.md) 한 건만** 요청자에게 연다.
   * patch·stream 은 열지 않는다 — 실행자 컴퓨터의 경로와 명령이 그대로 들어 있다(설계 10 §4).
   * 본문을 복사하지 않고 아티팩트 id 만 두는 이유는 아티팩트가 sha256 주소지정이라 불변이기 때문이다.
   */
  private async closeReviewedResult(
    tx: Prisma.TransactionClient,
    requestId: string,
    userId: string,
    status: 'CHANGES_REQUESTED' | 'DISCARDED',
    disclose: boolean,
  ) {
    const latest = await tx.execution.findFirst({
      where: { requestId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { result: true },
    });
    const result = latest?.result;
    // PARTIAL 은 승인 대상이 아니고(취소 회차의 부분 결과), 이미 결정된 결과는 덮지 않는다.
    if (!result || result.kind === 'PARTIAL' || result.reviewStatus !== 'PENDING') return null;
    let disclosedArtifactId: string | null = null;
    if (disclose) {
      const ids = Array.isArray(result.artifactIds) ? (result.artifactIds as string[]) : [];
      const resultMd = ids.length
        ? await tx.artifact.findFirst({
            where: { id: { in: ids }, kind: 'RESULT_ATTACHMENT' },
            orderBy: { createdAt: 'asc' },
          })
        : null;
      disclosedArtifactId = resultMd?.id ?? null;
    }
    const now = new Date();
    await tx.result.update({
      where: { id: result.id },
      data: {
        reviewStatus: status,
        reviewedByUserId: userId,
        reviewedAt: now,
        ...(disclosedArtifactId
          ? { disclosedArtifactId, disclosedAt: now, disclosedByUserId: userId }
          : {}),
      },
    });
    if (disclosedArtifactId)
      await tx.timelineEvent.create({
        data: {
          requestId,
          executionId: result.executionId,
          actorType: 'HUMAN',
          actorUserId: userId,
          eventType: TimelineEventType.RESULT_DISCLOSED_TO_SENDER,
          payload: { resultId: result.id, artifactId: disclosedArtifactId },
        },
      });
    return { resultId: result.id, disclosedArtifactId, changedFiles: result.changedFiles };
  }

  /**
   * CLO-141: 결과를 버리고 실행 설정부터 다시 한다(RESULT_REVIEW → ACCEPTED).
   *
   * `/accept` 로 겸하지 않는 이유는 타임라인이 `request.accepted` 로 찍혀 감사 기록이
   * 거짓말을 하기 때문이다. 폐기는 "수락했다"가 아니라 "이 결과를 버렸다"는 사건이다.
   *
   * **실행자 컴퓨터의 파일 변경은 그대로 남는다.** Baton 은 되돌리지 않으므로 무엇이 남았는지를
   * 이벤트 payload 의 changedFiles 로 남겨 화면이 알릴 수 있게 한다.
   */
  async discardResult(userId: string, id: string, reason?: string) {
    const request = await this.owned(id, userId);
    if (request.senderUserId === userId) throw new ForbiddenException();
    await assertRecipient(this.prisma, request, userId);
    this.guard(request.state as RequestState, RequestState.ACCEPTED, TransitionActor.RECIPIENT);
    const value = await this.prisma.$transaction(async (tx) => {
      const changedRows = await tx.request.updateMany({
        where: { id, state: request.state, recipientUserId: userId },
        data: { state: RequestState.ACCEPTED, acceptedAt: new Date() },
      });
      if (!changedRows.count) throw new ConflictException('요청 상태가 변경되었습니다.');
      const closed = await this.closeReviewedResult(tx, id, userId, 'DISCARDED', false);
      await tx.timelineEvent.create({
        data: {
          requestId: id,
          requestRevisionId: request.currentRevisionId,
          actorType: 'HUMAN',
          actorUserId: userId,
          eventType: TimelineEventType.RESULT_DISCARDED,
          payload: {
            ...(reason ? { reason } : {}),
            resultId: closed?.resultId ?? null,
            // 폐기해도 실행자 컴퓨터의 변경은 남는다. 무엇이 남았는지가 이 기록의 핵심이다.
            changedFiles: closed?.changedFiles ?? [],
          },
        },
      });
      return tx.request.findUniqueOrThrow({ where: { id } });
    });
    return value;
  }

  async transition(
    userId: string,
    id: string,
    target: RequestState,
    eventType: TimelineEventType,
    reason?: string,
    reassign: 'same' | 'team' = 'same',
    discloseResult = false,
  ) {
    const request = await this.owned(id, userId);
    // 전이를 시작한 상태를 먼저 붙잡는다. 아래 트랜잭션이 상태를 바꾼 뒤에도
    // "어디에서 나왔는가"를 봐야 하는 분기가 있다(결과 검토에서 나가는 반려·거절).
    const originState = request.state as RequestState;
    if (target === RequestState.SENT && ['COMPLETED', 'FAILED'].includes(request.state))
      throw new ConflictException('이어서 요청은 새 revision과 함께 보내야 합니다.');
    const sender = request.senderUserId === userId;
    if ((target === RequestState.SENT && !sender) || (target !== RequestState.SENT && sender))
      throw new ForbiddenException();
    if (!sender) await assertRecipient(this.prisma, request, userId);
    const actor = sender ? TransitionActor.SENDER : TransitionActor.RECIPIENT;
    this.guard(request.state as RequestState, target, actor);
    if ((target === RequestState.RETURNED || target === RequestState.REJECTED) && !reason)
      throw new ConflictException('사유가 필요합니다.');
    const rebroadcast = reassign === 'team';
    if (
      rebroadcast &&
      (target !== RequestState.SENT || request.state !== 'RETURNED' || !request.claimedAt)
    )
      throw new BadRequestException('반려된 팀 전체 전달 요청만 다시 뿌릴 수 있습니다.');
    if (rebroadcast && request.revisions.find((r) => r.id === request.currentRevisionId)?.sentAt)
      throw new ConflictException('보완한 새 revision을 먼저 만들어야 합니다.');
    const value = await this.prisma.$transaction(async (tx) => {
      if (target === RequestState.SENT) {
        await this.validateRoute(
          tx,
          userId,
          request.senderTeamId,
          request.recipientTeamId,
          rebroadcast ? null : request.recipientUserId,
        );
      }
      const claiming =
        !request.recipientUserId &&
        [RequestState.ACCEPTED, RequestState.RETURNED, RequestState.REJECTED].includes(target);
      // 조건부 UPDATE가 잠금 획득 후 최신 값을 검사하므로 첫 처리자만 확정된다.
      const result = await tx.request.updateMany({
        where: {
          id,
          state: request.state,
          currentRevisionId: request.currentRevisionId,
          ...(request.recipientUserId === null
            ? { recipientUserId: null }
            : { recipientUserId: request.recipientUserId }),
        },
        data: {
          state: target,
          ...(rebroadcast ? { recipientUserId: null, claimedAt: null } : {}),
          ...(claiming ? { recipientUserId: userId, claimedAt: new Date() } : {}),
          // 반려(RETURNED)와 거절(REJECTED) 모두 사유를 남긴다. 예전에는 RETURNED 만 저장해
          // 거절 사유가 Request 에서 사라졌고, 요청자 화면은 늘 "사유 미기재" 를 보여 줬다
          // (2026-09-18 2인 테스트에서 테스터가 적은 사유가 전달되지 않았다).
          // 타임라인 payload 에는 남아 있었으므로 데이터 유실은 아니고 표시 경로만 비어 있었다.
          returnReason:
            target === RequestState.RETURNED || target === RequestState.REJECTED ? reason : null,
          acceptedAt: target === RequestState.ACCEPTED ? new Date() : undefined,
        },
      });
      if (!result.count)
        throw new ConflictException(
          request.recipientUserId === null ? '이미 다른 팀원이 처리 중' : '유효하지 않은 상태 전이',
        );
      if (target === RequestState.SENT) {
        // 리비전이 없는 DRAFT 는 보낼 내용 자체가 없다. 막지 않으면 where:{id:null} 로
        // Prisma 가 터져 500 과 스택트레이스만 남고, 화면에는 원인이 안 보인다.
        if (!request.currentRevisionId)
          throw new ConflictException('보낼 내용이 없는 요청입니다 (리비전 없음).');
        await tx.requestRevision.update({
          where: { id: request.currentRevisionId },
          data: { sentAt: new Date() },
        });
      }
      const changed = await tx.request.findUniqueOrThrow({ where: { id } });
      // CLO-141: 결과 검토에서 나가는 반려·거절이면 검토 중이던 결과의 결말도 함께 확정한다.
      // 수락 전(REVIEWING) 반려와 구분되도록 타임라인 payload 에 표시를 남긴다.
      const resultExit =
        originState === RequestState.RESULT_REVIEW
          ? await this.closeReviewedResult(
              tx,
              id,
              userId,
              target === RequestState.RETURNED ? 'CHANGES_REQUESTED' : 'DISCARDED',
              target === RequestState.RETURNED && discloseResult,
            )
          : null;
      const recordAction = () =>
        tx.timelineEvent.create({
          data: {
            requestId: id,
            requestRevisionId: request.currentRevisionId,
            actorType: 'HUMAN',
            actorUserId: userId,
            eventType,
            payload: {
              ...(reason ? { reason } : {}),
              ...(resultExit
                ? {
                    fromResultReview: true,
                    resultId: resultExit.resultId,
                    disclosedArtifactId: resultExit.disclosedArtifactId,
                  }
                : {}),
            },
          },
        });
      if (!claiming) await recordAction();
      if (rebroadcast)
        await tx.timelineEvent.create({
          data: {
            requestId: id,
            requestRevisionId: request.currentRevisionId,
            actorType: 'HUMAN',
            actorUserId: userId,
            eventType: TimelineEventType.REQUEST_REBROADCAST,
            payload: {
              reassign: 'team',
              previousRecipientUserId: request.recipientUserId,
              recipientTeamId: request.recipientTeamId,
            },
          },
        });
      // 전송·재전송 시 수신자의 모든 디바이스(메뉴바 앱)에 알림 이벤트를 outbox 로 남긴다 (기획서 §9, 02 §8).
      const outbox: {
        id: string;
        deviceId: string;
        eventName: string;
        payload: unknown;
        createdAt: Date;
      }[] = [];
      if (target === RequestState.SENT || claiming) {
        const team = await tx.team.findUniqueOrThrow({ where: { id: request.recipientTeamId } });
        const members = await tx.teamMembership.findMany({
          where: {
            teamId: team.id,
            userId: { not: request.senderUserId },
            user: { orgMemberships: { some: { orgId: team.orgId } } },
          },
        });
        const recipientUserIds = claiming
          ? members.map((m) => m.userId).filter((id) => id !== userId)
          : changed.recipientUserId
            ? [changed.recipientUserId]
            : members.map((m) => m.userId);
        const claimedBy = claiming
          ? await tx.user.findUniqueOrThrow({ where: { id: userId }, select: publicPerson })
          : null;
        const eventName = claiming ? 'request.claimed' : 'request.delivered';
        // recipientUserId: 사람 지정이면 그 사람, 팀 전체 뿌리기면 null, claim 이후면 확정된 사람.
        // 데몬은 recipientTeam + recipientUserId === null 로 "팀 전체" 알림 제목을 만든다 (05 §6, 04 §10.2).
        const payload = {
          eventName,
          requestId: id,
          recipientTeam: { id: team.id, name: team.name },
          recipientUserId: changed.recipientUserId,
          claimedBy,
          recipientUserIds,
        };
        await tx.timelineEvent.create({
          data: {
            requestId: id,
            requestRevisionId: request.currentRevisionId,
            actorType: 'HUMAN',
            actorUserId: userId,
            eventType: eventName,
            payload,
          },
        });
        const [devices, senderUser] = await Promise.all([
          tx.device.findMany({ where: { userId: { in: recipientUserIds }, revokedAt: null } }),
          tx.user.findUnique({ where: { id: request.senderUserId } }),
        ]);
        for (const device of devices) {
          outbox.push(
            await tx.outboxEvent.create({
              data: {
                deviceId: device.id,
                eventName,
                payload: {
                  ...payload,
                  title: changed.title,
                  senderName: senderDisplayName(senderUser),
                  revisionNo: changed.currentRevisionNo,
                  webUrl: `${webUrlBase()}/requests/${id}`,
                },
              },
            }),
          );
        }
      }
      if (claiming) await recordAction();
      return { changed, outbox };
    });
    for (const event of value.outbox) outboxEvents.emit('created', event);
    return value.changed;
  }
  async withdraw(userId: string, id: string, reason?: string) {
    const request = await this.owned(id, userId);
    if (request.senderUserId !== userId) throw new ForbiddenException();
    this.guard(request.state as RequestState, RequestState.WITHDRAWN, TransitionActor.SENDER);
    if (request.acceptedAt) throw new ConflictException('수락된 적이 있는 요청은 철회할 수 없습니다.');
    const value = await this.prisma.$transaction(async (tx) => {
      // 수락·재전송과 같은 요청 행을 잠근 뒤 실행 이력을 확인한다. 실패하면 철회도 롤백한다.
      const changed = await tx.request.updateMany({
        where: { id, senderUserId: userId, state: request.state,
          currentRevisionId: request.currentRevisionId, acceptedAt: null },
        data: { state: 'WITHDRAWN' },
      });
      if (!changed.count) throw new ConflictException('요청 상태가 변경되었습니다.');
      if (await tx.execution.findFirst({ where: { requestId: id }, select: { id: true } }))
        throw new ConflictException('실행 이력이 있는 요청은 철회할 수 없습니다.');
      await tx.timelineEvent.create({ data: {
        requestId: id, requestRevisionId: request.currentRevisionId,
        actorType: 'HUMAN', actorUserId: userId, eventType: TimelineEventType.REQUEST_WITHDRAWN,
        payload: { reason: reason ?? null },
      } });
      const team = await tx.team.findUniqueOrThrow({ where: { id: request.recipientTeamId } });
      const members = request.recipientUserId && !request.claimedAt ? [] : await tx.teamMembership.findMany({
        where: { teamId: team.id, userId: { not: userId }, user: { orgMemberships: { some: { orgId: team.orgId } } } },
      });
      const recipientIds = request.recipientUserId && !request.claimedAt
        ? [request.recipientUserId] : members.map((m) => m.userId);
      const devices = await tx.device.findMany({ where: { userId: { in: recipientIds }, revokedAt: null } });
      const outbox = [];
      for (const device of devices) outbox.push(await tx.outboxEvent.create({ data: {
        deviceId: device.id, eventName: 'request.withdrawn',
        payload: { eventName: 'request.withdrawn', requestId: id, title: request.title,
          webUrl: `${webUrlBase()}/requests/${id}` },
      } }));
      return { outbox, request: await tx.request.findUniqueOrThrow({ where: { id } }) };
    });
    for (const event of value.outbox) outboxEvents.emit('created', event);
    return value.request;
  }

  async startReview(userId: string, id: string) {
    const r = await this.owned(id, userId);
    await assertRecipient(this.prisma, r, userId);
    if (r.state === 'REVIEWING') return r;
    if (r.state === 'SENT')
      await this.transition(userId, id, RequestState.DELIVERED, TimelineEventType.REQUEST_VIEWED);
    return this.transition(
      userId,
      id,
      RequestState.REVIEWING,
      TimelineEventType.REQUEST_REVIEW_STARTED,
    );
  }
  async revision(userId: string, id: string, body: RevisionBody) {
    const request = await this.owned(id, userId);
    if (request.senderUserId !== userId) throw new ForbiddenException();
    if (['COMPLETED', 'FAILED'].includes(request.state))
      return this.sendFollowup(userId, request, body);
    if (request.state !== 'RETURNED')
      throw new ConflictException('RETURNED 상태에서만 새 revision을 만들 수 있습니다.');
    const revision = await this.prisma.requestRevision.create({
      data: {
        requestId: id,
        revisionNo: request.currentRevisionNo + 1,
        originalInstruction: body.originalInstruction,
        documentVersionIds: body.documentVersionIds ?? [],
        artifactIds: body.artifactIds ?? [],
        createdByUserId: userId,
      },
    });
    await this.prisma.request.update({
      where: { id },
      data: { currentRevisionNo: revision.revisionNo, currentRevisionId: revision.id },
    });
    await this.event(id, userId, TimelineEventType.REQUEST_REVISION_CREATED, revision.id, {
      revisionNo: revision.revisionNo,
    });
    return revision;
  }
  private async sendFollowup(userId: string, request: RequestRow, body: RevisionBody) {
    this.guard(request.state as RequestState, RequestState.SENT, TransitionActor.SENDER);
    const value = await this.prisma.$transaction(async (tx) => {
      // 실행 생성과 같은 행을 조건부 갱신해 FAILED 재시도와 직렬화한다.
      const changed = await tx.request.updateMany({
        where: { id: request.id, senderUserId: userId, state: request.state,
          currentRevisionId: request.currentRevisionId },
        data: { state: 'SENT' },
      });
      if (!changed.count) throw new ConflictException('요청 상태가 변경되었습니다.');
      if (await tx.execution.findFirst({ where: { requestId: request.id, status: { in: ['QUEUED', 'RUNNING'] } } }))
        throw new ConflictException('진행 중인 실행이 있습니다.');
      const recipientUserId = request.claimedAt ? null : request.recipientUserId;
      await this.validateRoute(tx, userId, request.senderTeamId, request.recipientTeamId, recipientUserId);
      const revision = await tx.requestRevision.create({ data: {
        requestId: request.id, revisionNo: request.currentRevisionNo + 1,
        originalInstruction: body.originalInstruction,
        documentVersionIds: body.documentVersionIds ?? [], artifactIds: body.artifactIds ?? [],
        createdByUserId: userId, sentAt: new Date(),
      } });
      await tx.request.update({ where: { id: request.id }, data: {
        currentRevisionNo: revision.revisionNo, currentRevisionId: revision.id,
        recipientUserId, claimedAt: null, acceptedAt: null, completedAt: null, returnReason: null,
      } });
      await tx.timelineEvent.create({ data: {
        requestId: request.id, requestRevisionId: revision.id, actorType: 'HUMAN', actorUserId: userId,
        eventType: TimelineEventType.REQUEST_FOLLOWUP_SENT,
        payload: { revisionNo: revision.revisionNo, previousState: request.state },
      } });
      const team = await tx.team.findUniqueOrThrow({ where: { id: request.recipientTeamId } });
      const members = recipientUserId ? [] : await tx.teamMembership.findMany({ where: {
        teamId: team.id, userId: { not: userId }, user: { orgMemberships: { some: { orgId: team.orgId } } },
      } });
      const recipientUserIds = recipientUserId ? [recipientUserId] : members.map((m) => m.userId);
      const devices = await tx.device.findMany({ where: { userId: { in: recipientUserIds }, revokedAt: null } });
      const sender = await tx.user.findUnique({ where: { id: userId } });
      const outbox = [];
      for (const device of devices) outbox.push(await tx.outboxEvent.create({ data: {
        deviceId: device.id, eventName: 'request.delivered', payload: {
          eventName: 'request.delivered', requestId: request.id, title: request.title,
          followup: true, revisionNo: revision.revisionNo, recipientUserId, recipientUserIds,
          recipientTeam: { id: team.id, name: team.name }, senderName: senderDisplayName(sender),
          webUrl: `${webUrlBase()}/requests/${request.id}`,
        },
      } }));
      return { revision, outbox };
    });
    for (const event of value.outbox) outboxEvents.emit('created', event);
    return value.revision;
  }

  // 공개 범위를 판정한 뒤 표시 이름에 필요한 provider만 추가한다.
  private async withAgentProviders<T extends { agentId?: string | null }>(events: T[]) {
    const ids = [...new Set(events.flatMap((event) => (event.agentId ? [event.agentId] : [])))];
    const agents = ids.length
      ? await this.prisma.agent.findMany({
          where: { id: { in: ids } },
          select: { id: true, provider: true },
        })
      : [];
    const providers = new Map(agents.map((agent) => [agent.id, agent.provider]));
    return events.map((event) => ({
      ...event,
      agentProvider: event.agentId ? (providers.get(event.agentId) ?? null) : null,
    }));
  }

  async timeline(userId: string, id: string) {
    const request = await this.owned(id, userId);
    const senderOnly = await this.senderOnly(request, userId);
    const events = await this.prisma.timelineEvent.findMany({
      where: { requestId: id },
      orderBy: { occurredAt: 'asc' },
    });
    return this.withAgentProviders(filterAndRedactTimelineEventsForSender(events, senderOnly));
  }
}
