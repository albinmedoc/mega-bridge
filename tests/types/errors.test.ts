import { describe, it, expect } from 'vitest';
import { AppError, NotFoundError, ConflictError } from '../../src/types/errors';

describe('AppError', () => {
  it('has default status code 400', () => {
    const err = new AppError('bad request');
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe('bad request');
    expect(err.name).toBe('AppError');
  });

  it('accepts a custom status code', () => {
    const err = new AppError('teapot', 418);
    expect(err.statusCode).toBe(418);
  });

  it('is an instance of Error', () => {
    expect(new AppError('x')).toBeInstanceOf(Error);
  });
});

describe('NotFoundError', () => {
  it('has status code 404', () => {
    const err = new NotFoundError();
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('Not found');
    expect(err.name).toBe('NotFoundError');
  });

  it('accepts a custom message', () => {
    const err = new NotFoundError('file missing');
    expect(err.message).toBe('file missing');
    expect(err.statusCode).toBe(404);
  });

  it('is an instance of AppError', () => {
    expect(new NotFoundError()).toBeInstanceOf(AppError);
  });
});

describe('ConflictError', () => {
  it('has status code 409', () => {
    const err = new ConflictError();
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe('Conflict');
    expect(err.name).toBe('ConflictError');
  });

  it('accepts a custom message', () => {
    const err = new ConflictError('duplicate');
    expect(err.message).toBe('duplicate');
  });

  it('is an instance of AppError', () => {
    expect(new ConflictError()).toBeInstanceOf(AppError);
  });
});
