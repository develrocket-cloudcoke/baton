import { z } from 'zod';
import {
  ExecutionAttachmentSchema,
  ExecutionCommandRequestedSchema,
  ExecutionPolicySchema,
} from '../desktop-api';
import { UnenforceableProtectionKeySchema } from '../execution-risk';

export const CreateExecutionSchema = z.object({
  agentId: z.string().uuid(),
  projectId: z.string().uuid(),
  additionalInstruction: z.string().max(100000).default(''),
  followUpInstruction: z.string().trim().min(1).max(100000).optional(),
  // 실행 준비 화면에서 고른 모델. 없으면 데몬 기본값 → CLI 기본값 순으로 떨어진다.
  // 서버는 Agent 가 보고한 목록으로 막지 않는다 — 목록 밖 모델을 쓸 수도 있고,
  // 잘못된 이름은 CLI 가 거부해 FAILED 사유로 그대로 드러난다.
  model: z.string().trim().min(1).max(200).nullable().optional(),
  // 실행 준비 화면(F4 구조화 policy)에서 고른 값. 없으면 서버 기본값을 쓴다.
  policy: ExecutionPolicySchema.partial().optional(),
  // CLO-108: 이 Agent 가 강제할 수 없는 보호 항목의 키 배열. 서버가 계산한 목록과 정확히 일치해야 한다.
  // 뭉뚱그린 boolean 승인은 받지 않으므로 항목 키를 하나씩 적는다. 기본값(빈 배열)은 여전히 막힌다.
  acknowledgedRisks: z.array(UnenforceableProtectionKeySchema).max(20).default([]),
});

export const ExecutionStatusSchema = z.object({
  status: z.enum(['RUNNING', 'PROGRESS']),
  sessionId: z.string().trim().min(1).max(191).optional(),
  phase: z.string().max(200).optional(),
  message: z.string().max(2000).optional(),
});

export const ExecutionResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('SUCCEEDED'),
    summary: z.string().min(1).max(10000),
    changedFiles: z.array(z.string()).default([]),
    testSummary: z.string().max(10000).optional(),
    resultDocumentVersionId: z.string().uuid().optional(),
    artifactIds: z.array(z.string().uuid()).default([]),
  }),
  z.object({
    status: z.literal('FAILED'),
    failureReason: z.string().min(1).max(10000),
    failureCode: z.enum(['project_not_git', 'git_missing']).optional(),
  }),
]);

// 데스크톱 데몬이 받는 실행 명령의 서버측 전체 계약이다. 기존 기본 식별자는 유지한다.
export const ExecutionCommandSchema = ExecutionCommandRequestedSchema.extend({
  originalInstruction: z.string(),
  additionalInstruction: z.string(),
  policy: ExecutionPolicySchema,
  attachments: z.array(ExecutionAttachmentSchema),
});
export type ExecutionCommand = z.infer<typeof ExecutionCommandSchema>;

export const CancelledExecutionResultSchema = z.object({
  status: z.literal('CANCELLED'),
  summary: z.string().max(10000).default('취소된 실행의 부분 결과'),
  changedFiles: z.array(z.string()).default([]),
  artifactIds: z.array(z.string().uuid()).default([]),
});
export const ExecutionCompletionSchema = z.union([
  ExecutionResultSchema,
  CancelledExecutionResultSchema,
]);
