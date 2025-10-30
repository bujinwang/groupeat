import { z } from 'zod';

/**
 * Restaurant ID parameter schema
 */
export const RestaurantIdParamSchema = z.object({
  restaurantId: z.string().uuid('Invalid restaurant ID format')
});

export type RestaurantIdParam = z.infer<typeof RestaurantIdParamSchema>;

/**
 * Search restaurants query schema
 */
export const SearchRestaurantsQuerySchema = z.object({
  q: z.string().optional(), // Search query
  lat: z.string().regex(/^-?\d+\.?\d*$/).transform(Number).optional(), // Latitude
  lng: z.string().regex(/^-?\d+\.?\d*$/).transform(Number).optional(), // Longitude
  radius: z.string().regex(/^\d+\.?\d*$/).transform(Number).default('5'), // Radius in km
  cuisine: z.string().optional(),
  priceRange: z.string().regex(/^[1-4](-[1-4])?$/).optional(), // e.g., "1-3" or "2"
  minRating: z.string().regex(/^[1-5]$/).transform(Number).optional(),
  sort: z.enum(['rating', 'distance', 'name'], {
    errorMap: () => ({ message: 'Invalid sort option' })
  }).default('rating'),
  page: z.string().regex(/^\d+$/).transform(Number).default('1'),
  limit: z.string().regex(/^\d+$/).transform(Number).default('20')
});

export type SearchRestaurantsQuery = z.infer<typeof SearchRestaurantsQuerySchema>;

/**
 * Create restaurant schema
 */
export const CreateRestaurantSchema = z.object({
  name: z.string().min(1, 'Restaurant name is required').max(200, 'Name too long').trim(),
  address: z.string().min(1, 'Address is required').max(500, 'Address too long').trim(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  googlePlaceId: z.string().optional(),
  cuisine: z.string().optional(),
  priceRange: z.number().int().min(1).max(4).optional()
});

export type CreateRestaurantDto = z.infer<typeof CreateRestaurantSchema>;

/**
 * Create or update restaurant review schema
 */
export const ReviewSchema = z.object({
  restaurantId: z.string().uuid('Invalid restaurant ID format'),
  rating: z.number().int().min(1, 'Rating must be at least 1').max(5, 'Rating must be at most 5'),
  comment: z.string().max(1000, 'Comment too long').trim().optional()
});

export type ReviewDto = z.infer<typeof ReviewSchema>;
