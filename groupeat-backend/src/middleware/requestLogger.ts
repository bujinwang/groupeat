import morgan from 'morgan';
import { morganStream } from '../utils/logger';
import { config } from '../config';

/**
 * Morgan token for request ID (if available)
 */
morgan.token('id', (req: any) => req.id || '-');

/**
 * Morgan token for user ID (if authenticated)
 */
morgan.token('user', (req: any) => req.user?.id || 'anonymous');

/**
 * Custom Morgan format
 * Logs: method, url, status, response-time, request-id, user-id
 */
const format = config.isProduction
  ? ':id :user :method :url :status :res[content-length] - :response-time ms'
  : ':id :user :method :url :status :res[content-length] - :response-time ms';

/**
 * HTTP request logger middleware
 */
export const requestLogger = morgan(format, {
  stream: morganStream,
  skip: (req, res) => {
    // Skip logging for health check endpoint
    return req.url === '/health';
  }
});
