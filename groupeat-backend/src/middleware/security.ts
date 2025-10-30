import { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';

/**
 * Helmet security middleware
 * Sets various HTTP headers for security
 */
export const securityHeaders = helmet({
  contentSecurityPolicy: config.isProduction ? undefined : false, // Disable in dev for easier debugging
  crossOriginEmbedderPolicy: false
});

/**
 * General API rate limiter
 * Applies to all /api/* routes
 */
export const apiLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  message: {
    status: 'error',
    message: 'Too many requests from this IP, please try again later'
  },
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  // Skip rate limiting for certain IPs (e.g., internal services)
  skip: (req) => {
    return false; // Could check req.ip against whitelist
  }
});

/**
 * Stricter rate limiter for authentication endpoints
 * Prevents brute force attacks
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs
  skipSuccessfulRequests: true, // Don't count successful login attempts
  message: {
    status: 'error',
    message: 'Too many authentication attempts, please try again after 15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Request ID middleware
 * Adds a unique ID to each request for tracking
 */
export const requestId = (req: Request, res: Response, next: NextFunction): void => {
  // Use existing request ID from header or generate new one
  const id = (req.headers['x-request-id'] as string) || uuidv4();

  // Attach to request object
  (req as any).id = id;

  // Send in response header
  res.setHeader('X-Request-ID', id);

  next();
};

/**
 * Request size limits
 * Prevents large payload attacks
 */
export const requestSizeLimits = {
  json: { limit: '10mb' },
  urlencoded: { extended: true, limit: '10mb' }
};

/**
 * CORS configuration
 * Note: This is just the configuration object
 * The actual CORS middleware is applied in index.ts using the 'cors' package
 */
export const corsOptions = {
  origin: config.server.corsOrigin,
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID']
};
