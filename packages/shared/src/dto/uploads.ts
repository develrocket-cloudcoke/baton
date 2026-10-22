import { z } from 'zod';
export const CreateUploadSchema = z.object({
  teamId: z.string().uuid(),
  requestId: z.string().uuid().optional(),
  revisionId: z.string().uuid().optional(),
  kind: z.enum(['REQUEST_ATTACHMENT', 'RESULT_ATTACHMENT', 'PATCH', 'TEST_OUTPUT']),
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
});
export type CreateUpload = z.infer<typeof CreateUploadSchema>;
