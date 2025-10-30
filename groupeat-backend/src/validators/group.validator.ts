import { z } from 'zod';

/**
 * Create group schema
 */
export const CreateGroupSchema = z.object({
  name: z.string().min(1, 'Group name is required').max(100, 'Group name too long').trim(),
  description: z.string().max(500, 'Description too long').trim().optional(),
  avatarUrl: z.string().url('Invalid avatar URL').optional()
});

export type CreateGroupDto = z.infer<typeof CreateGroupSchema>;

/**
 * Update group schema
 */
export const UpdateGroupSchema = z.object({
  name: z.string().min(1, 'Group name is required').max(100, 'Group name too long').trim().optional(),
  description: z.string().max(500, 'Description too long').trim().optional(),
  avatarUrl: z.string().url('Invalid avatar URL').optional()
});

export type UpdateGroupDto = z.infer<typeof UpdateGroupSchema>;

/**
 * Group ID parameter schema
 */
export const GroupIdParamSchema = z.object({
  groupId: z.string().uuid('Invalid group ID format')
});

export type GroupIdParam = z.infer<typeof GroupIdParamSchema>;

/**
 * Add member to group schema
 */
export const AddMemberSchema = z.object({
  userId: z.string().uuid('Invalid user ID').optional(),
  email: z.string().email('Invalid email format').optional(),
  phone: z.string().regex(/^\+?[1-9]\d{1,14}$/, 'Invalid phone number format').optional()
}).refine(
  data => data.userId || data.email || data.phone,
  {
    message: 'At least one of userId, email, or phone must be provided'
  }
);

export type AddMemberDto = z.infer<typeof AddMemberSchema>;

/**
 * Update member role schema
 */
export const UpdateMemberRoleSchema = z.object({
  role: z.enum(['ADMIN', 'MEMBER'], {
    errorMap: () => ({ message: 'Role must be either ADMIN or MEMBER' })
  })
});

export type UpdateMemberRoleDto = z.infer<typeof UpdateMemberRoleSchema>;

/**
 * Member user ID parameter schema
 */
export const MemberUserIdParamSchema = z.object({
  groupId: z.string().uuid('Invalid group ID format'),
  memberUserIdToRemove: z.string().uuid('Invalid user ID format').optional(),
  memberUserIdToUpdate: z.string().uuid('Invalid user ID format').optional()
});

export type MemberUserIdParam = z.infer<typeof MemberUserIdParamSchema>;

/**
 * Accept invitation schema
 */
export const AcceptInvitationSchema = z.object({
  token: z.string().min(1, 'Invitation token is required')
});

export type AcceptInvitationDto = z.infer<typeof AcceptInvitationSchema>;

/**
 * Get groups query schema
 */
export const GetGroupsQuerySchema = z.object({
  page: z.string().regex(/^\d+$/).transform(Number).default('1'),
  limit: z.string().regex(/^\d+$/).transform(Number).default('20'),
  search: z.string().optional()
});

export type GetGroupsQuery = z.infer<typeof GetGroupsQuerySchema>;
