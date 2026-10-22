import { z } from 'zod';
import { AgentProviderSchema, ExecutionCommandRequestedSchema } from '@baton/shared';

// 01 §5.4.1 구조화된 policy (F4). 서버가 일부만 보내면 기본값으로 채운다.
export const PolicySchema = z.object({
  git_write: z.enum(['deny', 'local', 'push']).default('deny'),
  approval_mode: z.enum(['deny', 'ask']).optional(),
  repository_edit: z.enum(['allow', 'deny']).default('allow'),
  deployment_apply: z.enum(['allow', 'deny']).default('deny'),
  network_outbound: z.enum(['allow', 'deny']).default('deny'),
  outside_write: z.enum(['allow', 'deny']).default('deny'),
  shell_execution: z.enum(['allow', 'deny', 'read_only']).default('allow')
});
export type Policy = z.infer<typeof PolicySchema>;

export const AttachmentSchema = z.object({
  id: z.string().optional(),
  filename: z.string().min(1),
  mimeType: z.string().optional(),
  // 서버는 상대 경로(`/v1/documents/versions/<id>/download`, `/v1/artifacts/<id>`)를 준다. ApiClient.download 가 base 에 붙인다.
  downloadUrl: z.string().min(1),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  kind: z.enum(['document', 'attachment']).default('attachment')
});
export type Attachment = z.infer<typeof AttachmentSchema>;

// 서버 SSE `execution.command.requested` payload.
// packages/shared 의 ExecutionCommandRequestedSchema(필수 id 들) + 01 §5.4 의 instruction/attachments/policy 확장.
// 서버(W1b)가 아직 확장 필드를 보내지 않으면 instruction 은 비어 있고 데몬은 그 사실을 프롬프트에 적는다.
export const ExecutionCommandSchema = ExecutionCommandRequestedSchema.extend({
  provider: AgentProviderSchema.optional(),
  teamId: z.string().optional(),
  title: z.string().optional(),
  senderName: z.string().optional(),
  originalInstruction: z.string().optional(),
  additionalInstruction: z.string().optional(),
  attachments: z.array(AttachmentSchema).default([]),
  policy: PolicySchema.default({}),
  webUrl: z.string().optional(),
  // 기획서 §18 결과 검토의 "추가 작업 요청" (서버 CLO-8a 와 합의한 계약).
  // followUpInstruction 만 이번 회차의 지시이고, 원본 요청·첨부는 resume 대상 세션이 이미 갖고 있다.
  // resumeSessionId 가 있으면 Adapter 가 `claude --resume <세션id>` 로 이어 실행한다(없으면 기존 새 실행).
  followUpInstruction: z.string().nullable().optional(),
  previousWork: z.string().optional(),
  resumeSessionId: z.string().nullable().optional(),
  // 실행 준비 화면에서 사람이 고른 모델. 없으면 데몬 기본값 → CLI 기본값 순으로 떨어진다.
  model: z.string().min(1).max(200).nullable().optional().transform((v) => v ?? undefined),
  limits: z.object({ maxTurns: z.number().int().positive().optional(), maxBudgetUsd: z.number().positive().optional() }).optional(),
  claudeSessionId: z.string().uuid().optional()
});
export type ExecutionCommand = z.infer<typeof ExecutionCommandSchema>;

// 05 §3.2 팀 전체 뿌리기: recipientTeam 이 있고 recipientUserId 가 명시적으로 null 이면 팀원 전원에게 온 요청이다.
// 서버(W5b)는 recipientTeam `{ id, name }` 을 항상 넣고 사람 지정이면 recipientUserId 에 그 사람 id 를 넣는다.
// recipientTeam 은 팀 이름 문자열도 허용한다(fake-server·구버전 호환).
export const TeamRefSchema = z.union([z.object({ id: z.string().optional(), name: z.string().min(1) }), z.string().min(1)]);
export type TeamRef = z.infer<typeof TeamRefSchema>;
export function teamName(ref: TeamRef | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.name;
}

export const RequestNotifyEventSchema = z.object({
  followup: z.boolean().optional(),
  eventName: z.literal('request.delivered').or(z.string()),
  requestId: z.string(),
  title: z.string().optional(),
  senderName: z.string().optional(),
  senderTeam: TeamRefSchema.nullable().optional(),
  recipientTeam: TeamRefSchema.nullable().optional(),
  recipientUserId: z.string().nullable().optional(),
  webUrl: z.string().nullable().optional()
});
export type RequestNotifyEvent = z.infer<typeof RequestNotifyEventSchema>;

// 05 §3.2 claim: 팀원 누군가가 먼저 처리(수락·반려·거절)하면 나머지 팀원 디바이스에 온다.
// 확정 계약(05 §3.2, W5d-2): claimedBy = `{ id, email, displayName }` (서버 publicPerson). `userId` 는 구버전 별칭, 문자열은 이름만.
// self 가 true 이거나 claimedBy.id 가 내 userId 면 본인이 처리한 것(서버는 본인에게 보내지 않으므로 방어용).
export const UserRefSchema = z.union([z.object({ id: z.string().nullable().optional(), userId: z.string().nullable().optional(), email: z.string().nullable().optional(), displayName: z.string().min(1) }), z.string().min(1)]);
export type UserRef = z.infer<typeof UserRefSchema>;
export function userDisplayName(ref: UserRef): string {
  return typeof ref === 'string' ? ref : ref.displayName;
}
export function userRefId(ref: UserRef): string | null {
  return typeof ref === 'string' ? null : (ref.id ?? ref.userId ?? null);
}

export const RequestClaimedEventSchema = z.object({
  eventName: z.literal('request.claimed').or(z.string()),
  requestId: z.string(),
  title: z.string().optional(),
  claimedBy: UserRefSchema,
  claimedAt: z.string().optional(),
  self: z.boolean().optional(),
  webUrl: z.string().nullable().optional()
});
export type RequestClaimedEvent = z.infer<typeof RequestClaimedEventSchema>;

// 01 §5.4 `execution.command.cancel_requested` (packages/shared ExecutionCancelRequestedSchema).
// 서버는 취소 시점에 Execution 을 이미 CANCELLED 로 바꾸므로 데몬의 사후 보고는 실패할 수 있다(로그만 남긴다).
export const ExecutionCancelSchema = z.object({
  eventName: z.literal('execution.command.cancel_requested').or(z.string()),
  executionId: z.string().min(1),
  requestId: z.string().min(1).optional(),
  reason: z.string().optional()
});
export type ExecutionCancel = z.infer<typeof ExecutionCancelSchema>;

// 디바이스당 SSE 1개(서버 connections.ts). 새 데몬이 붙으면 서버가 기존 연결에 이 이벤트를 보내고 끊는다.
// 이 이벤트에는 `id:` 가 없으므로 lastEventId 를 올리지 않는다.
export const ConnectionReplacedSchema = z.object({
  reason: z.string().optional()
});
