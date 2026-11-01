/**
 * Application errors.
 *
 * The rule (ARCHITECTURE-sprint1 §7.3): a route handler maps an `AppError` to its
 * HTTP status and its safe public message. Nothing else reaches the client — no
 * stack trace, no Prisma message, no error code.
 */

export type FieldErrors = Record<string, string>;

export class AppError extends Error {
  readonly status: number;
  /** Safe to show a user. Never contains a driver or ORM message. */
  readonly publicMessage: string;
  /** Present for 422s: one message per offending field. */
  readonly fieldErrors?: FieldErrors;

  constructor(status: number, publicMessage: string, options?: { fieldErrors?: FieldErrors }) {
    super(publicMessage);
    this.name = 'AppError';
    this.status = status;
    this.publicMessage = publicMessage;
    this.fieldErrors = options?.fieldErrors;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static unauthorized(publicMessage = 'Please sign in to continue.'): AppError {
    return new AppError(401, publicMessage);
  }

  static forbidden(publicMessage = 'You do not have access to this page.'): AppError {
    return new AppError(403, publicMessage);
  }

  /**
   * Foreign resources are 404, never 403 (US-M1): a merchant must not be able to
   * learn that another merchant's item id exists.
   */
  static notFound(publicMessage = 'Not found.'): AppError {
    return new AppError(404, publicMessage);
  }

  static validation(fieldErrors: FieldErrors, publicMessage = 'Check the values you entered.'): AppError {
    return new AppError(422, publicMessage, { fieldErrors });
  }

  /**
   * The request was well formed, and no different body would help: the resource
   * is in a state that forbids the action. Editing a published drop is the case
   * this exists for — a 422 there would imply the merchant could fix it by
   * typing something else.
   */
  static conflict(publicMessage = 'That action cannot be taken in this state.'): AppError {
    return new AppError(409, publicMessage);
  }

  static badRequest(publicMessage = 'That request could not be processed.'): AppError {
    return new AppError(400, publicMessage);
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
