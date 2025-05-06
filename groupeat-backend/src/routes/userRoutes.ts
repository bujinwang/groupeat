import { Router, Response, NextFunction, RequestHandler } from 'express';
import { PrismaClient } from '../../node_modules/.prisma/client'; // Direct path
import { protect, AuthenticatedRequest } from '../middleware/authMiddleware';

const router = Router();
const prisma = new PrismaClient();

// GET /users/me - Get current user's profile (excluding sensitive info)
const getMyProfileHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ message: 'User not authenticated' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { // Select only the fields to expose
        id: true,
        email: true,
        name: true,
        createdAt: true,
        updatedAt: true,
        preferences: true // Include preferences
      }
    });

    if (!user) {
      res.status(404).json({ message: 'User not found' });
      return;
    }
    res.status(200).json(user);
    return;
  } catch (error) {
    console.error('Error fetching user profile:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Internal server error' });
      return;
    }
  }
};
router.get('/me', protect, getMyProfileHandler as RequestHandler);


// PUT /users/me/preferences - Create or Update current user's preferences
const upsertUserPreferencesHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.id;
    const { favoriteCuisines, dietaryRestrictions, spiceLevel, preferredPriceRange } = req.body;

    if (!userId) {
      res.status(401).json({ message: 'User not authenticated' });
      return;
    }

    // Basic validation (can be enhanced with Zod later)
    if (favoriteCuisines && !Array.isArray(favoriteCuisines)) {
        res.status(400).json({ message: 'favoriteCuisines must be an array' });
        return;
    }
    if (dietaryRestrictions && !Array.isArray(dietaryRestrictions)) {
        res.status(400).json({ message: 'dietaryRestrictions must be an array' });
        return;
    }

    const preferencesData = {
      favoriteCuisines: favoriteCuisines || [],
      dietaryRestrictions: dietaryRestrictions || [],
      spiceLevel: spiceLevel || null,
      preferredPriceRange: preferredPriceRange || null,
    };

    const updatedPreferences = await prisma.userPreference.upsert({
      where: { userId: userId },
      update: {
        ...preferencesData,
        updatedAt: new Date(),
      },
      create: {
        userId: userId,
        ...preferencesData,
      },
    });

    res.status(200).json(updatedPreferences);
    return;
  } catch (error) {
    console.error('Error updating user preferences:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Internal server error' });
      return;
    }
  }
};
router.put('/me/preferences', protect, upsertUserPreferencesHandler as RequestHandler);

export default router;
