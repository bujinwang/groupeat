import { Restaurant, Review } from '@prisma/client';
import { RestaurantRepository } from '../repositories';
import { NotFoundError, ForbiddenError } from '../errors/AppError';
import { CreateRestaurantDto, ReviewDto, SearchRestaurantsQuery } from '../validators/restaurant.validator';

/**
 * Restaurant Service
 * Handles restaurant and review business logic
 */
export class RestaurantService {
  constructor(private restaurantRepository: RestaurantRepository) {}

  /**
   * Search restaurants
   */
  async searchRestaurants(query: SearchRestaurantsQuery): Promise<Restaurant[]> {
    return this.restaurantRepository.search({
      query: query.q,
      latitude: query.lat,
      longitude: query.lng,
      radius: query.radius,
      page: query.page,
      limit: query.limit
    });
  }

  /**
   * Get restaurant by ID
   */
  async getRestaurantById(id: string): Promise<any> {
    const restaurant = await this.restaurantRepository.findByIdWithDetails(id);
    if (!restaurant) {
      throw new NotFoundError('Restaurant');
    }

    // Calculate average rating
    const averageRating = await this.restaurantRepository.getAverageRating(id);

    return {
      ...restaurant,
      averageRating: averageRating ? parseFloat(averageRating.toFixed(1)) : null
    };
  }

  /**
   * Create a new restaurant
   */
  async createRestaurant(data: CreateRestaurantDto): Promise<Restaurant> {
    // Check if restaurant with same Google Place ID already exists
    if (data.googlePlaceId) {
      const existing = await this.restaurantRepository.findByGooglePlaceId(data.googlePlaceId);
      if (existing) {
        return existing; // Return existing restaurant instead of creating duplicate
      }
    }

    return this.restaurantRepository.create(data);
  }

  /**
   * Create or update a review
   */
  async upsertReview(userId: string, data: ReviewDto): Promise<Review> {
    // Check if restaurant exists
    const restaurant = await this.restaurantRepository.findById(data.restaurantId);
    if (!restaurant) {
      throw new NotFoundError('Restaurant');
    }

    return this.restaurantRepository.upsertReview({
      userId,
      restaurantId: data.restaurantId,
      rating: data.rating,
      comment: data.comment
    });
  }

  /**
   * Get user's review for a restaurant
   */
  async getUserReview(userId: string, restaurantId: string): Promise<Review | null> {
    return this.restaurantRepository.getUserReview(userId, restaurantId);
  }

  /**
   * Get restaurant reviews
   */
  async getRestaurantReviews(restaurantId: string, options: { page?: number; limit?: number } = {}) {
    // Check if restaurant exists
    const restaurant = await this.restaurantRepository.findById(restaurantId);
    if (!restaurant) {
      throw new NotFoundError('Restaurant');
    }

    return this.restaurantRepository.getReviews(restaurantId, options);
  }

  /**
   * Get restaurant posts
   */
  async getRestaurantPosts(restaurantId: string, options: { page?: number; limit?: number } = {}) {
    // Check if restaurant exists
    const restaurant = await this.restaurantRepository.findById(restaurantId);
    if (!restaurant) {
      throw new NotFoundError('Restaurant');
    }

    return this.restaurantRepository.getRestaurantPosts(restaurantId, options);
  }
}
