import { describe, it, expect, vi } from 'vitest';
import { errorHandler } from '../../src/middleware/errorHandler';
import { AppError, NotFoundError, ConflictError } from '../../src/types/errors';
import type { Request, Response, NextFunction } from 'express';

function mockRes(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

const mockReq = {} as Request;
const mockNext = vi.fn() as unknown as NextFunction;

describe('errorHandler', () => {
  it('returns 400 for AppError', () => {
    const res = mockRes();
    errorHandler(new AppError('bad input'), mockReq, res, mockNext);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'bad input' });
  });

  it('returns 404 for NotFoundError', () => {
    const res = mockRes();
    errorHandler(new NotFoundError('not here'), mockReq, res, mockNext);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'not here' });
  });

  it('returns 409 for ConflictError', () => {
    const res = mockRes();
    errorHandler(new ConflictError('duplicate'), mockReq, res, mockNext);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'duplicate' });
  });

  it('returns 500 for unknown errors', () => {
    const res = mockRes();
    errorHandler(new Error('unexpected'), mockReq, res, mockNext);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
  });

  it('returns custom status code for AppError', () => {
    const res = mockRes();
    errorHandler(new AppError('teapot', 418), mockReq, res, mockNext);
    expect(res.status).toHaveBeenCalledWith(418);
  });
});
