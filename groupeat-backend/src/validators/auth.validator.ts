import { z } from 'zod';

/**
 * Password validation rules
 * - At least 8 characters
 * - Contains uppercase letter
 * - Contains lowercase letter
 * - Contains number
 * - Contains special character
 */
const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

/**
 * Email validation
 */
const emailSchema = z
  .string()
  .email('Invalid email format')
  .toLowerCase()
  .trim();

/**
 * Register user schema
 */
export const RegisterSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().min(1, 'Name is required').max(100, 'Name too long').trim().optional()
});

export type RegisterDto = z.infer<typeof RegisterSchema>;

/**
 * Login user schema
 */
export const LoginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required')
});

export type LoginDto = z.infer<typeof LoginSchema>;

/**
 * Forgot password schema
 */
export const ForgotPasswordSchema = z.object({
  email: emailSchema
});

export type ForgotPasswordDto = z.infer<typeof ForgotPasswordSchema>;

/**
 * Reset password schema
 */
export const ResetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  newPassword: passwordSchema
});

export type ResetPasswordDto = z.infer<typeof ResetPasswordSchema>;

/**
 * Change password schema
 */
export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: passwordSchema
});

export type ChangePasswordDto = z.infer<typeof ChangePasswordSchema>;

/**
 * Verify email schema
 */
export const VerifyEmailSchema = z.object({
  token: z.string().min(1, 'Verification token is required')
});

export type VerifyEmailDto = z.infer<typeof VerifyEmailSchema>;
