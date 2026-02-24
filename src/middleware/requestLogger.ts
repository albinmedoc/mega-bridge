import type { Request, Response, NextFunction } from 'express';
import { Logger } from '../helpers/logger';

const log = new Logger('http');

/**
 * Logs each incoming request with method, path, status code and duration.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    log.info(`${req.method} ${req.path}`, {
      status: res.statusCode,
      durationMs: duration,
    });
  });

  next();
}
