import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from './error.middleware';
import { asyncHandler } from './asyncHandler';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('errorHandler + asyncHandler', () => {
  it('turns a rejection thrown inside an asyncHandler-wrapped route into a clean 500, not a hang', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const app = express();
    app.get(
      '/boom',
      asyncHandler(async () => {
        throw new Error('simulated Stripe/Prisma failure');
      })
    );
    app.use(errorHandler);

    const res = await request(app).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error' });
  });

  it('does not interfere with a route that resolves normally', async () => {
    const app = express();
    app.get(
      '/ok',
      asyncHandler(async (_req, res) => {
        res.json({ ok: true });
      })
    );
    app.use(errorHandler);

    const res = await request(app).get('/ok');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
