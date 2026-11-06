/**
 * src/middleware/errorHandler.ts
 *
 * Centralised Express error handler.
 *
 * Catches all errors passed via `next(err)` and maps them to appropriate
 * HTTP responses. This prevents sensitive stack traces from leaking to
 * clients and gives us a single place to add logging/monitoring hooks.
 */
import { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import { logger } from '@/lib/logger';

/** Structured error response shape */
interface ErrorResponse {
  status: 'error';
  message: string;
  errors?: unknown;
}

/**
 * Custom application error class.
 * Throw this anywhere in service/controller code to produce a clean HTTP error.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  // ── Zod validation errors ─────────────────────────────────────────────────
  if (err instanceof ZodError) {
    const response: ErrorResponse = {
      status: 'error',
      message: 'Validation failed.',
      errors: z.flattenError(err).fieldErrors,
    };
    res.status(422).json(response);
    return;
  }

  // ── JWT errors ────────────────────────────────────────────────────────────
  if (err instanceof TokenExpiredError) {
    res.status(401).json({ status: 'error', message: 'Token has expired.' });
    return;
  }

  if (err instanceof JsonWebTokenError) {
    res.status(401).json({ status: 'error', message: 'Invalid token.' });
    return;
  }

  // ── Application-level errors ──────────────────────────────────────────────
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
      ...(err.code ? { code: err.code } : {}),
    });
    return;
  }

  // ── Unknown/unhandled errors ──────────────────────────────────────────────
  logger.error({ err }, 'Unhandled error');

  res.status(500).json({
    status: 'error',
    message: 'An unexpected internal server error occurred.',
  });
};
