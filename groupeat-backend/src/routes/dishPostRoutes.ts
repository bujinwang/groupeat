import { Router, Response, NextFunction, RequestHandler } from 'express';
import { PrismaClient } from '../../node_modules/.prisma/client'; // Direct path
import { protect, AuthenticatedRequest } from '../middleware/authMiddleware';

const router = Router();
const prisma = new PrismaClient();

// POST /posts - Create a new dish post
const createDishPostHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const {
      groupId,      // Optional: ID of the group to share with
      restaurantId, // Optional: ID of the restaurant associated
      caption,
      dishName,
      photoUrls,    // Expecting an array of image URLs (client handles upload, sends URLs)
      rating,       // Optional: dish rating
      isPublic,     // Boolean: share with community
      anonymizeInCommunity // Boolean: hide user name in community feed
    } = req.body;

    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ message: 'User not authenticated' });
      return;
    }
    if (!photoUrls || !Array.isArray(photoUrls) || photoUrls.length === 0) {
      res.status(400).json({ message: 'At least one photo URL is required' });
      return;
    }

    // Validate group membership if groupId is provided
    if (groupId) {
      const member = await prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId, userId } }
      });
      if (!member || member.status !== 'ACCEPTED') {
        res.status(403).json({ message: 'User is not a member of the specified group or membership not active.' });
        return;
      }
    }
    
    // Validate restaurantId if provided (optional check, depends on if we want to enforce it)
    if (restaurantId) {
        const restaurantExists = await prisma.restaurant.findUnique({ where: { id: restaurantId }});
        if (!restaurantExists) {
            res.status(400).json({ message: 'Specified restaurant does not exist.'});
            return;
        }
    }

    const newDishPost = await prisma.dishPost.create({
      data: {
        userId,
        groupId: groupId || null,
        restaurantId: restaurantId || null,
        caption: caption || null,
        dishName: dishName || null,
        photoUrls,
        rating: rating ? parseInt(rating, 10) : null,
        isPublic: isPublic || false,
        anonymizeInCommunity: anonymizeInCommunity || false,
      },
      include: { // Include user details for immediate feedback, can be customized
        user: { select: { id: true, name: true } }
      }
    });

    res.status(201).json(newDishPost);
    return;

  } catch (error) {
    console.error('Error creating dish post:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Internal server error' });
      return;
    }
  }
};
router.post('/', protect, createDishPostHandler as RequestHandler);

// GET /posts - Community Feed: Get public dish posts
const getCommunityDishPostsHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.id; // To check for 'isLikedByCurrentUser'
    // TODO: Add pagination (e.g., ?page=1&limit=10)
    // TODO: Add sorting options (e.g., ?sortBy=latest, ?sortBy=restaurantActivity)

    const posts = await prisma.dishPost.findMany({
      where: { 
        isPublic: true, // Only public posts
        // Optionally filter out posts from blocked users if that feature exists
      },
      orderBy: { 
        createdAt: 'desc' // Default sort: latest posts first
        // For "latest visited restaurant": This is complex.
        // One way: if posts are linked to restaurants, and restaurants have a lastActivityAt field updated by new posts.
        // Or, if a restaurant is "featured" based on recent activity.
        // For now, simple latest posts.
      },
      include: {
        user: { 
          select: { id: true, name: true } // Select only necessary, non-sensitive fields
        },
        restaurant: { // If we want to show restaurant info
            select: { id: true, name: true, address: true }
        },
        likes: { select: { userId: true } },
        _count: { select: { comments: true, likes: true } }
      }
    });

    const processedPosts = posts.map(post => {
      const { user, ...restOfPost } = post;
      return {
        ...restOfPost,
        user: post.anonymizeInCommunity ? { id: user.id, name: 'Anonymous User' } : user,
        isLikedByCurrentUser: userId ? post.likes.some(like => like.userId === userId) : false
      };
    });

    res.status(200).json(processedPosts);
    return;

  } catch (error) {
    console.error('Error fetching community dish posts:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Internal server error' });
      return;
    }
  }
};
// This route can be public or protected depending on if you want non-logged-in users to see the feed
// For now, let's make it public (remove 'protect') to allow browsing before login.
// If 'isLikedByCurrentUser' is important for non-logged-in, req.user.id check handles it.
router.get('/', getCommunityDishPostsHandler as RequestHandler);


// TODO: GET /groups/:groupId/posts (Group-specific feed) - This should be in groupRoutes.ts or a nested router
// TODO: GET /users/:userId/posts (User's own posts)
// TODO: GET /restaurants/:restaurantId/posts (Posts for a specific restaurant)
// TODO: POST /posts/:postId/comments - Add a comment
// TODO: GET /posts/:postId/comments - Get comments for a post
// TODO: POST /posts/:postId/like - Like/unlike a post
// TODO: DELETE /posts/:postId - Delete a post (owner or admin)
// TODO: PUT /posts/:postId - Update a post (owner)


export default router;
