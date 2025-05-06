import { Router, Response, NextFunction, RequestHandler } from 'express';
import { PrismaClient } from '../../node_modules/.prisma/client'; // Direct path
import { protect, AuthenticatedRequest } from '../middleware/authMiddleware'; // Optional: if some restaurant actions need auth

const router = Router();
const prisma = new PrismaClient();

// GET /restaurants/:restaurantId - Get details for a specific restaurant
const getRestaurantByIdHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { restaurantId } = req.params;

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      include: {
        reviews: { // Include some recent reviews or aggregate rating
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: { user: { select: { id: true, name: true } } }
        },
        dishPosts: { // Include some recent dish posts for this restaurant
            where: { isPublic: true }, // Only public posts
            orderBy: { createdAt: 'desc'},
            take: 3,
            include: { user: { select: { id: true, name: true}}}
        },
        _count: {
          select: { reviews: true, dishPosts: true }
        }
      }
    });

    if (!restaurant) {
      res.status(404).json({ message: 'Restaurant not found' });
      return;
    }

    // Calculate average rating (can be done more efficiently with aggregate query if needed often)
    let averageRating = null;
    if (restaurant.reviews.length > 0) {
      const totalRating = restaurant.reviews.reduce((sum, review) => sum + review.rating, 0);
      averageRating = totalRating / restaurant.reviews.length;
    }
    
    // We might not want to send all review objects if we just sent the count and avg rating
    const responseRestaurant = {
        ...restaurant,
        averageRating: averageRating ? parseFloat(averageRating.toFixed(1)) : null,
        // reviews: undefined // Or a summary of reviews
    };


    res.status(200).json(responseRestaurant);
    return;
  } catch (error) {
    console.error('Error fetching restaurant by ID:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Internal server error' });
      return;
    }
  }
};
// This route can be public
router.get('/:restaurantId', getRestaurantByIdHandler as RequestHandler);

// TODO: GET /restaurants - List/search restaurants (with pagination, filtering, sorting)
// TODO: POST /restaurants - (Admin only or carefully managed) Create a new restaurant entry

export default router;
