import { z } from 'zod';

/**
 * Update user preferences schema
 */
export const UpdatePreferencesSchema = z.object({
  favoriteCuisines: z.array(z.string()).optional(),
  dietaryRestrictions: z.array(z.string()).optional(),
  spiceLevel: z.enum(['none', 'mild', 'medium', 'hot', 'extra_hot'], {
    errorMap: () => ({ message: 'Invalid spice level' })
  }).optional(),
  preferredPriceRange: z.string().optional()
});

export type UpdatePreferencesDto = z.infer<typeof UpdatePreferencesSchema>;

/**
 * Update user profile schema
 */
export const UpdateProfileSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name too long').trim().optional(),
  avatarUrl: z.string().url('Invalid avatar URL').optional()
});

export type UpdateProfileDto = z.infer<typeof UpdateProfileSchema>;
