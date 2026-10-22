import { z } from 'zod';

export const CreateRequestSchema = z.object({
  senderTeamId: z.string().uuid(),
  recipientTeamId: z.string().uuid(),
  recipientUserId: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(300),
  originalInstruction: z.string().min(1).max(100000),
  documentVersionIds: z.array(z.string().uuid()).default([]),
  artifactIds: z.array(z.string().uuid()).default([]),
});
export const UpdateDraftSchema = CreateRequestSchema.pick({
  title: true,
  originalInstruction: true,
  documentVersionIds: true,
  artifactIds: true,
}).partial();
export const CreateRevisionSchema = CreateRequestSchema.pick({
  originalInstruction: true,
  documentVersionIds: true,
  artifactIds: true,
});
export const CreateDelegationSchema = z.object({
  recipientTeamId: z.string().uuid(),
  recipientUserId: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(300),
  instruction: z.string().min(1).max(100000),
  documentVersionIds: z.array(z.string().uuid()).default([]),
  artifactIds: z.array(z.string().uuid()).default([]),
  resultIds: z.array(z.string().uuid()).default([]),
});
export type CreateDelegation = z.infer<typeof CreateDelegationSchema>;
// CLO-141: 결과 검토에서 반려하면 실행자가 에이전트 결과(result.md)를 요청자에게 보여 줄지 고른다.
// **기본은 꺼짐**이다. 실행자 환경의 산출물은 승인 전까지 나가지 않는 것이 기본값이어야 한다.
// 수락 전(REVIEWING) 반려에는 결과 자체가 없어 이 값이 무시된다.
export const ReturnRequestSchema = z.object({
  reason: z.string().min(1).max(4000),
  discloseResult: z.boolean().default(false),
});
export const RejectRequestSchema = z.object({ reason: z.string().min(1).max(4000) });
// CLO-141: 결과 폐기. 요청은 살려 두고 실행 설정부터 다시 하므로 사유는 선택이다.
export const DiscardResultSchema = z
  .object({ reason: z.string().max(4000).optional() })
  .default({});
export type DiscardResult = z.infer<typeof DiscardResultSchema>;
export type CreateRequest = z.infer<typeof CreateRequestSchema>;
export type UpdateDraft = z.infer<typeof UpdateDraftSchema>;
export type CreateRevision = z.infer<typeof CreateRevisionSchema>;

export const ResendRequestSchema = z
  .object({
    reassign: z.enum(['same', 'team']).default('same'),
  })
  .default({});
export type ResendRequest = z.infer<typeof ResendRequestSchema>;

export const WithdrawRequestSchema = z.object({ reason: z.string().trim().max(500).optional() }).default({});
