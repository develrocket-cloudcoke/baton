import { z } from 'zod';
export const CreateDocumentSchema = z.object({
  name: z.string().min(1).max(255),
  content: z.string().max(1000000),
  changeNote: z.string().max(4000).optional(),
});
export const CreateDocumentVersionSchema = z.object({
  content: z.string().max(1000000),
  changeNote: z.string().max(4000).optional(),
});
export type CreateDocument = z.infer<typeof CreateDocumentSchema>;
