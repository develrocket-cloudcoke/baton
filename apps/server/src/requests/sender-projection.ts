/**
 * CLO-110(보안 검토 H-1): 발신자에게 나가는 응답에서 수신자의 비공개 보안/작업 정보를 지운다.
 *
 * `GET /v1/requests/:id`·`/timeline`·`GET /v1/executions/:id` 는 **발신자도** 통과시킨다.
 * 발신자에게 수신자의 provider·securityTier·capability 전문·승인 내역·비공개 지시가 노출되면
 * 프롬프트 인젝션 등의 정찰(reconnaissance) 정보로 악용될 수 있다.
 *
 * 지우는 범위(H-1 전면 적용):
 * - `Execution.additionalInstruction` (추가 작업 회차의 지시 포함)
 * - `Execution.agentCapabilitiesSnapshot` (수신자 측 보안 태세 전문)
 * - `Execution.acknowledgedRisks`, `riskAcknowledgedAt`, `riskAcknowledgedByUserId` (승인 내역)
 * - `Execution.claudeSessionId`, `Execution.projectId`
 * - `Execution.agent` 의 `provider`, `capabilities`, `deviceId`, `lastSeenAt`
 * - 타임라인 이벤트: 수신자 조작/보안 이벤트(`execution.risk_acknowledged`, `execution.command_requested`, `execution.command.cancel_requested`)는
 *   발신자 타임라인에서 제외하고, 모든 이벤트에 `audience`('both' | 'recipient') 메타데이터 부여.
 */

/** 지운 자리에는 빈 문자열을 둔다. 필드를 없애면 기존 클라이언트의 `string` 타입 계약이 깨진다. */
const REDACTED = '';

export type TimelineEventAudience = 'both' | 'recipient';

export const RECIPIENT_ONLY_EVENT_TYPES = new Set([
  'execution.risk_acknowledged',
  'execution.command_requested',
  'execution.command.cancel_requested',
  'execution.capability_mismatch',
]);

export function getTimelineEventAudience(eventType: string): TimelineEventAudience {
  return RECIPIENT_ONLY_EVENT_TYPES.has(eventType) ? 'recipient' : 'both';
}

/**
 * 발신자에게 나가는 실행 실패 사유를 정제한다.
 * 데몬의 독립 게이트 검증 실패(capability_mismatch) 등 구조화 JSON이나 에이전트 능력 정찰 정보가
 * 실려 나가지 않도록 안전한 일반 문구로 마스킹한다.
 */
export function sanitizeFailureReasonForSender(reason?: string | null): string | null {
  if (!reason) return reason ?? null;
  if (
    reason.includes('execution.capability_mismatch') ||
    reason.includes('localRequiredKeys') ||
    reason.includes('serverApprovedKeys')
  ) {
    return '에이전트 보안 정책 불일치로 실행 실패';
  }
  // 구조화 JSON 형태인 경우 내부 에이전트 환경 정보 은닉
  try {
    const parsed = JSON.parse(reason);
    if (parsed && typeof parsed === 'object') {
      return '에이전트 실행 실패';
    }
  } catch {
    // 일반 텍스트 사유는 유지
  }
  return reason;
}

type ExecutionLike = {
  additionalInstruction?: unknown;
  agentCapabilitiesSnapshot?: unknown;
  acknowledgedRisks?: unknown;
  riskAcknowledgedAt?: unknown;
  riskAcknowledgedByUserId?: unknown;
  claudeSessionId?: unknown;
  projectId?: unknown;
  failureReason?: unknown;
  agent?: unknown;
};

export function redactExecutionForSender<T extends ExecutionLike>(execution: T) {
  const { agent, ...rest } = execution as Record<string, any>;
  const redactedAgent =
    agent && typeof agent === 'object'
      ? {
          ...agent,
          provider: null,
          capabilities: null,
          deviceId: null,
          lastSeenAt: null,
        }
      : agent;

  return {
    ...rest,
    additionalInstruction: REDACTED,
    agentCapabilitiesSnapshot: null,
    acknowledgedRisks: null,
    riskAcknowledgedAt: null,
    riskAcknowledgedByUserId: null,
    claudeSessionId: null,
    projectId: REDACTED,
    failureReason: sanitizeFailureReasonForSender(rest.failureReason),
    failureCode: null,
    ...(agent ? { agent: redactedAgent } : {}),
    // 내용이 지워졌다는 사실 자체는 알려 준다. 웹이 "수신자 비공개"로 표시할 수 있다.
    additionalInstructionRedacted: true,
  };
}

type ResultLike = {
  id?: unknown;
  executionId?: unknown;
  kind?: unknown;
  reviewStatus?: unknown;
  disclosedArtifactId?: unknown;
  summary?: unknown;
  changedFiles?: unknown;
  testSummary?: unknown;
  artifactIds?: unknown;
  resultDocumentVersionId?: unknown;
};

/**
 * CLO-141: 발신자에게 나가는 실행 결과를 승인 전까지 가린다.
 *
 * **이건 새 제약이 아니라 지금까지 빠져 있던 것이다.** `detail()` 은 `results`·`result`·
 * `latestResult` 를 그대로 내보내고 있었고, `redactExecutionForSender` 는 Execution 의
 * 필드만 지워서 그 안에 실린 `execution.result` 는 통과했다. 가리고 있던 것은 웹 UI 뿐이라
 * 요청자가 API 응답에서 승인 전 결과 전문을 읽을 수 있었다(2026-09-21 확인).
 *
 * 이걸 닫지 않으면 "반려할 때 체크한 경우에만 result.md 를 공개한다"는 기능 자체가
 * 의미가 없다 — 체크하지 않아도 이미 다 보이기 때문이다.
 *
 * 남기는 것: 결과가 존재한다는 사실과 검토 상태. 요청자 화면이 "수신자가 검토 중"을
 * 그리려면 그만큼은 있어야 한다.
 * 지우는 것: `summary`(에이전트가 쓴 작업 내용), `changedFiles`(실행자 컴퓨터의 경로),
 * `testSummary`, `artifactIds`(patch·stream 접근 경로), `resultDocumentVersionId`.
 */
export function redactResultForSender<T extends ResultLike>(result: T) {
  // 승인해 전달한 결과는 요청자의 것이다. 그대로 보여 준다.
  if (result.reviewStatus === 'APPROVED') return result;
  const disclosed = typeof result.disclosedArtifactId === 'string' && result.disclosedArtifactId;
  return {
    ...result,
    summary: REDACTED,
    changedFiles: [],
    testSummary: null,
    // 반려하며 연 result.md 한 건만 남긴다. patch·stream 은 여기 오지 않는다.
    artifactIds: disclosed ? [result.disclosedArtifactId] : [],
    resultDocumentVersionId: null,
    // 지워졌다는 사실 자체는 알려 준다. 웹이 "승인 전에는 비공개"로 표시할 수 있다.
    resultRedacted: true,
  };
}

const INSTRUCTION_EVENT_TYPES = new Set([
  'execution.command_requested',
  'execution.follow_up_requested',
]);

type TimelineEventLike = { eventType: string; payload: unknown };

export function redactTimelineEventForSender<T extends TimelineEventLike>(event: T) {
  // CLO-20: 원본 요청자에게는 하위 요청이 있다는 사실과 받는 팀만 보인다(하위 요청 id·결과 id 는 가린다).
  if (event.eventType === 'request.delegated' || event.eventType === 'request.child_completed') {
    const payload = event.payload && typeof event.payload === 'object' ? (event.payload as Record<string, unknown>) : {};
    return { ...event, payload: payload.recipientTeamId ? { recipientTeamId: payload.recipientTeamId } : {} };
  }
  if (event.eventType === 'execution.failed') {
    const payload = event.payload;
    if (!payload || typeof payload !== 'object') return event;
    const { reason, ...rest } = payload as Record<string, unknown>;
    return {
      ...event,
      payload: {
        ...rest,
        reason: sanitizeFailureReasonForSender(typeof reason === 'string' ? reason : null),
      },
    };
  }

  if (!INSTRUCTION_EVENT_TYPES.has(event.eventType)) return event;
  const payload = event.payload;
  if (!payload || typeof payload !== 'object') return event;
  const { additionalInstruction, followUpInstruction, previousWork, ...rest } = payload as Record<
    string,
    unknown
  >;
  if (additionalInstruction === undefined && followUpInstruction === undefined && previousWork === undefined) return event;
  return {
    ...event,
    payload: {
      ...rest,
      ...(additionalInstruction === undefined ? {} : { additionalInstruction: REDACTED }),
      ...(followUpInstruction === undefined ? {} : { followUpInstruction: REDACTED }),
      additionalInstructionRedacted: true,
    },
  };
}

export function filterAndRedactTimelineEventsForSender<T extends TimelineEventLike>(
  events: T[],
  senderOnly: boolean,
): Array<T & { audience: TimelineEventAudience }> {
  return events
    .map((e) => ({
      ...e,
      audience: getTimelineEventAudience(e.eventType),
    }))
    .filter((e) => !senderOnly || e.audience !== 'recipient')
    .map((e) => (senderOnly ? redactTimelineEventForSender(e) : e));
}
