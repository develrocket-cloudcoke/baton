import {
  RequestState,
  TransitionActor,
  TimelineEventType,
  User,
  Team,
  Agent,
  Project,
  RequestRevision,
  Document,
  DocumentVersion,
  Artifact,
  Execution as SharedExecution,
  Result,
  TimelineEvent as SharedTimelineEvent,
  UnenforceableProtectionKey,
  UnenforceableProtection,
  ExecutionRiskAcknowledgement,
  unenforceableProtections,
  acknowledgementMatches,
} from '@baton/shared';

export {
  RequestState,
  TransitionActor,
  TimelineEventType,
  unenforceableProtections,
  acknowledgementMatches,
};

export type TimelineEventAudience = 'both' | 'recipient';

export interface TimelineEvent extends SharedTimelineEvent {
  audience?: TimelineEventAudience;
  agentProvider?: string | null;
}

export type {
  User,
  Team,
  Agent,
  Project,
  RequestRevision,
  Document,
  DocumentVersion,
  Artifact,
  Result,
  UnenforceableProtectionKey,
  UnenforceableProtection,
  ExecutionRiskAcknowledgement,
};

export interface Execution extends SharedExecution {
  agent?: { provider?: string | null };
  acknowledgedRisks?: UnenforceableProtection[] | null;
  riskAcknowledgedAt?: string | Date | null;
  riskAcknowledgedByUserId?: string | null;
  agentCapabilitiesSnapshot?: unknown | null;
  additionalInstructionRedacted?: boolean;
}

/**
 * 05 §2.1 조직 및 권한 타입
 */
export type OrgRole = 'ORG_ADMIN' | 'MEMBER';
export type TeamRole = 'TEAM_LEAD' | 'MEMBER';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrgMembership {
  id: string;
  orgId: string;
  userId: string;
  role: OrgRole;
  joinedAt?: string;
  createdAt?: string;
  user?: User;
}

export interface TeamMembershipDetail {
  id?: string;
  teamId?: string;
  userId?: string;
  role: TeamRole;
  joinedAt?: string;
  createdAt?: string;
  user: {
    id: string;
    email: string;
    displayName: string;
    status?: string;
  };
}

export interface TeamWithMembers {
  id: string;
  name: string;
  orgId: string;
  createdByUserId?: string;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  membersCount?: number;
  members?: TeamMembershipDetail[];
  memberships?: TeamMembershipDetail[];
}

export type TeamLinkDirection = 'both' | 'a-to-b' | 'b-to-a';

export interface TeamLink {
  id: string;
  orgId?: string;
  fromTeamId: string;
  toTeamId: string;
  createdByUserId?: string;
  createdAt: string;
  fromTeam?: { id: string; name: string };
  toTeam?: { id: string; name: string };
  direction?: TeamLinkDirection;
}

export interface DeviceInfo {
  id: string;
  userId?: string;
  name: string;
  deviceFingerprint?: string;
  // 실서버(GET /v1/me/devices)가 주는 디바이스 metadata. 데몬이 pairing·heartbeat 로 보낸 값이다.
  hostname?: string | null;
  platform?: string;
  osVersion?: string;
  appVersion?: string;
  status?: 'ONLINE' | 'OFFLINE' | 'BUSY' | 'DISABLED';
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt?: string;
  revokedAt?: string | null;
}

export interface PairingCodeResponse {
  code: string;
  expiresAt: string;
  qrDataUrl?: string;
}

export interface UserMeTeam {
  id: string;
  name: string;
  orgId?: string;
  role: TeamRole;
  teamId?: string;
  teamName?: string;
}

export interface UserMeResponse {
  id: string;
  email: string;
  displayName: string;
  status?: string;
  organization: Organization | null;
  orgRole: OrgRole | null;
  teams: UserMeTeam[];
  orgMemberships?: any[];
  memberships?: any[];
  user?: {
    id: string;
    email: string;
    name: string;
    orgRole: OrgRole;
  };
  devices?: DeviceInfo[];
}

export interface RecipientMember {
  id: string;
  email: string;
  displayName: string;
  hasActiveDevice?: boolean;
}

export interface RecipientTeam {
  id: string;
  name: string;
  members: RecipientMember[];
  memberCount?: number;
}

export interface RecipientsResponse {
  teams: RecipientTeam[];
  senderTeamId?: string;
  usersByTeam?: Record<string, any[]>;
}

/** 요청에 함께 실려 오는 최소 사람 정보 (서버 publicPerson 과 같은 모양) */
export interface PublicPerson {
  id: string;
  email: string;
  displayName: string;
}

/**
 * 01 §2.3, §3.2, 05 §2.1 및 W5a/W5b 기반 Request 엔티티
 */
export interface RequestEntity {
  id: string;
  teamId?: string; // 레거시 호환
  senderTeamId: string;
  recipientTeamId: string;
  senderUserId: string;
  recipientUserId: string | null; // null이면 팀에 뿌리기(unclaimed)
  title: string;
  state: RequestState;
  isFollowup?: boolean;
  isDelegated?: boolean;
  currentRevisionNo: number;
  currentRevisionId: string;
  returnReason: string | null;
  claimedAt: string | null;
  acceptedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  senderTeam?: { id: string; name: string };
  recipientTeam?: { id: string; name: string };
  /** 서버가 함께 실어 보내는 사람 정보. 이름 표시는 이걸 먼저 쓴다 */
  sender?: PublicPerson | null;
  recipient?: PublicPerson | null;
  claimedBy?: PublicPerson | null;
  isBroadcast?: boolean;
}

/**
 * 01 §5.4.1 F4 구조화 Policy 스키마
 */
export interface StructuredPolicy {
  git_write: 'deny' | 'local' | 'push';
  repository_edit: 'allow' | 'deny';
  deployment_apply: 'deny' | 'allow';
  network_outbound: 'deny' | 'allow';
  outside_write: 'deny' | 'allow';
  shell_execution: 'allow' | 'deny' | 'read_only';
}

export const DEFAULT_STRUCTURED_POLICY: StructuredPolicy = {
  git_write: 'deny',
  repository_edit: 'allow',
  deployment_apply: 'deny',
  network_outbound: 'deny',
  outside_write: 'deny',
  shell_execution: 'allow',
};

/**
 * Request 상세 조회 종합 응답 DTO
 */
export interface RequestDetailResponse {
  request: RequestEntity;
  sender: User;
  recipient: User | null; // 미확정 시 null
  senderTeam?: Team;
  recipientTeam?: Team;
  currentRevision: RequestRevision;
  revisions: RequestRevision[];
  documents: Array<{
    document: Document;
    versions: DocumentVersion[];
    currentVersion: DocumentVersion | null;
    rawContent?: string;
  }>;
  artifacts: Artifact[];
  latestExecution: (Execution & { previousExecutionId?: string | null; followUpInstruction?: string | null }) | null;
  latestResult: Result | null;
  results?: Result[];
  executions?: (Execution & { previousExecutionId?: string | null; followUpInstruction?: string | null })[];
  timeline: TimelineEvent[];
  children?: DelegatedChildSummary[];
  parent?: DelegatedParentSummary | null;
}

export interface DelegatedChildSummary {
  id?: string;
  title?: string;
  recipientTeam: { id?: string; name: string };
  state: RequestState;
  latestApprovedResultSummary?: string | null;
}

export interface DelegatedParentSummary {
  id?: string;
  title: string;
  context?: {
    parentTitle?: string;
    parentInstruction?: string;
    parentResults?: Array<{ revisionNo: number; summary: string }>;
  } | null;
}

export interface CreateDelegationDto {
  recipientTeamId: string;
  recipientUserId?: string | null;
  title: string;
  instruction: string;
  documentVersionIds: string[];
  artifactIds: string[];
  resultIds: string[];
}

/**
 * 새 Request 생성 요청 DTO (05 §4.4)
 */
export interface CreateRequestDto {
  senderTeamId: string;
  recipientTeamId: string;
  recipientUserId?: string | null;
  title: string;
  originalInstruction: string;
  documentTitle?: string;
  documentContent?: string;
  attachments?: Array<{
    filename: string;
    sizeBytes: number;
    mimeType: string;
    /** 파일 실제 내용. 이게 그대로 에이전트에게 전달된다 */
    content: string;
  }>;
  autoSend?: boolean;
}

/**
 * 새 Revision 보완 재전송 요청 DTO
 */
export interface ResendRequestDto {
  followup?: boolean;
  originalInstruction?: string;
  documentTitle?: string;
  documentContent?: string;
  attachments?: Array<{
    filename: string;
    sizeBytes: number;
    mimeType: string;
    /** 파일 실제 내용. 이게 그대로 에이전트에게 전달된다 */
    content: string;
  }>;
  // CLO-19: 반려 후 보완 재전송 시 담당자 유지('same') 또는 팀 전체 재뿌리기('team')
  reassign?: 'same' | 'team';
}

/**
 * Agent 실행 생성 요청 DTO
 */
export interface CreateExecutionDto {
  agentId: string;
  projectId: string;
  additionalInstruction: string;
  followUpInstruction?: string;
  /** 고른 모델. null/생략이면 데몬 기본값 → CLI 기본값 */
  model?: string | null;
  /**
   * 생략하면 **서버가 자기 기본값을 적용한다**(`ExecutionPolicySchema` 의 default).
   * 클라이언트가 정책을 알 수 없을 때 기본값을 흉내 내 보내면, 서버 기본값이 바뀌어도
   * 옛 값이 그대로 실행 게이트에 들어간다. 모르면 보내지 않는 쪽이 맞다.
   */
  policy?: StructuredPolicy;
  acknowledgedRisks?: UnenforceableProtectionKey[];
}

export interface UnenforceableProtectionsErrorResponse {
  statusCode: 409;
  error: string;
  code: 'execution.unenforceable_protections';
  message: string;
  unenforceableProtections: UnenforceableProtection[];
  requiredAcknowledgements: UnenforceableProtectionKey[];
  acknowledgedRisks: UnenforceableProtectionKey[];
}

/**
 * Claude Code 진행 단계 (02 §4.2)
 */
export type ExecutionProgressPhase =
  | 'queued'
  | 'starting'
  | 'reading_input'
  | 'exploring'
  | 'editing'
  | 'testing'
  | 'test_passed'
  | 'writing_result'
  | 'completed'
  | 'failed';

export interface ExecutionApproval {
  id: string;
  executionId: string;
  toolName: string;
  detail: string;
  reason: string;
  status: 'PENDING' | 'ALLOWED' | 'DENIED' | 'EXPIRED';
  expiresAt: string;
}

/**
 * 조직 구성원 명부 항목 (GET /v1/org/members).
 * 관리자 전용 `/v1/org/users` 와 달리 멤버도 볼 수 있고, 읽기 전용이다.
 */
export interface OrgMember {
  id: string;
  email: string;
  displayName: string;
  status: 'ACTIVE' | 'DISABLED';
  orgRole: OrgRole;
  online: boolean;
  teams: Array<{ id: string; name: string; role: string }>;
}
