import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

process.env.JWT_SECRET = 'test-secret';

vi.mock('../lib/prisma', () => {
  const createMockPrisma = () => ({
    user: { findUnique: vi.fn(), create: vi.fn() },
    creatorProfile: { findUnique: vi.fn() },
  });
  return { prisma: createMockPrisma() };
});

vi.mock('bcryptjs', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('hashed'),
    compare: vi.fn(),
  },
}));

vi.mock('jsonwebtoken', () => ({
  default: {
    sign: vi.fn().mockReturnValue('signed-token'),
  },
}));

import { signup, generateUniqueStorefrontSlug } from './auth.controller';
import { prisma } from '../lib/prisma';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const mockPrisma = prisma as any;
const mockBcrypt = bcrypt as any;
const mockJwt = jwt as any;

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

beforeEach(() => {
  vi.clearAllMocks();

  // Re-initialize the mocks
  mockBcrypt.hash = vi.fn().mockResolvedValue('hashed');
  mockBcrypt.compare = vi.fn();
  mockJwt.sign = vi.fn().mockReturnValue('signed-token');
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
    // Mock jwt.sign to not require JWT_SECRET validation
    mockJwt.sign = vi.fn().mockReturnValue('signed-token');

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
