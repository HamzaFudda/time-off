/**
 * Shared error classes for the Time-Off Microservice.
 *
 * Pattern mirrors Allia's shared/error/error.ts:
 * - Each error class maps to an HTTP status code via statusCode
 * - BaseError is the root class; all domain errors extend it
 * - The global NestJS exception filter reads statusCode to set the response
 *
 * Usage:
 *   throw new NotFoundError('Time-off request not found');
 *   throw new ConflictError('Insufficient balance');
 *   throw new HcmUnavailableError('HCM timed out — using cached balance');
 */

export class BaseError extends Error {
  message: string;
  statusCode?: number;

  constructor(message: string) {
    super(message);
    this.message = message;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON() {
    return { message: this.message };
  }
}

/** Maps to 400 (Bad Request) */
export class BadRequestError extends BaseError {
  statusCode = 400;

  constructor(message: string) {
    super(message);
  }
}

/** Maps to 404 (Not Found) */
export class NotFoundError extends BaseError {
  statusCode = 404;

  constructor(message: string) {
    super(message);
  }
}

/** Maps to 409 (Conflict) — used for insufficient balance, invalid state transitions */
export class ConflictError extends BaseError {
  statusCode = 409;

  constructor(message: string) {
    super(message);
  }
}

/** Maps to 422 (Unprocessable Entity) — validation failures */
export class ValidationError extends BaseError {
  statusCode = 422;

  constructor(message: string) {
    super(message);
  }
}

/**
 * Maps to 503 (Service Unavailable) — HCM is down or unresponsive.
 * Services catch this to trigger graceful degradation (fall back to cache).
 */
export class HcmUnavailableError extends BaseError {
  statusCode = 503;

  constructor(
    message = 'HCM is temporarily unavailable. Please try again shortly.',
  ) {
    super(message);
  }
}

/**
 * Wraps TypeORM errors so our stack traces point to application code,
 * not TypeORM internals. Mirrors Allia's DbError pattern.
 */
export class DbError extends BaseError {
  originalError: Error;

  constructor(originalError: Error) {
    super(originalError.message);
    this.originalError = originalError;
  }
}

/** Thrown when an optimistic lock version mismatch occurs. Caller should retry. */
export class OptimisticLockError extends ConflictError {
  constructor(entity: string) {
    super(`Concurrent modification detected on ${entity}. Please retry.`);
  }
}
