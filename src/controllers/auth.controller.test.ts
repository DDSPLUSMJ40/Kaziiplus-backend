import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

process.env.JWT_SECRET = 'test-secret';

const mockPrisma = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), create: vi.fn() },
  creatorProfile: { findUnique: vi.fn() },
}));

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
vi.mock('bcryptjs', () => ({ default: { hash: vi.fn().mockResolvedValue('hashed'), compare: vi.fn() } }));
vi.mock('jsonwebtoken', () => ({ default: { sign: vi.fn().mockReturnValue('signed-token') } }));

import { signup, generateUniqueStorefrontSlug } from './auth.controller';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET = 'test-secret';
});

describe('generateUniqueStorefrontSlug', () => {
  it('returns the base slug when it is not taken', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue(null);
    const slug = await generateUniqueStorefrontSlug('Elena Cruz');
    expect(slug).toBe('elena-cruz');
  });

  it('appends a random suffix when the base slug is taken', async () => {
    mockPrisma.creatorProfile.findUnique
      .mockResolvedValueOnce({ id: 'existing' })
      .mockResolvedValueOnce(null);
    const slug = await generateUniqueStorefrontSlug('Elena Cruz');
    expect(slug).toMatch(/^elena-cruz-[a-z0-9]{4}$/);
  });

  it('falls back to "creator" when the base has no keepable characters', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue(null);
    const slug = await generateUniqueStorefrontSlug('!!!');
    expect(slug).toBe('creator');
  });
});

describe('signup assigns a storefront slug to new creators', () => {
  it('creates the user with a generated storefrontSlug on the creator profile', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.creatorProfile.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({ id: 'u1', email: 'jade@example.com', accountType: 'CREATOR' });

    const req = {
      body: { email: 'jade@example.com', password: 'password123', accountType: 'CREATOR', firstName: 'Jade' },
    } as Request;
    const res = mockRes();

    await signup(req, res);

    expect(mockPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          creatorProfile: expect.objectContaining({
            create: expect.objectContaining({ storefrontSlug: 'jade' }),
          }),
        }),
      })
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
