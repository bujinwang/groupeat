import { DishPost, DishPostComment } from '@prisma/client';
import { DishPostRepository, GroupRepository, RestaurantRepository } from '../repositories';
import { NotFoundError, ForbiddenError, BadRequestError } from '../errors/AppError';
import { CreateDishPostDto, UpdateDishPostDto, CreateCommentDto } from '../validators/dishPost.validator';

/**
 * DishPost Service
 * Handles dish post, comment, and like business logic
 */
export class DishPostService {
  constructor(
    private dishPostRepository: DishPostRepository,
    private groupRepository: GroupRepository,
    private restaurantRepository: RestaurantRepository
  ) {}

  /**
   * Create a new dish post
   */
  async createPost(userId: string, data: CreateDishPostDto): Promise<any> {
    // Validate group membership if groupId is provided
    if (data.groupId) {
      const isMember = await this.groupRepository.isUserMember(data.groupId, userId);
      if (!isMember) {
        throw new ForbiddenError('You must be a member of the group to post');
      }
    }

    // Validate restaurant exists if restaurantId is provided
    if (data.restaurantId) {
      const restaurant = await this.restaurantRepository.findById(data.restaurantId);
      if (!restaurant) {
        throw new NotFoundError('Restaurant');
      }
    }

    // Create post
    const post = await this.dishPostRepository.create({
      userId,
      ...data
    });

    // Return post with details
    return this.dishPostRepository.findByIdWithDetails(post.id);
  }

  /**
   * Get community feed (public posts)
   */
  async getCommunityFeed(userId: string, options: { page?: number; limit?: number } = {}) {
    const posts = await this.dishPostRepository.getCommunityFeed({
      ...options,
      userId
    });

    // Process posts to handle anonymization and likes
    return posts.map(post => {
      const isLiked = post.likes.some(like => like.userId === userId);
      const displayUser = post.anonymizeInCommunity
        ? { id: post.user.id, name: 'Anonymous User' }
        : post.user;

      return {
        ...post,
        user: displayUser,
        isLikedByCurrentUser: isLiked
      };
    });
  }

  /**
   * Get post by ID
   */
  async getPostById(postId: string, userId: string): Promise<any> {
    const post = await this.dishPostRepository.findByIdWithDetails(postId);
    if (!post) {
      throw new NotFoundError('Post');
    }

    // Check if post is public or user has access
    if (!post.isPublic && post.groupId) {
      const isMember = await this.groupRepository.isUserMember(post.groupId, userId);
      if (!isMember && post.userId !== userId) {
        throw new ForbiddenError('You do not have access to this post');
      }
    }

    const isLiked = post.likes.some(like => like.userId === userId);
    const displayUser = post.anonymizeInCommunity && post.isPublic
      ? { id: post.user.id, name: 'Anonymous User' }
      : post.user;

    return {
      ...post,
      user: displayUser,
      isLikedByCurrentUser: isLiked
    };
  }

  /**
   * Update post
   */
  async updatePost(postId: string, userId: string, data: UpdateDishPostDto): Promise<any> {
    // Check if post exists
    const post = await this.dishPostRepository.findById(postId);
    if (!post) {
      throw new NotFoundError('Post');
    }

    // Check if user owns the post
    if (post.userId !== userId) {
      throw new ForbiddenError('You can only update your own posts');
    }

    // Update post
    await this.dishPostRepository.update(postId, data);

    // Return updated post with details
    return this.dishPostRepository.findByIdWithDetails(postId);
  }

  /**
   * Delete post
   */
  async deletePost(postId: string, userId: string): Promise<void> {
    // Check if post exists
    const post = await this.dishPostRepository.findById(postId);
    if (!post) {
      throw new NotFoundError('Post');
    }

    // Check if user owns the post or is admin of the group
    let canDelete = post.userId === userId;

    if (!canDelete && post.groupId) {
      const isAdmin = await this.groupRepository.isUserAdmin(post.groupId, userId);
      canDelete = isAdmin;
    }

    if (!canDelete) {
      throw new ForbiddenError('You do not have permission to delete this post');
    }

    await this.dishPostRepository.delete(postId);
  }

  /**
   * Toggle like on a post
   */
  async toggleLike(postId: string, userId: string): Promise<{ liked: boolean; likeCount: number }> {
    // Check if post exists
    const post = await this.dishPostRepository.findById(postId);
    if (!post) {
      throw new NotFoundError('Post');
    }

    // Check if user has already liked
    const hasLiked = await this.dishPostRepository.hasUserLiked(postId, userId);

    if (hasLiked) {
      // Unlike
      await this.dishPostRepository.removeLike(postId, userId);
    } else {
      // Like
      await this.dishPostRepository.addLike(postId, userId);
    }

    // Get updated post to count likes
    const updatedPost = await this.dishPostRepository.findByIdWithDetails(postId);

    return {
      liked: !hasLiked,
      likeCount: updatedPost?._count.likes || 0
    };
  }

  /**
   * Add comment to post
   */
  async addComment(postId: string, userId: string, data: CreateCommentDto): Promise<any> {
    // Check if post exists
    const post = await this.dishPostRepository.findById(postId);
    if (!post) {
      throw new NotFoundError('Post');
    }

    // Check access if post is not public
    if (!post.isPublic && post.groupId) {
      const isMember = await this.groupRepository.isUserMember(post.groupId, userId);
      if (!isMember && post.userId !== userId) {
        throw new ForbiddenError('You do not have access to comment on this post');
      }
    }

    return this.dishPostRepository.createComment({
      postId,
      userId,
      text: data.text
    });
  }

  /**
   * Delete comment
   */
  async deleteComment(commentId: string, userId: string): Promise<void> {
    // Check if comment exists
    const comment = await this.dishPostRepository.findCommentById(commentId);
    if (!comment) {
      throw new NotFoundError('Comment');
    }

    // Check if user owns the comment or the post
    const isCommentOwner = comment.userId === userId;
    const isPostOwner = await this.dishPostRepository.isPostOwner(comment.postId, userId);

    if (!isCommentOwner && !isPostOwner) {
      throw new ForbiddenError('You do not have permission to delete this comment');
    }

    await this.dishPostRepository.deleteComment(commentId);
  }

  /**
   * Get post comments
   */
  async getPostComments(postId: string, userId: string, options: { page?: number; limit?: number } = {}) {
    // Check if post exists
    const post = await this.dishPostRepository.findById(postId);
    if (!post) {
      throw new NotFoundError('Post');
    }

    // Check access if post is not public
    if (!post.isPublic && post.groupId) {
      const isMember = await this.groupRepository.isUserMember(post.groupId, userId);
      if (!isMember && post.userId !== userId) {
        throw new ForbiddenError('You do not have access to view comments on this post');
      }
    }

    return this.dishPostRepository.getComments(postId, options);
  }

  /**
   * Get user's posts
   */
  async getUserPosts(userId: string, options: { page?: number; limit?: number } = {}) {
    return this.dishPostRepository.getUserPosts(userId, options);
  }
}
