import { AgentCapabilities, AgentProvider } from './agent-capabilities';
import type { AgentModels } from './agent-models';
export interface BaseEntity {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface User extends BaseEntity {
  email: string;
  displayName: string;
  status: 'ACTIVE' | 'DISABLED';
}

export interface Team extends BaseEntity {
  orgId: string;
  name: string;
  createdByUserId: string;
}

export interface TeamMembership {
  teamId: string;
  userId: string;
  role: 'TEAM_LEAD' | 'MEMBER';
  joinedAt: Date;
}

export interface Agent extends BaseEntity {
  ownerUserId: string;
  deviceId: string;
  provider: AgentProvider;
  capabilities?: AgentCapabilities | null;
  /** 데몬이 CLI 에서 읽어 보고한 모델 목록. 아직 보고 전이면 없다. */
  models?: AgentModels | null;
  displayName: string;
  status: 'ONLINE' | 'OFFLINE' | 'BUSY' | 'DISABLED';
  lastSeenAt: Date | null;
}

export interface Project extends BaseEntity {
  ownerUserId: string;
  agentId: string;
  displayName: string;
  localPathHint: string | null;
  status: 'ACTIVE' | 'DISABLED';
}

export interface RequestRevision extends BaseEntity {
  requestId: string;
  revisionNo: number;
  originalInstruction: string;
  documentVersionIds: string[];
  artifactIds: string[];
  createdByUserId: string;
  sentAt: Date | null;
}

export interface Document extends BaseEntity {
  teamId: string;
  ownerUserId: string;
  name: string;
  mimeType: 'text/markdown';
  currentVersionId: string | null;
}

export interface DocumentVersion extends BaseEntity {
  documentId: string;
  versionNo: number;
  contentRef: string;
  contentSha256: string;
  createdByType: 'HUMAN' | 'AGENT';
  createdByUserId: string | null;
  createdByAgentId: string | null;
  changeNote: string | null;
}

export interface Artifact extends BaseEntity {
  teamId: string;
  ownerUserId: string;
  requestId: string | null;
  kind: 'REQUEST_ATTACHMENT' | 'RESULT_ATTACHMENT' | 'PATCH' | 'TEST_OUTPUT';
  filename: string;
  mimeType: string;
  storageRef: string;
  sha256: string;
  sizeBytes: number;
}

export interface Execution extends BaseEntity {
  claudeSessionId?: string | null;
  previousExecutionId?: string | null;
  requestId: string;
  requestRevisionId: string;
  executorUserId: string;
  agentId: string;
  projectId: string;
  additionalInstruction: string;
  /** 사람이 고른 모델. null 이면 데몬 기본값 → CLI 기본값 */
  model?: string | null;
  effectiveInstructionRef: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  startedAt: Date | null;
  finishedAt: Date | null;
  failureReason: string | null;
  failureCode?: string | null;
}

export interface Result extends BaseEntity {
  kind?: 'FINAL' | 'PARTIAL';
  executionId: string;
  summary: string;
  changedFiles: string[];
  testSummary: string | null;
  resultDocumentVersionId: string | null;
  artifactIds: string[];
  /**
   * 이 결과가 채택됐는가만 답한다. **왜** 그렇게 됐는지는 요청 상태와 타임라인이 말한다.
   * - PENDING: 아직 결정 전
   * - APPROVED: 승인해 요청자에게 전달했다
   * - CHANGES_REQUESTED: 채택하지 않고 요청자에게 보완을 요구했다(결과 검토에서 반려)
   * - DISCARDED: 채택하지 않고 버렸다(거절로 종결, 또는 결과 폐기 후 재실행)
   */
  reviewStatus: 'PENDING' | 'APPROVED' | 'CHANGES_REQUESTED' | 'DISCARDED';
  reviewedByUserId: string | null;
  reviewedAt: Date | null;
  sentAt: Date | null;
  /**
   * CLO-141: 반려하면서 요청자에게 연 result.md 아티팩트 **정확히 하나**.
   * 실행자가 반려 화면에서 체크했을 때만 채워진다. patch·stream 은 여기 오지 않는다.
   */
  disclosedArtifactId?: string | null;
  disclosedAt?: Date | null;
  disclosedByUserId?: string | null;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdByUserId: string;
  createdAt: Date;
}
export interface OrgMembership {
  orgId: string;
  userId: string;
  role: 'ORG_ADMIN' | 'MEMBER';
  joinedAt: Date;
}
export interface TeamLink {
  id: string;
  orgId: string;
  fromTeamId: string;
  toTeamId: string;
  createdByUserId: string;
  createdAt: Date;
}
export interface PairingCode {
  id: string;
  userId: string;
  codeHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}
export interface Device extends BaseEntity {
  userId: string;
  name: string;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}
export interface Request extends BaseEntity {
  senderTeamId: string;
  recipientTeamId: string;
  senderUserId: string;
  recipientUserId: string | null;
  claimedAt: Date | null;
  title: string;
  state: import('./request-state').RequestState;
  currentRevisionNo: number;
  currentRevisionId: string | null;
  returnReason: string | null;
  acceptedAt: Date | null;
  completedAt: Date | null;
}
