import { Router, Response, NextFunction, RequestHandler } from 'express';
import { PrismaClient } from '../../node_modules/.prisma/client'; // Direct path
import { protect, AuthenticatedRequest } from '../middleware/authMiddleware'; // To get current user if they are already logged in

const router = Router();
const prisma = new PrismaClient();

// POST /invitations/accept - Accept an invitation using a token
const acceptInvitationHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { token } = req.body;
    const userIdAccepting = req.user?.id; // This user must be logged in to accept an invite to link to their account

    if (!userIdAccepting) {
      res.status(401).json({ message: 'User must be logged in to accept an invitation.' });
      return;
    }
    if (!token) {
      res.status(400).json({ message: 'Invitation token is required.' });
      return;
    }

    const invitation = await prisma.groupInvitation.findUnique({
      where: { token: token },
    });

    if (!invitation) {
      res.status(404).json({ message: 'Invitation not found or invalid token.' });
      return;
    }

    if (invitation.status !== 'PENDING') {
      res.status(400).json({ message: `Invitation is already ${invitation.status.toLowerCase()}.` });
      return;
    }

    if (new Date() > invitation.expiresAt) {
      // Optionally update status to EXPIRED
      await prisma.groupInvitation.update({
        where: { id: invitation.id },
        data: { status: 'EXPIRED' },
      });
      res.status(400).json({ message: 'Invitation has expired.' });
      return;
    }

    // Check if user is already a member of the group
    const existingMember = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: invitation.groupId, userId: userIdAccepting } },
    });

    if (existingMember) {
      // User is already a member, just update invitation status
      await prisma.groupInvitation.update({
        where: { id: invitation.id },
        data: { status: 'ACCEPTED' }, // Or perhaps a different status like 'ALREADY_MEMBER'
      });
      res.status(200).json({ message: 'User is already a member of this group.', member: existingMember });
      return;
    }

    // Add user to the group and update invitation
    const newMember = await prisma.groupMember.create({
      data: {
        groupId: invitation.groupId,
        userId: userIdAccepting,
        role: 'MEMBER', // Default role for invited users
        status: 'ACCEPTED',
        joinedAt: new Date(),
      },
    });

    await prisma.groupInvitation.update({
      where: { id: invitation.id },
      data: { status: 'ACCEPTED' },
    });

    res.status(200).json({ message: 'Invitation accepted successfully. User added to group.', member: newMember });
    return;

  } catch (error) {
    console.error('Error accepting invitation:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Internal server error' });
      return;
    }
  }
};
router.post('/accept', protect, acceptInvitationHandler as RequestHandler); // User must be logged in

// TODO: Maybe a GET /invitations/:token endpoint to view invitation details before accepting (if user is not logged in yet)

export default router;
