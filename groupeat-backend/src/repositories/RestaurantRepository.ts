import { PrismaClient, Restaurant, Review, DishPost, User } from '@prisma/client';
import { BaseRepository } from './BaseRepository';

export type RestaurantWithDetails = Restaurant & {
  reviews: (Review & { user: User })[];
  dishPosts: (DishPost & { user: User })[];
  _count: { reviews: number; dishPosts: number };
};

/**
 * Restaurant Repository
 * Handles all database operations related to restaurants
 */
export class RestaurantRepository extends BaseRepository<Restaurant> {
  constructor(prismaClient: PrismaClient) {
    super(prismaClient);
  }

  /**
   * Find restaurant by ID
   */
  async findById(id: string): Promise<Restaurant | null> {
    return this.prisma.restaurant.findUnique({
      where: { id }
    });
  }

  /**
   * Find restaurant by ID with details (reviews and posts)
   */
  async findByIdWithDetails(id: string): Promise<RestaurantWithDetails | null> {
    return this.prisma.restaurant.findUnique({
      where: { id },
      include: {
        reviews: {
          include: { user: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
          take: 5
        },
        dishPosts: {
          where: { isPublic: true },
          include: { user: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
          take: 3
        },
        _count: {
          select: { reviews: true, dishPosts: true }
        }
      }
    });
  }

  /**
   * Find restaurant by Google Place ID
   */
  async findByGooglePlaceId(googlePlaceId: string): Promise<Restaurant | null> {
    return this.prisma.restaurant.findUnique({
      where: { googlePlaceId }
    });
  }

  /**
   * Search restaurants
   */
  async search(options: {
    query?: string;
    latitude?: number;
    longitude?: number;
    radius?: number;
    page?: number;
    limit?: number;
  }): Promise<Restaurant[]> {
    const { query, page = 1, limit = 20 } = options;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (query) {
      where.OR = [
        { name: { contains: query, mode: 'insensitive' } },
        { address: { contains: query, mode: 'insensitive' } }
      ];
    }

    // TODO: Add location-based filtering when we have lat/lng data
    // For now, just return by name/address

    return this.prisma.restaurant.findMany({
      where,
      skip,
      take: limit,
      orderBy: { name: 'asc' }
    });
  }

  /**
   * Create a new restaurant
   */
  async create(data: {
    name: string;
    address: string;
    latitude?: number;
    longitude?: number;
    googlePlaceId?: string;
  }): Promise<Restaurant> {
    return this.prisma.restaurant.create({
      data
    });
  }

  /**
   * Update restaurant
   */
  async update(id: string, data: {
    name?: string;
    address?: string;
    latitude?: number;
    longitude?: number;
  }): Promise<Restaurant> {
    return this.prisma.restaurant.update({
      where: { id },
      data
    });
  }

  /**
   * Delete restaurant
   */
  async delete(id: string): Promise<void> {
    await this.prisma.restaurant.delete({
      where: { id }
    });
  }

  /**
   * Create or update a review
   */
  async upsertReview(data: {
    userId: string;
    restaurantId: string;
    rating: number;
    comment?: string;
  }): Promise<Review> {
    return this.prisma.review.upsert({
      where: {
        userId_restaurantId: {
          userId: data.userId,
          restaurantId: data.restaurantId
        }
      },
      create: data,
      update: {
        rating: data.rating,
        comment: data.comment
      }
    });
  }

  /**
   * Get user's review for a restaurant
   */
  async getUserReview(userId: string, restaurantId: string): Promise<Review | null> {
    return this.prisma.review.findUnique({
      where: {
        userId_restaurantId: { userId, restaurantId }
      }
    });
  }

  /**
   * Get restaurant reviews
   */
  async getReviews(restaurantId: string, options: {
    page?: number;
    limit?: number;
  } = {}): Promise<(Review & { user: User })[]> {
    const page = options.page || 1;
    const limit = options.limit || 20;
    const skip = (page - 1) * limit;

    return this.prisma.review.findMany({
      where: { restaurantId },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit
    });
  }

  /**
   * Calculate average rating for a restaurant
   */
  async getAverageRating(restaurantId: string): Promise<number | null> {
    const result = await this.prisma.review.aggregate({
      where: { restaurantId },
      _avg: { rating: true }
    });

    return result._avg.rating;
  }

  /**
   * Get restaurant posts
   */
  async getRestaurantPosts(restaurantId: string, options: {
    page?: number;
    limit?: number;
  } = {}) {
    const page = options.page || 1;
    const limit = options.limit || 20;
    const skip = (page - 1) * limit;

    return this.prisma.dishPost.findMany({
      where: {
        restaurantId,
        isPublic: true
      },
      include: {
        user: { select: { id: true, name: true } },
        likes: { select: { userId: true } },
        _count: { select: { comments: true, likes: true } }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit
    });
  }
}
