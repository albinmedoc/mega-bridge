import { describe, it, expect, vi } from 'vitest';
import healthRouter from '../../src/routes/health';

describe('GET /health', () => {
  it('returns status ok with uptime and memory', () => {
    const req = {} as any;
    const json = vi.fn();
    const res = { json } as any;

    // Invoke the route handler directly
    const handler = healthRouter.stack[0].route.stack[0].handle;
    handler(req, res);

    expect(json).toHaveBeenCalledOnce();
    const body = json.mock.calls[0][0];
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(typeof body.memoryMB).toBe('number');
  });
});
