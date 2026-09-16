import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response, Request } from 'express';
import type { AuthedRequest } from '../middleware/auth.middleware';

const mockPrisma = vi.hoisted(() => ({
  creatorProfile: { findUnique: vi.fn(), update: vi.fn() },
  order: { findMany: vi.fn() },
}));

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma }));

import { getStorefront, updateMyStorefront, getMyOrders } from './storefront.controller';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getStorefront', () => {
  it('returns 404 for an unknown slug', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue(null);
    const req = { params: { slug: 'nobody' } } as unknown as Request;
    const res = mockRes();
    await getStorefront(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns live:false with just the brand name when the storefront is offline', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({
      brandName: 'Elena Studio',
      firstName: 'Elena',
      storefrontLive: false,
      products: [],
    });
    const req = { params: { slug: 'elena' } } as unknown as Request;
    const res = mockRes();
    await getStorefront(req, res);
    expect(res.json).toHaveBeenCalledWith({ live: false, brandName: 'Elena Studio' });
  });

  it('returns products when the storefront is live', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({
      brandName: 'Elena Studio',
      firstName: 'Elena',
      storefrontLive: true,
      products: [{ id: 'p1', name: 'Tee', productType: 'tshirt', color: null, price: '20.00' }],
    });
    const req = { params: { slug: 'elena' } } as unknown as Request;
    const res = mockRes();
    await getStorefront(req, res);
    expect(res.json).toHaveBeenCalledWith({
      live: true,
      brandName: 'Elena Studio',
      products: [{ id: 'p1', name: 'Tee', productType: 'tshirt', color: null, price: '20.00' }],
    });
  });
});

describe('updateMyStorefront', () => {
  it('returns 400 for an invalid slug', async () => {
    const req = { body: { storefrontSlug: 'Not Valid!' }, userId: 'u1' } as AuthedRequest;
    const res = mockRes();
    await updateMyStorefront(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 409 when the slug is already taken by someone else', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ userId: 'someone-else' });
    const req = { body: { storefrontSlug: 'taken' }, userId: 'u1' } as AuthedRequest;
    const res = mockRes();
    await updateMyStorefront(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('updates the storefront when the slug is free', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue(null);
    mockPrisma.creatorProfile.update.mockResolvedValue({ storefrontSlug: 'free-slug' });
    const req = { body: { storefrontSlug: 'free-slug' }, userId: 'u1' } as AuthedRequest;
    const res = mockRes();
    await updateMyStorefront(req, res);
    expect(mockPrisma.creatorProfile.update).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      data: { storefrontSlug: 'free-slug' },
    });
  });
});

describe('getMyOrders', () => {
  it('returns 404 when the caller has no creator profile', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue(null);
    const req = { userId: 'u1' } as AuthedRequest;
    const res = mockRes();
    await getMyOrders(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('lists orders for the callers own products', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.order.findMany.mockResolvedValue([{ id: 'o1' }]);
    const req = { userId: 'u1' } as AuthedRequest;
    const res = mockRes();
    await getMyOrders(req, res);
    expect(mockPrisma.order.findMany).toHaveBeenCalledWith({
      where: { creatorId: 'c1' },
      orderBy: { createdAt: 'desc' },
      include: { product: { select: { name: true } } },
    });
    expect(res.json).toHaveBeenCalledWith({ orders: [{ id: 'o1' }] });
  });
});
