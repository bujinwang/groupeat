import { PrismaClient, DiningGroup, GroupMember, GroupInvitation, User } from '@prisma/client';
import { BaseRepository } from './BaseRepository';

export type GroupWithMembers = DiningGroup & {
  members: (GroupMember & { user: User })[];
  creator: User;
  _count?: { members: number };
};

export type GroupMemberWithUser = GroupMember & { user: User };

export type InvitationWithDetails = GroupInvitation & {
  group: DiningGroup;
  inviter: User;
};

/**
 * Group Repository
 * Handles all database operations related to dining groups
 */
export class GroupRepository extends BaseRepository<DiningGroup> {
  constructor(prismaClient: PrismaClient) {
    super(prismaClient);
  }

  /**
   * Find group by ID
   */
  async findById(id: string): Promise<DiningGroup | null> {
    return this.prisma.diningGroup.findUnique({
      where: { id }
    });
  }

  /**
   * Find group by ID with members and creator
   */
  async findByIdWithDetails(id: string): Promise<GroupWithMembers | null> {
    return this.prisma.diningGroup.findUnique({
      where: { id },
      include: {
        members: {
          include: { user: true }
        },
        creator: true,
        _count: { select: { members: true } }
      }
    });
  }

  /**
   * Find all groups for a user
   */
  async findByUserId(userId: string): Promise<GroupWithMembers[]> {
    const memberships = await this.prisma.groupMember.findMany({
      where: {
        userId,
        status: 'ACCEPTED'
      },
      include: {
        group: {
          include: {
            members: {
              include: { user: true }
            },
            creator: true,
            _count: { select: { members: true } }
          }
        }
      },
      orderBy: {
        joinedAt: 'desc'
      }
    });

    return memberships.map(m => m.group);
  }

  /**
   * Create a new group with the creator as admin member
   */
  async createWithAdmin(creatorId: string, data: {
    name: string;
    description?: string;
    avatarUrl?: string;
  }): Promise<GroupWithMembers> {
    return this.transaction(async (tx) => {
      // Create the group
      const group = await tx.diningGroup.create({
        data: {
          name: data.name,
          description: data.description,
          avatarUrl: data.avatarUrl,
          creatorId
        }
      });

      // Add creator as admin member
      await tx.groupMember.create({
        data: {
          groupId: group.id,
          userId: creatorId,
          role: 'ADMIN',
          status: 'ACCEPTED'
        }
      });

      // Return group with members and creator
      return tx.diningGroup.findUnique({
        where: { id: group.id },
        include: {
          members: {
            include: { user: true }
          },
          creator: true,
          _count: { select: { members: true } }
        }
      }) as Promise<GroupWithMembers>;
    });
  }

  /**
   * Update group
   */
  async update(id: string, data: {
    name?: string;
    description?: string;
    avatarUrl?: string;
  }): Promise<DiningGroup> {
    return this.prisma.diningGroup.update({
      where: { id },
      data
    });
  }

  /**
   * Delete group
   */
  async delete(id: string): Promise<void> {
    await this.prisma.diningGroup.delete({
      where: { id }
    });
  }

  /**
   * Find a group member
   */
  async findMember(groupId: string, userId: string): Promise<GroupMemberWithUser | null> {
    return this.prisma.groupMember.findUnique({
      where: {
        groupId_userId: { groupId, userId }
      },
      include: { user: true }
    });
  }

  /**
   * Add a member to a group
   */
  async addMember(groupId: string, userId: string, role: 'ADMIN' | 'MEMBER' = 'MEMBER'): Promise<GroupMember> {
    return this.prisma.groupMember.create({
      data: {
        groupId,
        userId,
        role,
        status: 'ACCEPTED'
      }
    });
  }

  /**
   * Remove a member from a group
   */
  async removeMember(groupId: string, userId: string): Promise<void> {
    await this.prisma.groupMember.delete({
      where: {
        groupId_userId: { groupId, userId }
      }
    });
  }

  /**
   * Update member role
   */
  async updateMemberRole(groupId: string, userId: string, role: 'ADMIN' | 'MEMBER'): Promise<GroupMember> {
    return this.prisma.groupMember.update({
      where: {
        groupId_userId: { groupId, userId }
      },
      data: { role }
    });
  }

  /**
   * Count admins in a group
   */
  async countAdmins(groupId: string): Promise<number> {
    return this.prisma.groupMember.count({
      where: {
        groupId,
        role: 'ADMIN',
        status: 'ACCEPTED'
      }
    });
  }

  /**
   * Check if user is admin of a group
   */
  async isUserAdmin(groupId: string, userId: string): Promise<boolean> {
    const member = await this.prisma.groupMember.findUnique({
      where: {
        groupId_userId: { groupId, userId }
      }
    });

    return member?.role === 'ADMIN' && member?.status === 'ACCEPTED';
  }

  /**
   * Check if user is member of a group
   */
  async isUserMember(groupId: string, userId: string): Promise<boolean> {
    const member = await this.prisma.groupMember.findUnique({
      where: {
        groupId_userId: { groupId, userId }
      }
    });

    return member?.status === 'ACCEPTED';
  }

  /**
   * Get all members of a group
   */
  async getMembers(groupId: string): Promise<GroupMemberWithUser[]> {
    return this.prisma.groupMember.findMany({
      where: { groupId },
      include: { user: true },
      orderBy: { joinedAt: 'desc' }
    });
  }

  /**
   * Create an invitation
   */
  async createInvitation(data: {
    groupId: string;
    inviterId: string;
    token: string;
    inviteeEmail?: string;
    inviteePhone?: string;
    expiresAt: Date;
  }): Promise<GroupInvitation> {
    return this.prisma.groupInvitation.create({
      data
    });
  }

  /**
   * Find invitation by token
   */
  async findInvitationByToken(token: string): Promise<InvitationWithDetails | null> {
    return this.prisma.groupInvitation.findUnique({
      where: { token },
      include: {
        group: true,
        inviter: true
      }
    });
  }

  /**
   * Update invitation status
   */
  async updateInvitationStatus(
    id: string,
    status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'DECLINED'
  ): Promise<GroupInvitation> {
    return this.prisma.groupInvitation.update({
      where: { id },
      data: { status }
    });
  }

  /**
   * Get group invitations
   */
  async getGroupInvitations(groupId: string): Promise<InvitationWithDetails[]> {
    return this.prisma.groupInvitation.findMany({
      where: { groupId },
      include: {
        group: true,
        inviter: true
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
   * Accept invitation (create member and update invitation)
   */
  async acceptInvitation(token: string, userId: string): Promise<GroupMember> {
    return this.transaction(async (tx) => {
      // Find invitation
      const invitation = await tx.groupInvitation.findUnique({
        where: { token }
      });

      if (!invitation) {
        throw new Error('Invitation not found');
      }

      // Update invitation status
      await tx.groupInvitation.update({
        where: { id: invitation.id },
        data: { status: 'ACCEPTED' }
      });

      // Add user as member
      const member = await tx.groupMember.create({
        data: {
          groupId: invitation.groupId,
          userId,
          role: 'MEMBER',
          status: 'ACCEPTED'
        }
      });

      return member;
    });
  }

  /**
   * Get group posts feed
   */
  async getGroupPosts(groupId: string, options: {
    page?: number;
    limit?: number;
  } = {}) {
    const page = options.page || 1;
    const limit = options.limit || 20;
    const skip = (page - 1) * limit;

    return this.prisma.dishPost.findMany({
      where: { groupId },
      include: {
        user: { select: { id: true, name: true } },
        restaurant: { select: { id: true, name: true, address: true } },
        likes: { select: { userId: true } },
        _count: { select: { comments: true, likes: true } }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit
    });
  }
}
