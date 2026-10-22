export enum TimelineEventType {
  REQUEST_WITHDRAWN = 'request.withdrawn',
  EXECUTION_APPROVAL_REQUESTED = 'execution.approval_requested',
  EXECUTION_APPROVAL_DECIDED = 'execution.approval_decided',
  EXECUTION_FOLLOW_UP_REQUESTED = 'execution.follow_up_requested',
  // CLO-108: 강제할 수 없는 보호를 수신자가 항목별로 승인하고 실행을 시작했다.
  EXECUTION_RISK_ACKNOWLEDGED = 'execution.risk_acknowledged',
  EXECUTION_CANCELLED = 'execution.cancelled',
  EXECUTION_CANCEL_REQUESTED = 'execution.command.cancel_requested',
  REQUEST_CLAIMED = 'request.claimed',
  TEAM_CREATED = 'team.created',
  TEAM_UPDATED = 'team.updated',
  TEAM_DELETED = 'team.deleted',
  TEAM_LINK_CREATED = 'team.link_created',
  TEAM_LINK_REVOKED = 'team.link_revoked',
  TEAM_MEMBER_ADDED = 'team.member_added',
  TEAM_MEMBER_REMOVED = 'team.member_removed',
  DEVICE_PAIRED = 'device.paired',
  REQUEST_CREATED = 'request.created',
  REQUEST_DELEGATED = 'request.delegated',
  REQUEST_CHILD_COMPLETED = 'request.child_completed',
  REQUEST_SENT = 'request.sent',
  REQUEST_DELIVERED = 'request.delivered',
  REQUEST_VIEWED = 'request.viewed',
  REQUEST_REVIEW_STARTED = 'request.review_started',
  REQUEST_ACCEPTED = 'request.accepted',
  REQUEST_RETURNED = 'request.returned',
  REQUEST_REJECTED = 'request.rejected',
  REQUEST_REBROADCAST = 'request.rebroadcast',
  REQUEST_FOLLOWUP_SENT = 'request.followup_sent',
  REQUEST_RESENT = 'request.resent',
  REQUEST_READY_TO_RUN = 'request.ready_to_run',
  REQUEST_COMPLETED = 'request.completed',
  REQUEST_FAILED = 'request.failed',
  REQUEST_REVISION_CREATED = 'request.revision_created',
  DOCUMENT_CREATED = 'document.created',
  DOCUMENT_VERSION_CREATED = 'document.version_created',
  ARTIFACT_ATTACHED = 'artifact.attached',
  ARTIFACT_DETACHED = 'artifact.detached',
  EXECUTION_QUEUED = 'execution.queued',
  EXECUTION_COMMAND_REQUESTED = 'execution.command_requested',
  EXECUTION_STARTED = 'execution.started',
  EXECUTION_PROGRESS_REPORTED = 'execution.progress_reported',
  EXECUTION_FINISHED = 'execution.finished',
  EXECUTION_FAILED = 'execution.failed',
  RESULT_CREATED = 'result.created',
  // CLO-11: 취소된 회차의 부분 결과가 도착했을 때. 승인 대상이 아니다(FINAL 이 아닌 PARTIAL Result).
  RESULT_PARTIAL_REPORTED = 'result.partial_reported',
  RESULT_REVIEW_STARTED = 'result.review_started',
  RESULT_APPROVED = 'result.approved',
  RESULT_SENT = 'result.sent',
  // CLO-141: 결과를 버리고 실행 설정부터 다시 한다. payload 에 changedFiles 를 실어
  // "실행자 컴퓨터에 무엇이 남았는가"를 감사 기록으로 남긴다 — Baton 은 그 변경을 되돌리지 않는다.
  RESULT_DISCARDED = 'result.discarded',
  // CLO-141: 반려하면서 result.md 를 요청자에게 연 기록. 요청자도 봐야 하므로 audience='both' 다.
  RESULT_DISCLOSED_TO_SENDER = 'result.disclosed_to_sender',
  AGENT_REGISTERED = 'agent.registered',
  AGENT_STATUS_CHANGED = 'agent.status_changed',
  NOTIFICATION_CREATED = 'notification.created',
  NOTIFICATION_DELIVERED = 'notification.delivered',
}

export interface TimelineEvent {
  id: string;
  requestId: string | null;
  requestRevisionId: string | null;
  executionId: string | null;
  actorType: 'HUMAN' | 'DESKTOP_AGENT' | 'SERVER';
  actorUserId: string | null;
  agentId: string | null;
  eventType: TimelineEventType;
  occurredAt: Date;
  payload: Record<string, unknown>;
}
