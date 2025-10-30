import { PrismaClient, User, UserPreference } from '@prisma/client';
import { BaseRepository } from './BaseRepository';

export type UserWithPreferences = User & {
  preferences?: UserPreference | null;
};

/**
 * User Repository
 * Handles all database operations related to users
 */
export class UserRepository extends BaseRepository<User> {
  constructor(prismaClient: PrismaClient) {
    super(prismaClient);
  }

  /**
   * Find user by ID
   */
  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { id }
    });
  }

  /**
   * Find user by ID with preferences
   */
  async findByIdWithPreferences(id: string): Promise<UserWithPreferences | null> {
    return this.prisma.user.findUnique({
      where: { id },
      include: { preferences: true }
    });
  }

  /**
   * Find user by email
   */
  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email }
    });
  }

  /**
   * Create a new user
   */
  async create(data: {
    email: string;
    password: string;
    name?: string;
  }): Promise<User> {
    return this.prisma.user.create({
      data
    });
  }

  /**
   * Update user profile
   */
  async update(id: string, data: {
    name?: string;
    email?: string;
  }): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data
    });
  }

  /**
   * Update user password
   */
  async updatePassword(id: string, hashedPassword: string): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data: { password: hashedPassword }
    });
  }

  /**
   * Delete user
   */
  async delete(id: string): Promise<void> {
    await this.prisma.user.delete({
      where: { id }
    });
  }

  /**
   * Upsert user preferences
   */
  async upsertPreferences(userId: string, data: {
    favoriteCuisines?: string[];
    dietaryRestrictions?: string[];
    spiceLevel?: string;
    preferredPriceRange?: string;
  }): Promise<UserPreference> {
    return this.prisma.userPreference.upsert({
      where: { userId },
      create: {
        userId,
        ...data
      },
      update: data
    });
  }

  /**
   * Get user preferences
   */
  async getPreferences(userId: string): Promise<UserPreference | null> {
    return this.prisma.userPreference.findUnique({
      where: { userId }
    });
  }

  /**
   * Check if user exists by email
   */
  async existsByEmail(email: string): Promise<boolean> {
    const count = await this.prisma.user.count({
      where: { email }
    });
    return count > 0;
  }

  /**
   * Check if user exists by ID
   */
  async existsById(id: string): Promise<boolean> {
    const count = await this.prisma.user.count({
      where: { id }
    });
    return count > 0;
  }
}
