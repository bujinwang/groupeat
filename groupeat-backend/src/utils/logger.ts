import winston from 'winston';
import { config } from '../config';

/**
 * Custom log format for development
 */
const devFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaString = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
    return `${timestamp} [${level}]: ${message} ${metaString}`;
  })
);

/**
 * Custom log format for production (JSON)
 */
const prodFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

/**
 * Winston logger instance
 */
export const logger = winston.createLogger({
  level: config.logging.level,
  format: config.isProduction ? prodFormat : devFormat,
  defaultMeta: { service: 'groupeat-backend' },
  transports: [
    // Write all logs to console
    new winston.transports.Console({
      silent: config.isTest // Disable console logs during tests
    }),

    // Write all logs with level 'error' to error.log
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),

    // Write all logs to combined.log
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ],
  // Don't exit on error
  exitOnError: false
});

/**
 * Stream for Morgan HTTP logger
 */
export const morganStream = {
  write: (message: string) => {
    logger.http(message.trim());
  }
};

/**
 * Log helper functions
 */
export const log = {
  error: (message: string, meta?: any) => logger.error(message, meta),
  warn: (message: string, meta?: any) => logger.warn(message, meta),
  info: (message: string, meta?: any) => logger.info(message, meta),
  http: (message: string, meta?: any) => logger.http(message, meta),
  debug: (message: string, meta?: any) => logger.debug(message, meta)
};

export default logger;
