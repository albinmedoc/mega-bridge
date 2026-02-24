import type { Request, Response, NextFunction } from 'express';
import { Logger } from '../helpers/logger';
import { AppError } from '../types/errors';

const log = new Logger('error');

/**
 * Express error-handling middleware.
 * Catches errors thrown in route handlers and returns a JSON error response.
 */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  log.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
  });

  res.status(500).json({ error: 'Internal server error' });
}
