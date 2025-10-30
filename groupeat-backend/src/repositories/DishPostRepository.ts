import { PrismaClient, DishPost, DishPostComment, DishPostLike, User, Restaurant } from '@prisma/client';
import { BaseRepository } from './BaseRepository';

export type DishPostWithDetails = DishPost & {
  user: User;
  restaurant?: Restaurant | null;
  likes: DishPostLike[];
  comments?: (DishPostComment & { user: User })[];
  _count: { comments: number; likes: number };
};

export type CommentWithUser = DishPostComment & {
  user: User;
};

/**
 * DishPost Repository
 * Handles all database operations related to dish posts
 */
export class DishPostRepository extends BaseRepository<DishPost> {
  constructor(prismaClient: PrismaClient) {
    super(prismaClient);
  }

  /**
   * Find post by ID
   */
  async findById(id: string): Promise<DishPost | null> {
    return this.prisma.dishPost.findUnique({
      where: { id }
    });
  }

  /**
   * Find post by ID with details
   */
  async findByIdWithDetails(id: string): Promise<DishPostWithDetails | null> {
    return this.prisma.dishPost.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true } },
        restaurant: { select: { id: true, name: true, address: true } },
        likes: { select: { userId: true } },
        comments: {
          include: { user: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' }
        },
        _count: { select: { comments: true, likes: true } }
      }
    }) as Promise<DishPostWithDetails | null>;
  }

  /**
   * Create a new dish post
   */
  async create(data: {
    userId: string;
    groupId?: string;
    restaurantId?: string;
    caption?: string;
    dishName?: string;
    photoUrls: string[];
    rating?: number;
    isPublic?: boolean;
    anonymizeInCommunity?: boolean;
  }): Promise<DishPost> {
    return this.prisma.dishPost.create({
      data
    });
  }

  /**
   * Update post
   */
  async update(id: string, data: {
    caption?: string;
    dishName?: string;
    rating?: number;
    isPublic?: boolean;
  }): Promise<DishPost> {
    return this.prisma.dishPost.update({
      where: { id },
      data
    });
  }

  /**
   * Delete post
   */
  async delete(id: string): Promise<void> {
    await this.prisma.dishPost.delete({
      where: { id }
    });
  }

  /**
   * Get community feed (public posts)
   */
  async getCommunityFeed(options: {
    page?: number;
    limit?: number;
    userId?: string; // For checking if user liked
  } = {}): Promise<DishPostWithDetails[]> {
    const page = options.page || 1;
    const limit = options.limit || 20;
    const skip = (page - 1) * limit;

    return this.prisma.dishPost.findMany({
      where: { isPublic: true },
      include: {
        user: { select: { id: true, name: true } },
        restaurant: { select: { id: true, name: true, address: true } },
        likes: { select: { userId: true } },
        _count: { select: { comments: true, likes: true } }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit
    }) as Promise<DishPostWithDetails[]>;
  }

  /**
   * Get user's posts
   */
  async getUserPosts(userId: string, options: {
    page?: number;
    limit?: number;
  } = {}): Promise<DishPostWithDetails[]> {
    const page = options.page || 1;
    const limit = options.limit || 20;
    const skip = (page - 1) * limit;

    return this.prisma.dishPost.findMany({
      where: { userId },
      include: {
        user: { select: { id: true, name: true } },
        restaurant: { select: { id: true, name: true, address: true } },
        likes: { select: { userId: true } },
        _count: { select: { comments: true, likes: true } }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit
    }) as Promise<DishPostWithDetails[]>;
  }

  /**
   * Add a like to a post
   */
  async addLike(postId: string, userId: string): Promise<DishPostLike> {
    return this.prisma.dishPostLike.create({
      data: { postId, userId }
    });
  }

  /**
   * Remove a like from a post
   */
  async removeLike(postId: string, userId: string): Promise<void> {
    await this.prisma.dishPostLike.delete({
      where: {
        userId_postId: { userId, postId }
      }
    });
  }

  /**
   * Check if user liked a post
   */
  async hasUserLiked(postId: string, userId: string): Promise<boolean> {
    const like = await this.prisma.dishPostLike.findUnique({
      where: {
        userId_postId: { userId, postId }
      }
    });

    return !!like;
  }

  /**
   * Create a comment
   */
  async createComment(data: {
    postId: string;
    userId: string;
    text: string;
  }): Promise<CommentWithUser> {
    return this.prisma.dishPostComment.create({
      data,
      include: {
        user: { select: { id: true, name: true } }
      }
    });
  }

  /**
   * Delete a comment
   */
  async deleteComment(commentId: string): Promise<void> {
    await this.prisma.dishPostComment.delete({
      where: { id: commentId }
    });
  }

  /**
   * Get post comments
   */
  async getComments(postId: string, options: {
    page?: number;
    limit?: number;
  } = {}): Promise<CommentWithUser[]> {
    const page = options.page || 1;
    const limit = options.limit || 50;
    const skip = (page - 1) * limit;

    return this.prisma.dishPostComment.findMany({
      where: { postId },
      include: {
        user: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: 'asc' },
      skip,
      take: limit
    });
  }

  /**
   * Find comment by ID
   */
  async findCommentById(commentId: string): Promise<DishPostComment | null> {
    return this.prisma.dishPostComment.findUnique({
      where: { id: commentId }
    });
  }

  /**
   * Check if user owns the post
   */
  async isPostOwner(postId: string, userId: string): Promise<boolean> {
    const post = await this.prisma.dishPost.findUnique({
      where: { id: postId },
      select: { userId: true }
    });

    return post?.userId === userId;
  }

  /**
   * Check if user owns the comment
   */
  async isCommentOwner(commentId: string, userId: string): Promise<boolean> {
    const comment = await this.prisma.dishPostComment.findUnique({
      where: { id: commentId },
      select: { userId: true }
    });

    return comment?.userId === userId;
  }
}
