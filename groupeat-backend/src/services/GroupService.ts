import crypto from 'crypto';
import { GroupRepository, UserRepository, GroupWithMembers, InvitationWithDetails } from '../repositories';
import { NotFoundError, ForbiddenError, ConflictError, BadRequestError } from '../errors/AppError';
import { CreateGroupDto, UpdateGroupDto, AddMemberDto } from '../validators/group.validator';

/**
 * Group Service
 * Handles group management, members, and invitations
 */
export class GroupService {
  constructor(
    private groupRepository: GroupRepository,
    private userRepository: UserRepository
  ) {}

  /**
   * Create a new group
   */
  async createGroup(userId: string, data: CreateGroupDto): Promise<GroupWithMembers> {
    // Verify user exists
    const userExists = await this.userRepository.existsById(userId);
    if (!userExists) {
      throw new NotFoundError('User');
    }

    // Create group with creator as admin
    return this.groupRepository.createWithAdmin(userId, data);
  }

  /**
   * Get user's groups
   */
  async getUserGroups(userId: string): Promise<GroupWithMembers[]> {
    return this.groupRepository.findByUserId(userId);
  }

  /**
   * Get group by ID
   */
  async getGroupById(groupId: string, userId: string): Promise<GroupWithMembers> {
    const group = await this.groupRepository.findByIdWithDetails(groupId);
    if (!group) {
      throw new NotFoundError('Group');
    }

    // Check if user is a member
    const isMember = await this.groupRepository.isUserMember(groupId, userId);
    if (!isMember) {
      throw new ForbiddenError('You are not a member of this group');
    }

    return group;
  }

  /**
   * Update group
   */
  async updateGroup(groupId: string, userId: string, data: UpdateGroupDto): Promise<GroupWithMembers> {
    // Check if group exists
    const group = await this.groupRepository.findById(groupId);
    if (!group) {
      throw new NotFoundError('Group');
    }

    // Check if user is admin
    const isAdmin = await this.groupRepository.isUserAdmin(groupId, userId);
    if (!isAdmin) {
      throw new ForbiddenError('Only admins can update group details');
    }

    // Update group
    await this.groupRepository.update(groupId, data);

    // Return updated group with details
    return this.groupRepository.findByIdWithDetails(groupId) as Promise<GroupWithMembers>;
  }

  /**
   * Delete group
   */
  async deleteGroup(groupId: string, userId: string): Promise<void> {
    // Check if group exists
    const group = await this.groupRepository.findById(groupId);
    if (!group) {
      throw new NotFoundError('Group');
    }

    // Check if user is admin
    const isAdmin = await this.groupRepository.isUserAdmin(groupId, userId);
    if (!isAdmin) {
      throw new ForbiddenError('Only admins can delete the group');
    }

    await this.groupRepository.delete(groupId);
  }

  /**
   * Add member to group
   */
  async addMember(groupId: string, adminId: string, data: AddMemberDto): Promise<any> {
    // Check if group exists
    const group = await this.groupRepository.findById(groupId);
    if (!group) {
      throw new NotFoundError('Group');
    }

    // Check if requester is admin
    const isAdmin = await this.groupRepository.isUserAdmin(groupId, adminId);
    if (!isAdmin) {
      throw new ForbiddenError('Only admins can add members');
    }

    // If userId is provided, add user directly
    if (data.userId) {
      // Check if user exists
      const userExists = await this.userRepository.existsById(data.userId);
      if (!userExists) {
        throw new NotFoundError('User');
      }

      // Check if already a member
      const existingMember = await this.groupRepository.findMember(groupId, data.userId);
      if (existingMember) {
        throw new ConflictError('User is already a member of this group');
      }

      // Add member
      const member = await this.groupRepository.addMember(groupId, data.userId, 'MEMBER');
      return { member, message: 'Member added successfully' };
    }

    // Otherwise, create an invitation
    return this.createInvitation(groupId, adminId, data);
  }

  /**
   * Create invitation
   */
  async createInvitation(
    groupId: string,
    inviterId: string,
    data: { inviteeEmail?: string; inviteePhone?: string }
  ): Promise<{ invitation: InvitationWithDetails; invitationLink: string }> {
    // Generate secure token
    const token = crypto.randomBytes(20).toString('hex');

    // Calculate expiration (7 days from now)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // Create invitation
    const invitation = await this.groupRepository.createInvitation({
      groupId,
      inviterId,
      token,
      inviteeEmail: data.inviteeEmail,
      inviteePhone: data.inviteePhone,
      expiresAt
    });

    // Get invitation with details
    const invitationWithDetails = await this.groupRepository.findInvitationByToken(token);

    // Generate invitation link
    // TODO: Use actual app URL from config
    const invitationLink = `${process.env.APP_URL || 'http://localhost:3000'}/invite/${token}`;

    return {
      invitation: invitationWithDetails!,
      invitationLink
    };
  }

  /**
   * Accept invitation
   */
  async acceptInvitation(token: string, userId: string): Promise<GroupWithMembers> {
    // Find invitation
    const invitation = await this.groupRepository.findInvitationByToken(token);
    if (!invitation) {
      throw new NotFoundError('Invitation');
    }

    // Check if invitation is still valid
    if (invitation.status !== 'PENDING') {
      throw new BadRequestError('Invitation has already been used or expired');
    }

    if (new Date() > invitation.expiresAt) {
      // Update status to expired
      await this.groupRepository.updateInvitationStatus(invitation.id, 'EXPIRED');
      throw new BadRequestError('Invitation has expired');
    }

    // Check if user is already a member
    const existingMember = await this.groupRepository.findMember(invitation.groupId, userId);
    if (existingMember) {
      throw new ConflictError('You are already a member of this group');
    }

    // Accept invitation (creates member and updates invitation)
    await this.groupRepository.acceptInvitation(token, userId);

    // Return group with details
    return this.groupRepository.findByIdWithDetails(invitation.groupId) as Promise<GroupWithMembers>;
  }

  /**
   * Remove member from group
   */
  async removeMember(groupId: string, adminId: string, memberUserId: string): Promise<void> {
    // Check if group exists
    const group = await this.groupRepository.findById(groupId);
    if (!group) {
      throw new NotFoundError('Group');
    }

    // Check if requester is admin
    const isAdmin = await this.groupRepository.isUserAdmin(groupId, adminId);
    if (!isAdmin) {
      throw new ForbiddenError('Only admins can remove members');
    }

    // Check if member exists
    const member = await this.groupRepository.findMember(groupId, memberUserId);
    if (!member) {
      throw new NotFoundError('Member');
    }

    // Prevent removing the last admin
    if (member.role === 'ADMIN') {
      const adminCount = await this.groupRepository.countAdmins(groupId);
      if (adminCount <= 1) {
        throw new BadRequestError('Cannot remove the last admin. Promote another member first.');
      }
    }

    await this.groupRepository.removeMember(groupId, memberUserId);
  }

  /**
   * Update member role
   */
  async updateMemberRole(
    groupId: string,
    adminId: string,
    memberUserId: string,
    newRole: 'ADMIN' | 'MEMBER'
  ): Promise<void> {
    // Check if group exists
    const group = await this.groupRepository.findById(groupId);
    if (!group) {
      throw new NotFoundError('Group');
    }

    // Check if requester is admin
    const isAdmin = await this.groupRepository.isUserAdmin(groupId, adminId);
    if (!isAdmin) {
      throw new ForbiddenError('Only admins can update member roles');
    }

    // Check if member exists
    const member = await this.groupRepository.findMember(groupId, memberUserId);
    if (!member) {
      throw new NotFoundError('Member');
    }

    // If demoting from admin, check if they're the last admin
    if (member.role === 'ADMIN' && newRole === 'MEMBER') {
      const adminCount = await this.groupRepository.countAdmins(groupId);
      if (adminCount <= 1) {
        throw new BadRequestError('Cannot demote the last admin. Promote another member first.');
      }
    }

    await this.groupRepository.updateMemberRole(groupId, memberUserId, newRole);
  }

  /**
   * Get group posts feed
   */
  async getGroupFeed(groupId: string, userId: string, options: { page?: number; limit?: number } = {}) {
    // Check if group exists
    const group = await this.groupRepository.findById(groupId);
    if (!group) {
      throw new NotFoundError('Group');
    }

    // Check if user is a member
    const isMember = await this.groupRepository.isUserMember(groupId, userId);
    if (!isMember) {
      throw new ForbiddenError('You must be a member to view group posts');
    }

    return this.groupRepository.getGroupPosts(groupId, options);
  }
}
