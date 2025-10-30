import { z } from 'zod';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

/**
 * Environment variable schema with validation
 */
const envSchema = z.object({
  // Node environment
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Server
  PORT: z.string().regex(/^\d+$/).transform(Number).default('3000'),

  // Database
  DATABASE_URL: z.string().url('Invalid database URL'),

  // JWT
  JWT_SECRET: z.string().min(32, 'JWT secret must be at least 32 characters'),
  JWT_EXPIRY_IN_MINUTES: z.string().regex(/^\d+$/).transform(Number).default('60'),
  JWT_ISSUER: z.string().optional(),
  JWT_AUDIENCE: z.string().optional(),

  // CORS
  CORS_ORIGIN: z.string().default('*'),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: z.string().regex(/^\d+$/).transform(Number).default('900000'), // 15 minutes
  RATE_LIMIT_MAX_REQUESTS: z.string().regex(/^\d+$/).transform(Number).default('100'),

  // Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'verbose', 'debug']).default('info'),

  // Optional: External services
  AWS_S3_BUCKET: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().optional(),

  SENDGRID_API_KEY: z.string().optional(),
  SENDGRID_FROM_EMAIL: z.string().email().optional(),

  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),

  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_PLACES_API_KEY: z.string().optional()
});

/**
 * Parse and validate environment variables
 * Throws error if validation fails
 */
const parseEnv = () => {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missingVars = error.errors.map(err => {
        const path = err.path.join('.');
        return `  - ${path}: ${err.message}`;
      }).join('\n');

      console.error('❌ Environment variable validation failed:\n' + missingVars);
      process.exit(1);
    }
    throw error;
  }
};

const env = parseEnv();

/**
 * Application configuration object
 */
export const config = {
  /**
   * Node environment
   */
  env: env.NODE_ENV,

  /**
   * Is production environment
   */
  isProduction: env.NODE_ENV === 'production',

  /**
   * Is development environment
   */
  isDevelopment: env.NODE_ENV === 'development',

  /**
   * Is test environment
   */
  isTest: env.NODE_ENV === 'test',

  /**
   * Server configuration
   */
  server: {
    port: env.PORT,
    corsOrigin: env.CORS_ORIGIN.split(',').map(origin => origin.trim())
  },

  /**
   * Database configuration
   */
  database: {
    url: env.DATABASE_URL
  },

  /**
   * JWT configuration
   */
  jwt: {
    secret: env.JWT_SECRET,
    expiryMinutes: env.JWT_EXPIRY_IN_MINUTES,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE
  },

  /**
   * Rate limiting configuration
   */
  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    maxRequests: env.RATE_LIMIT_MAX_REQUESTS
  },

  /**
   * Logging configuration
   */
  logging: {
    level: env.LOG_LEVEL
  },

  /**
   * AWS S3 configuration (optional)
   */
  aws: env.AWS_S3_BUCKET ? {
    s3Bucket: env.AWS_S3_BUCKET,
    accessKeyId: env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
    region: env.AWS_REGION!
  } : undefined,

  /**
   * SendGrid configuration (optional)
   */
  sendgrid: env.SENDGRID_API_KEY ? {
    apiKey: env.SENDGRID_API_KEY,
    fromEmail: env.SENDGRID_FROM_EMAIL!
  } : undefined,

  /**
   * Twilio configuration (optional)
   */
  twilio: env.TWILIO_ACCOUNT_SID ? {
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN!,
    phoneNumber: env.TWILIO_PHONE_NUMBER!
  } : undefined,

  /**
   * OpenAI configuration (optional)
   */
  openai: env.OPENAI_API_KEY ? {
    apiKey: env.OPENAI_API_KEY
  } : undefined,

  /**
   * Google Places API configuration (optional)
   */
  googlePlaces: env.GOOGLE_PLACES_API_KEY ? {
    apiKey: env.GOOGLE_PLACES_API_KEY
  } : undefined
} as const;

/**
 * Type-safe config export
 */
export type Config = typeof config;

// Log configuration summary (without sensitive data)
if (config.isDevelopment) {
  console.log('✅ Configuration loaded successfully');
  console.log(`   Environment: ${config.env}`);
  console.log(`   Port: ${config.server.port}`);
  console.log(`   Database: ${config.database.url.split('@')[1] || 'configured'}`);
  console.log(`   JWT Expiry: ${config.jwt.expiryMinutes} minutes`);
  console.log(`   AWS S3: ${config.aws ? 'enabled' : 'disabled'}`);
  console.log(`   SendGrid: ${config.sendgrid ? 'enabled' : 'disabled'}`);
  console.log(`   Twilio: ${config.twilio ? 'enabled' : 'disabled'}`);
  console.log(`   OpenAI: ${config.openai ? 'enabled' : 'disabled'}`);
  console.log(`   Google Places: ${config.googlePlaces ? 'enabled' : 'disabled'}`);
}
