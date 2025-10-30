import { User, UserPreference } from '@prisma/client';
import { UserRepository } from '../repositories';
import { NotFoundError } from '../errors/AppError';
import { UpdatePreferencesDto, UpdateProfileDto } from '../validators/user.validator';

/**
 * User Service
 * Handles user profile and preferences business logic
 */
export class UserService {
  constructor(private userRepository: UserRepository) {}

  /**
   * Get user profile
   */
  async getUserProfile(userId: string): Promise<Omit<User, 'password'>> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new NotFoundError('User');
    }

    const { password, ...userWithoutPassword } = user;
    return userWithoutPassword;
  }

  /**
   * Get user profile with preferences
   */
  async getUserProfileWithPreferences(userId: string): Promise<Omit<User, 'password'> & { preferences?: UserPreference | null }> {
    const user = await this.userRepository.findByIdWithPreferences(userId);
    if (!user) {
      throw new NotFoundError('User');
    }

    const { password, ...userWithoutPassword } = user;
    return userWithoutPassword;
  }

  /**
   * Update user profile
   */
  async updateProfile(userId: string, data: UpdateProfileDto): Promise<Omit<User, 'password'>> {
    const user = await this.userRepository.update(userId, data);
    const { password, ...userWithoutPassword } = user;
    return userWithoutPassword;
  }

  /**
   * Update user preferences
   */
  async updatePreferences(userId: string, data: UpdatePreferencesDto): Promise<UserPreference> {
    // Check if user exists
    const userExists = await this.userRepository.existsById(userId);
    if (!userExists) {
      throw new NotFoundError('User');
    }

    return this.userRepository.upsertPreferences(userId, data);
  }

  /**
   * Get user preferences
   */
  async getPreferences(userId: string): Promise<UserPreference | null> {
    return this.userRepository.getPreferences(userId);
  }

  /**
   * Delete user account
   */
  async deleteAccount(userId: string): Promise<void> {
    const userExists = await this.userRepository.existsById(userId);
    if (!userExists) {
      throw new NotFoundError('User');
    }

    await this.userRepository.delete(userId);
  }
}
