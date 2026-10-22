import { z } from 'zod';

export enum OrgRole {
  ORG_ADMIN = 'ORG_ADMIN',
  MEMBER = 'MEMBER',
}
export enum TeamRole {
  TEAM_LEAD = 'TEAM_LEAD',
  MEMBER = 'MEMBER',
}
export const OrgRoleSchema = z.nativeEnum(OrgRole);
export const TeamRoleSchema = z.nativeEnum(TeamRole);
export const UpdateOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(120),
});
export const CreateTeamSchema = z.object({ name: z.string().trim().min(1).max(120) });
export const UpdateTeamSchema = CreateTeamSchema;
export const AddTeamMemberSchema = z.object({
  email: z
    .string()
    .email()
    .transform((value) => value.toLowerCase()),
  role: TeamRoleSchema.default(TeamRole.MEMBER),
});
export const RemoveTeamMemberSchema = z.object({
  email: z
    .string()
    .email()
    .transform((value) => value.toLowerCase()),
});
export const CreateOrgUserSchema = z.object({
  email: z
    .string()
    .email()
    .transform((value) => value.toLowerCase()),
  displayName: z.string().trim().min(1).max(120),
  temporaryPassword: z.string().min(8).max(72),
});
export const TeamLinkDirectionSchema = z.enum(['both', 'a-to-b', 'b-to-a']);
export type TeamLinkDirection = z.infer<typeof TeamLinkDirectionSchema>;
export const DeleteTeamLinkSchema = z
  .object({
    direction: TeamLinkDirectionSchema.default('both'),
  })
  .default({});
export const CreateTeamLinkSchema = z
  .object({
    direction: TeamLinkDirectionSchema.default('both'),
    teamAId: z.string().uuid(),
    teamBId: z.string().uuid(),
  })
  .refine((value) => value.teamAId !== value.teamBId, '서로 다른 팀을 선택하세요.');
export const PairingCodeResponseSchema = z.object({
  code: z.string(),
  expiresAt: z.string().datetime(),
});
export const RecipientsQuerySchema = z.object({ senderTeamId: z.string().uuid() });
export const RecipientsResponseSchema = z.object({
  teams: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      members: z.array(
        z.object({ id: z.string().uuid(), email: z.string().email(), displayName: z.string() }),
      ),
    }),
  ),
});
export type CreateTeam = z.infer<typeof CreateTeamSchema>;
export type UpdateTeam = z.infer<typeof UpdateTeamSchema>;
export type AddTeamMember = z.infer<typeof AddTeamMemberSchema>;
export type RemoveTeamMember = z.infer<typeof RemoveTeamMemberSchema>;
export type CreateOrgUser = z.infer<typeof CreateOrgUserSchema>;
export type CreateTeamLink = z.infer<typeof CreateTeamLinkSchema>;
export type PairingCodeResponse = z.infer<typeof PairingCodeResponseSchema>;
export type RecipientsResponse = z.infer<typeof RecipientsResponseSchema>;
