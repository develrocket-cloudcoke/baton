import { z } from 'zod';
import { AgentModelsSchema } from './agent-models';
import { AgentCapabilitiesSchema } from './agent-capabilities';

/// 사람이 손으로 옮겨 적는 값이라 하이픈 누락·소문자·앞뒤 공백이 흔하다. 발급 형식
/// (XXXX-XXXX)으로 되돌린 뒤 검사한다. 정규화가 없으면 하이픈만 빠져도 "요청 본문이
/// 올바르지 않습니다" 로 거부되는데, 입력한 사람 눈에는 코드가 맞아서 원인을 알 수 없다
/// (2026-09-18 테스터가 CYKXTYG8 로 입력해 막힘).
export const normalizePairingCode = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const raw = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : value.trim();
};
export const DevicePairRequestSchema = z.object({
  code: z.preprocess(normalizePairingCode, z.string().regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)),
  deviceName: z.string().min(1).max(120),
});
export type DevicePairRequest = z.infer<typeof DevicePairRequestSchema>;

export const DevicePairResponseSchema = z.object({
  deviceId: z.string().uuid(),
  deviceToken: z.string().min(1),
});
export type DevicePairResponse = z.infer<typeof DevicePairResponseSchema>;

export const ExecutionStatusReportSchema = z.object({
  status: z.enum(['RUNNING', 'PROGRESS', 'SUCCEEDED', 'FAILED']),
  sessionId: z.string().trim().min(1).max(191).optional(),
  message: z.string().max(2000).optional(),
});
export type ExecutionStatusReport = z.infer<typeof ExecutionStatusReportSchema>;

export const ExecutionResultReportSchema = z.object({
  summary: z.string().min(1).max(10000),
  changedFiles: z.array(z.string()).default([]),
  testSummary: z.string().max(10000).optional(),
  resultDocumentVersionId: z.string().uuid().optional(),
  artifactIds: z.array(z.string().uuid()).default([]),
});
export type ExecutionResultReport = z.infer<typeof ExecutionResultReportSchema>;

export const ExecutionPolicySchema = z.object({
  git_write: z.enum(['deny', 'local', 'push']).default('deny'),
  approval_mode: z.enum(['deny', 'ask']).default('deny'),
  repository_edit: z.enum(['allow', 'deny']).default('allow'),
  deployment_apply: z.enum(['allow', 'deny']).default('deny'),
  network_outbound: z.enum(['allow', 'deny']).default('deny'),
  outside_write: z.enum(['allow', 'deny']).default('deny'),
  shell_execution: z.enum(['allow', 'deny', 'read_only']).default('allow'),
});

export const ExecutionAttachmentSchema = z.object({
  id: z.string().uuid(),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  downloadUrl: z.string().min(1),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  kind: z.enum(['document', 'attachment']),
});

export const ExecutionCommandRequestedSchema = z.object({
  eventName: z.literal('execution.command.requested'),
  eventId: z.string().uuid(),
  executionId: z.string().uuid(),
  requestId: z.string().uuid(),
  requestRevisionId: z.string().uuid(),
  agentId: z.string().uuid(),
  projectId: z.string().uuid(),
  originalInstruction: z.string(),
  additionalInstruction: z.string(),
  followUpInstruction: z.string().optional(),
  previousWork: z.string().optional(),
  resumeSessionId: z.string().nullable().optional(),
  policy: ExecutionPolicySchema,
  attachments: z.array(ExecutionAttachmentSchema),
  acknowledgedRisks: z.array(z.string()).default([]),
  inheritedRiskKeys: z.array(z.string()).default([]),
});
export type ExecutionCommandRequestedEvent = z.infer<typeof ExecutionCommandRequestedSchema>;

export const DeviceMetadataSchema = z.object({
  platform: z.string().max(80).optional(),
  osVersion: z.string().max(120).optional(),
  appVersion: z.string().max(120).optional(),
  hostname: z.string().max(191).optional(),
});
export const DevicePairV2RequestSchema = DevicePairRequestSchema.merge(DeviceMetadataSchema);
export const DevicePairV2ResponseSchema = DevicePairResponseSchema.extend({
  userId: z.string().uuid(),
});
export const DesktopHeartbeatSchema = DeviceMetadataSchema;
export type DeviceMetadata = z.infer<typeof DeviceMetadataSchema>;
export const ExecutionCancelRequestedSchema = z.object({
  eventName: z.literal('execution.command.cancel_requested'),
  executionId: z.string().uuid(),
  requestId: z.string().uuid(),
});
export enum ExecutionLifecycleState {
  QUEUED = 'QUEUED',
  RUNNING = 'RUNNING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

// agentId 없는 구버전 heartbeat는 Device만 갱신한다.
export const AgentHeartbeatSchema = DesktopHeartbeatSchema.extend({
  agentId: z.string().uuid().optional(),
  capabilities: AgentCapabilitiesSchema.optional(),
  // 모델 목록은 CLI 가 느리게 주기도 해서(agy 실측 33초) 등록 뒤 heartbeat 로 따라온다.
  models: AgentModelsSchema.optional(),
}).refine(
  (body) => !body.capabilities || !!body.agentId,
  'capabilities 보고에는 agentId가 필요합니다.',
);
export type AgentHeartbeat = z.infer<typeof AgentHeartbeatSchema>;

/** 기기 토큰으로 조회하는 상단바 읽기 전용 목록. count는 20건 제한 전 전체 건수다. */
export interface DesktopInboxItem {
  id: string;
  title: string;
  state: string;
  role: 'recipient' | 'sender';
  reason: '확인 필요' | '실행 준비' | '결과 검토' | '실행 실패' | '보완 요청';
  teamName: string;
  updatedAt: string;
}
export interface DesktopInboxResponse {
  items: DesktopInboxItem[];
  count: number;
}
