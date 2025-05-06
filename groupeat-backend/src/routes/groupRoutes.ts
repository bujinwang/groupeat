import { Router, Response, RequestHandler, NextFunction } from 'express';
import { PrismaClient } from '../../node_modules/.prisma/client'; // Direct path
import { protect, AuthenticatedRequest } from '../middleware/authMiddleware';

const router = Router();
const prisma = new PrismaClient();

// POST /groups - Create a new dining group
// Explicitly type the return as Promise<void> and add next
const createGroupHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, description, groupAvatarUrl } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ message: 'User not authenticated' });
      return;
    }
    if (!name) {
      res.status(400).json({ message: 'Group name is required' });
      return;
    }

    const newGroup = await prisma.diningGroup.create({
      data: {
        name,
        description: description || null,
        groupAvatarUrl: groupAvatarUrl || null,
        creatorId: userId,
      },
    });

    // Automatically add the creator as an ADMIN member of the group
    await prisma.groupMember.create({
      data: {
        groupId: newGroup.id,
        userId: userId,
        role: 'ADMIN',
        status: 'ACCEPTED', // Creator is automatically accepted
      }
    });

    res.status(201).json(newGroup);
    return; 
  } catch (error) {
    console.error('Error creating group:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Internal server error' });
      return; 
    }
  }
};
router.post('/', protect, createGroupHandler as RequestHandler);

// GET /groups - Get all dining groups for the authenticated user (where they are a member)
// Explicitly type the return as Promise<void> and add next
const getUserGroupsHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ message: 'User not authenticated' });
      return;
    }

    const groups = await prisma.diningGroup.findMany({
      where: {
        members: {
          some: {
            userId: userId,
            status: 'ACCEPTED', // Only include groups they are an accepted member of
          },
        },
      },
      include: { // Optionally include members or other details
        members: {
          include: {
            user: { select: { id: true, name: true, email: true } }
          }
        },
        _count: {
          select: { members: true }
        }
      }
    });
    res.status(200).json(groups);
    return; 
  } catch (error) {
    console.error('Error fetching groups:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Internal server error' });
      return; 
    }
  }
};
router.get('/', protect, getUserGroupsHandler as RequestHandler);

// GET /groups/:groupId - Get a specific dining group by ID
// Explicitly type the return as Promise<void> and add next
const getGroupByIdHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.id;
    const { groupId } = req.params;

    if (!userId) {
      res.status(401).json({ message: 'User not authenticated' });
      return;
    }

    const group = await prisma.diningGroup.findFirst({
      where: {
        id: groupId,
        members: {
          some: { userId: userId, status: 'ACCEPTED' } // Ensure user is a member
        }
      },
      include: {
        members: {
          include: {
            user: { select: { id: true, name: true, email: true } }
          }
        },
        creator: { select: { id: true, name: true, email: true } }
      }
    });

    if (!group) {
      res.status(404).json({ message: 'Group not found or user not a member' });
      return;
    }
    res.status(200).json(group);
    return; 
  } catch (error) {
    console.error('Error fetching group by ID:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Internal server error' });
      return; 
    }
  }
};
router.get('/:groupId', protect, getGroupByIdHandler as RequestHandler);

// PUT /groups/:groupId - Update a dining group
// Explicitly type the return as Promise<void> and add next
const updateGroupHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.id;
    const { groupId } = req.params;
    const { name, description, groupAvatarUrl } = req.body;

    if (!userId) {
      res.status(401).json({ message: 'User not authenticated' });
      return;
    }

    // Check if the user is an admin of the group
    const member = await prisma.groupMember.findFirst({
      where: {
        groupId: groupId,
        userId: userId,
        role: 'ADMIN',
        status: 'ACCEPTED',
      }
    });

    if (!member) {
      res.status(403).json({ message: 'User is not an admin of this group or not a member' });
      return;
    }

    const updatedGroup = await prisma.diningGroup.update({
      where: { id: groupId },
      data: {
        name: name || undefined, // Only update if provided
        description: description !== undefined ? description : undefined,
        groupAvatarUrl: groupAvatarUrl !== undefined ? groupAvatarUrl : undefined,
        updatedAt: new Date(),
      },
    });
    res.status(200).json(updatedGroup);
    return; 
  } catch (error) {
    console.error('Error updating group:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Internal server error' });
      return; 
    }
  }
};
router.put('/:groupId', protect, updateGroupHandler as RequestHandler);

// DELETE /groups/:groupId - Delete a dining group
// Explicitly type the return as Promise<void> and add next
const deleteGroupHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.id;
    const { groupId } = req.params;

    if (!userId) {
      res.status(401).json({ message: 'User not authenticated' });
      return;
    }

    // Ensure the user is the creator or an admin to delete
    // For simplicity, let's assume only the creator can delete for now, or an admin.
    // More complex logic can be added for admin deletion.
    const group = await prisma.diningGroup.findUnique({ where: { id: groupId } });
    if (!group) {
      res.status(404).json({ message: 'Group not found' });
      return;
    }

    const member = await prisma.groupMember.findFirst({
      where: {
        groupId: groupId,
        userId: userId,
        role: 'ADMIN', // Only admins can delete
        status: 'ACCEPTED',
      }
    });
    
    if (group.creatorId !== userId && !member) {
      res.status(403).json({ message: 'User is not authorized to delete this group' });
      return;
    }

    // Transaction to delete group members and then the group
    await prisma.$transaction(async (tx) => {
      await tx.groupInvitation.deleteMany({ where: { groupId: groupId }}); // Delete pending invitations
      await tx.groupMember.deleteMany({ where: { groupId: groupId } });
      await tx.diningGroup.delete({ where: { id: groupId } });
    });

    res.status(204).send(); // No content
    return; 
  } catch (error) {
    console.error('Error deleting group:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Internal server error' });
      return; 
    }
  }
};
router.delete('/:groupId', protect, deleteGroupHandler as RequestHandler);

// Nested route for posts within a group
// GET /groups/:groupId/posts - Get all dish posts for a specific group
const getGroupDishPostsHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { groupId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ message: 'User not authenticated' });
      return;
    }

    // Check if user is a member of the group to view its posts
    const member = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } }
    });
    if (!member || member.status !== 'ACCEPTED') {
      res.status(403).json({ message: 'User is not an accepted member of this group.' });
      return;
    }

    const posts = await prisma.dishPost.findMany({
      where: { groupId: groupId },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, name: true } }, // Author of the post
        likes: { select: { userId: true } }, // To quickly check if current user liked it, and count
        _count: { select: { comments: true, likes: true } }
      }
    });

    // Augment posts with isLikedByCurrentUser if needed on frontend
    const postsWithLikeStatus = posts.map(post => ({
      ...post,
      isLikedByCurrentUser: post.likes.some(like => like.userId === userId)
    }));


    res.status(200).json(postsWithLikeStatus);
    return;

  } catch (error) {
    console.error('Error fetching group dish posts:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Internal server error' });
      return;
    }
  }
};
router.get('/:groupId/posts', protect, getGroupDishPostsHandler as RequestHandler);

// POST /groups/:groupId/recommendations - Get AI-driven restaurant recommendations for the group
const getGroupRecommendationsHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { groupId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ message: 'User not authenticated' });
      return;
    }

    // 1. Verify user is a member of the group
    const member = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } }
    });
    if (!member || member.status !== 'ACCEPTED') {
      res.status(403).json({ message: 'User is not an accepted member of this group.' });
      return;
    }

    // 2. Fetch preferences for all members of the group
    const groupMembersWithPrefs = await prisma.groupMember.findMany({
      where: { groupId, status: 'ACCEPTED' },
      include: {
        user: {
          include: {
            preferences: true, // Include UserPreference
          }
        }
      }
    });

    const memberPreferences = groupMembersWithPrefs
      .map(m => m.user.preferences)
      .filter(p => p !== null); // Filter out members who haven't set preferences

    if (memberPreferences.length === 0) {
      res.status(400).json({ message: 'No members in this group have set their dining preferences yet.' });
      return;
    }
    
    // 3. Aggregate preferences (simple example: collect all favorite cuisines)
    const allFavoriteCuisines = memberPreferences.flatMap(p => p!.favoriteCuisines);
    const uniqueFavoriteCuisines = [...new Set(allFavoriteCuisines)];

    // 4. (Placeholder) Simple rule-based recommendation:
    // Find restaurants that have been reviewed positively and match some of the cuisines.
    // This is a very basic placeholder. Real AI integration would be more complex.
    
    let recommendedRestaurants: any[] = [];
    if (uniqueFavoriteCuisines.length > 0) {
        // This is a conceptual query. Actual implementation would depend on how restaurants are tagged with cuisines.
        // For now, let's assume we search DishPosts or Reviews that might mention these cuisines.
        // Or, if Restaurant model had a cuisine_type field.
        // This is a placeholder for a more complex recommendation logic.
        const potentialRestaurants = await prisma.restaurant.findMany({
            take: 5, // Limit results for now
            // where: { /* Some condition based on cuisines, reviews, etc. */ },
            include: {
                reviews: { orderBy: { rating: 'desc' }, take: 1 }, // Get top review
                _count: { select: { reviews: true }}
            }
        });
        recommendedRestaurants = potentialRestaurants.map(r => ({
            id: r.id,
            name: r.name,
            address: r.address,
            reason: `Potentially good for cuisines like: ${uniqueFavoriteCuisines.join(', ')}. Has ${r._count.reviews} review(s).`,
            topReviewComment: r.reviews[0]?.comment
        }));
    }


    if (recommendedRestaurants.length === 0) {
        res.status(200).json({ message: "Could not generate specific recommendations based on current preferences and data. Here are some general popular spots:", recommendations: [] });
        return;
    }
    
    res.status(200).json({
      message: "Here are some restaurant recommendations based on your group's preferences!",
      preferencesSummary: { uniqueFavoriteCuisines },
      recommendations: recommendedRestaurants
    });
    return;

  } catch (error) {
    console.error('Error generating group recommendations:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Internal server error' });
      return;
    }
  }
};
router.post('/:groupId/recommendations', protect, getGroupRecommendationsHandler as RequestHandler);


export default router;
