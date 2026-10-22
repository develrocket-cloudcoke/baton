import { z } from 'zod';

export const APPROVAL_TTL_MS = 150_000;
export const APPROVAL_DETAIL_LIMIT = 2000;
export const CreateApprovalSchema = z.object({
  toolName: z.string().trim().min(1).max(80),
  // detail은 신뢰하지 않는 평문이다. 과대 입력을 거부하고 표시 길이는 서버에서 자른다.
  detail: z.string().max(100_000),
  reason: z.string().min(1).max(500),
});
export const ApprovalDecisionSchema = z.object({ decision: z.enum(['ALLOWED', 'DENIED']) });
export type CreateApproval = z.infer<typeof CreateApprovalSchema>;
export const truncateApprovalDetail = (detail: string): string =>
  detail.length > APPROVAL_DETAIL_LIMIT
    ? detail.slice(0, APPROVAL_DETAIL_LIMIT - 10) + '\n[내용 잘림]'
    : detail;
