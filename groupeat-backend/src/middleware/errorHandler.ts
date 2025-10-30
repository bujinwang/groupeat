import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError, ValidationError } from '../errors/AppError';

/**
 * Standard error response format
 */
interface ErrorResponse {
  status: 'error';
  message: string;
  errors?: any;
  stack?: string;
}

/**
 * Global error handling middleware
 * Must be the last middleware registered
 */
export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // If headers already sent, delegate to default Express error handler
  if (res.headersSent) {
    return next(err);
  }

  // Handle custom application errors
  if (err instanceof AppError) {
    const response: ErrorResponse = {
      status: 'error',
      message: err.message
    };

    // Include validation errors if present
    if (err instanceof ValidationError && err.errors) {
      response.errors = err.errors;
    }

    // Include stack trace in development
    if (process.env.NODE_ENV === 'development') {
      response.stack = err.stack;
    }

    res.status(err.statusCode).json(response);
    return;
  }

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    const response: ErrorResponse = {
      status: 'error',
      message: 'Validation failed',
      errors: err.errors.map(e => ({
        field: e.path.join('.'),
        message: e.message
      }))
    };

    if (process.env.NODE_ENV === 'development') {
      response.stack = err.stack;
    }

    res.status(422).json(response);
    return;
  }

  // Handle Prisma errors
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const prismaError = handlePrismaError(err);
    const response: ErrorResponse = {
      status: 'error',
      message: prismaError.message
    };

    if (process.env.NODE_ENV === 'development') {
      response.stack = err.stack;
    }

    res.status(prismaError.statusCode).json(response);
    return;
  }

  // Handle JWT errors
  if (err.name === 'JsonWebTokenError') {
    res.status(401).json({
      status: 'error',
      message: 'Invalid token'
    });
    return;
  }

  if (err.name === 'TokenExpiredError') {
    res.status(401).json({
      status: 'error',
      message: 'Token expired'
    });
    return;
  }

  // Log unexpected errors
  console.error('Unexpected error:', err);

  // Don't leak error details in production
  const response: ErrorResponse = {
    status: 'error',
    message: process.env.NODE_ENV === 'development'
      ? err.message
      : 'Internal server error'
  };

  if (process.env.NODE_ENV === 'development') {
    response.stack = err.stack;
  }

  res.status(500).json(response);
};

/**
 * Convert Prisma errors to user-friendly messages
 */
function handlePrismaError(error: Prisma.PrismaClientKnownRequestError): {
  statusCode: number;
  message: string;
} {
  switch (error.code) {
    case 'P2000':
      return {
        statusCode: 400,
        message: 'The provided value is too long for the field'
      };

    case 'P2001':
      return {
        statusCode: 404,
        message: 'Record not found'
      };

    case 'P2002': {
      // Unique constraint violation
      const field = (error.meta?.target as string[])?.join(', ') || 'field';
      return {
        statusCode: 409,
        message: `A record with this ${field} already exists`
      };
    }

    case 'P2003':
      return {
        statusCode: 400,
        message: 'Foreign key constraint failed'
      };

    case 'P2025':
      return {
        statusCode: 404,
        message: 'Record not found or already deleted'
      };

    default:
      return {
        statusCode: 500,
        message: 'Database error occurred'
      };
  }
}

/**
 * Catch-all for 404 routes
 */
export const notFoundHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  res.status(404).json({
    status: 'error',
    message: `Route ${req.method} ${req.originalUrl} not found`
  });
};
