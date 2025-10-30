import { z } from 'zod';

/**
 * Create dish post schema
 */
export const CreateDishPostSchema = z.object({
  groupId: z.string().uuid('Invalid group ID format').optional(),
  restaurantId: z.string().uuid('Invalid restaurant ID format').optional(),
  caption: z.string().max(1000, 'Caption too long').trim().optional(),
  dishName: z.string().max(200, 'Dish name too long').trim().optional(),
  photoUrls: z.array(z.string().url('Invalid photo URL')).min(1, 'At least one photo is required'),
  rating: z.number().int().min(1, 'Rating must be at least 1').max(5, 'Rating must be at most 5').optional(),
  isPublic: z.boolean().default(false),
  anonymizeInCommunity: z.boolean().default(false)
});

export type CreateDishPostDto = z.infer<typeof CreateDishPostSchema>;

/**
 * Update dish post schema
 */
export const UpdateDishPostSchema = z.object({
  caption: z.string().max(1000, 'Caption too long').trim().optional(),
  dishName: z.string().max(200, 'Dish name too long').trim().optional(),
  rating: z.number().int().min(1).max(5).optional(),
  isPublic: z.boolean().optional()
});

export type UpdateDishPostDto = z.infer<typeof UpdateDishPostSchema>;

/**
 * Post ID parameter schema
 */
export const PostIdParamSchema = z.object({
  postId: z.string().uuid('Invalid post ID format')
});

export type PostIdParam = z.infer<typeof PostIdParamSchema>;

/**
 * Get posts query schema
 */
export const GetPostsQuerySchema = z.object({
  page: z.string().regex(/^\d+$/).transform(Number).default('1'),
  limit: z.string().regex(/^\d+$/).transform(Number).default('20'),
  groupId: z.string().uuid().optional(),
  restaurantId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  sort: z.enum(['latest', 'popular'], {
    errorMap: () => ({ message: 'Invalid sort option' })
  }).default('latest')
});

export type GetPostsQuery = z.infer<typeof GetPostsQuerySchema>;

/**
 * Create comment schema
 */
export const CreateCommentSchema = z.object({
  text: z.string().min(1, 'Comment text is required').max(500, 'Comment too long').trim()
});

export type CreateCommentDto = z.infer<typeof CreateCommentSchema>;

/**
 * Comment ID parameter schema
 */
export const CommentIdParamSchema = z.object({
  commentId: z.string().uuid('Invalid comment ID format')
});

export type CommentIdParam = z.infer<typeof CommentIdParamSchema>;
