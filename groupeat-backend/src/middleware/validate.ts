import { Request, Response, NextFunction } from 'express';
import { AnyZodObject, ZodError, z } from 'zod';
import { ValidationError } from '../errors/AppError';

/**
 * Validation target options
 */
export type ValidationTarget = 'body' | 'params' | 'query';

/**
 * Validation schema configuration
 */
interface ValidationSchema {
  body?: AnyZodObject;
  params?: AnyZodObject;
  query?: AnyZodObject;
}

/**
 * Middleware factory to validate request data using Zod schemas
 *
 * @example
 * router.post('/users', validate({ body: CreateUserSchema }), handler);
 */
export const validate = (schema: ValidationSchema) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Validate request body
      if (schema.body) {
        req.body = await schema.body.parseAsync(req.body);
      }

      // Validate request params
      if (schema.params) {
        req.params = await schema.params.parseAsync(req.params);
      }

      // Validate query params
      if (schema.query) {
        req.query = await schema.query.parseAsync(req.query);
      }

      next();
    } catch (error) {
      if (error instanceof ZodError) {
        // Format Zod errors for better readability
        const formattedErrors = error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message,
          code: err.code
        }));

        next(new ValidationError('Validation failed', formattedErrors));
      } else {
        next(error);
      }
    }
  };
};

/**
 * Simpler version for validating just the request body
 *
 * @example
 * router.post('/users', validateBody(CreateUserSchema), handler);
 */
export const validateBody = (schema: AnyZodObject) => {
  return validate({ body: schema });
};

/**
 * Validate request params
 *
 * @example
 * router.get('/users/:id', validateParams(IdParamSchema), handler);
 */
export const validateParams = (schema: AnyZodObject) => {
  return validate({ params: schema });
};

/**
 * Validate query parameters
 *
 * @example
 * router.get('/users', validateQuery(UserQuerySchema), handler);
 */
export const validateQuery = (schema: AnyZodObject) => {
  return validate({ query: schema });
};

/**
 * Common validation schemas for reuse
 */
export const CommonSchemas = {
  /**
   * UUID parameter validation
   */
  uuid: z.object({
    id: z.string().uuid('Invalid ID format')
  }),

  /**
   * Pagination query parameters
   */
  pagination: z.object({
    page: z.string().regex(/^\d+$/).transform(Number).default('1'),
    limit: z.string().regex(/^\d+$/).transform(Number).default('20')
  }),

  /**
   * MongoDB-style ObjectId (24 hex characters)
   */
  objectId: z.object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid ID format')
  })
};
