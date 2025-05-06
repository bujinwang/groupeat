import { Router, Response, NextFunction, RequestHandler } from 'express';
import { PrismaClient } from '../../node_modules/.prisma/client'; // Direct path
import crypto from 'crypto'; // Import crypto for token generation
import { protect, AuthenticatedRequest } from '../middleware/authMiddleware';
// We might need a service for sending SMS/email for non-app user invites later
// import { sendInvitation } from '../services/invitationService'; 

const router = Router({ mergeParams: true }); // mergeParams allows access to :groupId from parent router
const prisma = new PrismaClient();

// POST /groups/:groupId/members - Add a member to a group or invite a non-app user
const addMemberHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { groupId } = req.params;
    const { userIdToAdd, emailToInvite, phoneToInvite, nameToInvite, role } = req.body; // userId for existing app user, email/phone for non-app user
    const currentUserId = req.user?.id;

    if (!currentUserId) {
      res.status(401).json({ message: 'User not authenticated' });
      return;
    }

    // Check if current user is an ADMIN of the group
    const isAdmin = await prisma.groupMember.findFirst({
      where: { groupId, userId: currentUserId, role: 'ADMIN', status: 'ACCEPTED' }
    });
    if (!isAdmin) {
      res.status(403).json({ message: 'Only group admins can add members' });
      return;
    }

    if (userIdToAdd) { // Adding an existing app user
      const existingMember = await prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId, userId: userIdToAdd } }
      });
      if (existingMember) {
        res.status(400).json({ message: 'User is already a member of this group' });
        return;
      }
      const newMember = await prisma.groupMember.create({
        data: {
          groupId,
          userId: userIdToAdd,
          role: role || 'MEMBER', // Default to MEMBER if not specified
          status: 'ACCEPTED', // Or 'PENDING_INVITE_RESPONSE' if we want them to confirm
        }
      });
      res.status(201).json(newMember);
      return;
    } else if (emailToInvite || phoneToInvite || req.body.generateLink) { // Inviting a new user OR generating a shareable link
      // If generateLink is true, we create an invitation without specific contact details,
      // suitable for QR codes or manual sharing.
      // For now, create an invitation record. Actual email/SMS sending is a further step.
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7); // Invitation valid for 7 days

      // Generate a more secure, unique token
      const token = crypto.randomBytes(20).toString('hex');

      const invitation = await prisma.groupInvitation.create({
        data: {
          groupId,
          inviterId: currentUserId,
          inviteeEmail: emailToInvite || null,
          inviteePhone: phoneToInvite || null,
          // inviteeName: nameToInvite || null, // Need to add this to schema if desired
          token,
          expiresAt,
          status: 'PENDING'
        }
      });
      // TODO: Trigger email/SMS sending with this invitation (token/link) if emailToInvite/phoneToInvite are present.
      const responseMessage = (emailToInvite || phoneToInvite) ? 'Invitation created and will be sent.' : 'Shareable invitation link/token created.';
      res.status(201).json({ message: responseMessage, invitation });
      return;
    } else {
      res.status(400).json({ message: 'Provide userIdToAdd, or emailToInvite/phoneToInvite, or set generateLink:true' });
      return;
    }
  } catch (error) {
    console.error('Error adding member/inviting:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Internal server error' });
    }
  }
};
router.post('/', protect, addMemberHandler as RequestHandler);


// DELETE /groups/:groupId/members/:memberUserIdToRemove - Remove a member from a group
const removeMemberHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { groupId, memberUserIdToRemove } = req.params;
    const currentUserId = req.user?.id;

    if (!currentUserId) {
      res.status(401).json({ message: 'User not authenticated' });
      return;
    }

    // Check if current user is an ADMIN of the group OR if the user is removing themselves
    const isAdmin = await prisma.groupMember.findFirst({
      where: { groupId, userId: currentUserId, role: 'ADMIN', status: 'ACCEPTED' }
    });

    if (!isAdmin && currentUserId !== memberUserIdToRemove) {
      res.status(403).json({ message: 'Only group admins can remove other members. Users can only remove themselves.' });
      return;
    }
    
    // Prevent removing the last ADMIN if they are not the one initiating (or if it's the only member)
    if (isAdmin && isAdmin.userId === memberUserIdToRemove) { // Admin trying to remove themselves
        const adminCount = await prisma.groupMember.count({
            where: { groupId, role: 'ADMIN', status: 'ACCEPTED' }
        });
        if (adminCount <= 1) {
            const totalMembers = await prisma.groupMember.count({ where: { groupId, status: 'ACCEPTED' }});
            if (totalMembers > 1) {
                 res.status(400).json({ message: 'Cannot remove the last admin if other members exist. Promote another admin first.' });
                 return;
            }
            // If it's the last admin AND last member, group will be effectively orphaned/empty. Deletion of group might be better.
        }
    }


    const memberToRemove = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: memberUserIdToRemove } }
    });

    if (!memberToRemove) {
      res.status(404).json({ message: 'Member not found in this group' });
      return;
    }

    await prisma.groupMember.delete({
      where: { groupId_userId: { groupId, userId: memberUserIdToRemove } }
    });

    res.status(204).send();
    return;
  } catch (error) {
    console.error('Error removing member:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Internal server error' });
    }
  }
};
router.delete('/:memberUserIdToRemove', protect, removeMemberHandler as RequestHandler);

// PUT /groups/:groupId/members/:memberUserIdToUpdate - Update a member's role
const updateMemberRoleHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { groupId, memberUserIdToUpdate } = req.params;
    const { role } = req.body; // Expecting new role: 'ADMIN' or 'MEMBER'
    const currentUserId = req.user?.id;

    if (!currentUserId) {
      res.status(401).json({ message: 'User not authenticated' });
      return;
    }
    if (!role || (role !== 'ADMIN' && role !== 'MEMBER')) {
      res.status(400).json({ message: 'Valid role (ADMIN or MEMBER) is required' });
      return;
    }

    // Check if current user is an ADMIN of the group
    const isAdmin = await prisma.groupMember.findFirst({
      where: { groupId, userId: currentUserId, role: 'ADMIN', status: 'ACCEPTED' }
    });
    if (!isAdmin) {
      res.status(403).json({ message: 'Only group admins can change member roles' });
      return;
    }

    // Check if the member to update exists in the group
    const memberToUpdate = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: memberUserIdToUpdate } }
    });
    if (!memberToUpdate) {
      res.status(404).json({ message: 'Member to update not found in this group' });
      return;
    }

    // Prevent demoting the last admin if they are not the one initiating the request
    // (currentUserId is an admin, memberToUpdate is the one whose role is changing)
    if (memberToUpdate.role === 'ADMIN' && role === 'MEMBER') {
      if (memberToUpdate.userId === currentUserId && memberToUpdate.userId === memberUserIdToUpdate) {
        // Admin trying to demote themselves
        const adminCount = await prisma.groupMember.count({
          where: { groupId, role: 'ADMIN', status: 'ACCEPTED' }
        });
        if (adminCount <= 1) {
          const totalMembers = await prisma.groupMember.count({ where: { groupId, status: 'ACCEPTED' }});
            if (totalMembers > 1) {
                res.status(400).json({ message: 'Cannot demote the last admin if other members exist. Promote another admin first or leave the group.' });
                return;
            }
        }
      } else if (memberToUpdate.userId !== currentUserId) { // An admin demoting another admin
         const adminCount = await prisma.groupMember.count({
          where: { groupId, role: 'ADMIN', status: 'ACCEPTED' }
        });
         if (adminCount <= 1 && memberToUpdate.userId === memberUserIdToUpdate) { // Should not happen if logic is correct, but as a safeguard
            res.status(400).json({ message: 'Cannot demote the sole admin of the group.' });
            return;
         }
      }
    }
    
    const updatedMember = await prisma.groupMember.update({
      where: { groupId_userId: { groupId, userId: memberUserIdToUpdate } },
      data: { role: role }
    });

    res.status(200).json(updatedMember);
    return;

  } catch (error) {
    console.error('Error updating member role:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Internal server error' });
      return;
    }
  }
};
router.put('/:memberUserIdToUpdate/role', protect, updateMemberRoleHandler as RequestHandler);


export default router;
