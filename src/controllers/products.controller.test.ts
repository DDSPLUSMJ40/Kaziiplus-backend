import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response } from 'express';
import type { AuthedRequest } from '../middleware/auth.middleware';

const mockPrisma = vi.hoisted(() => ({
  creatorProfile: { findUnique: vi.fn() },
  product: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma }));

import { createProduct, listProducts, getProduct, updateProduct, deleteProduct } from './products.controller';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createProduct', () => {
  it('returns 400 on invalid body', async () => {
    const req = { body: {}, userId: 'u1' } as AuthedRequest;
    const res = mockRes();
    await createProduct(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 if the caller has no creator profile', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue(null);
    const req = { body: { name: 'Tee', productType: 'tshirt' }, userId: 'u1' } as AuthedRequest;
    const res = mockRes();
    await createProduct(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('creates a product scoped to the caller creator profile', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.product.create.mockResolvedValue({ id: 'p1', name: 'Tee', productType: 'tshirt' });
    const req = { body: { name: 'Tee', productType: 'tshirt' }, userId: 'u1' } as AuthedRequest;
    const res = mockRes();
    await createProduct(req, res);
    expect(mockPrisma.product.create).toHaveBeenCalledWith({
      data: { creatorId: 'c1', name: 'Tee', productType: 'tshirt' },
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('listProducts', () => {
  it('lists only the caller creator profile products', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.product.findMany.mockResolvedValue([{ id: 'p1' }]);
    const req = { userId: 'u1' } as AuthedRequest;
    const res = mockRes();
    await listProducts(req, res);
    expect(mockPrisma.product.findMany).toHaveBeenCalledWith({ where: { creatorId: 'c1' }, orderBy: { createdAt: 'desc' } });
    expect(res.json).toHaveBeenCalledWith({ products: [{ id: 'p1' }] });
  });
});

describe('getProduct', () => {
  it('returns 404 for a product belonging to a different creator', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.product.findFirst.mockResolvedValue(null);
    const req = { params: { id: 'p1' }, userId: 'u1' } as unknown as AuthedRequest;
    const res = mockRes();
    await getProduct(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns the product when it belongs to the caller', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.product.findFirst.mockResolvedValue({ id: 'p1', creatorId: 'c1' });
    const req = { params: { id: 'p1' }, userId: 'u1' } as unknown as AuthedRequest;
    const res = mockRes();
    await getProduct(req, res);
    expect(res.json).toHaveBeenCalledWith({ product: { id: 'p1', creatorId: 'c1' } });
  });
});

describe('updateProduct', () => {
  it('returns 400 on invalid body', async () => {
    const req = { params: { id: 'p1' }, body: { status: 'NOT_REAL' }, userId: 'u1' } as unknown as AuthedRequest;
    const res = mockRes();
    await updateProduct(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when the product is not the callers', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.product.findFirst.mockResolvedValue(null);
    const req = { params: { id: 'p1' }, body: { status: 'LIVE' }, userId: 'u1' } as unknown as AuthedRequest;
    const res = mockRes();
    await updateProduct(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('publishes a product by setting status to LIVE', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.product.findFirst.mockResolvedValue({ id: 'p1', creatorId: 'c1' });
    mockPrisma.product.update.mockResolvedValue({ id: 'p1', status: 'LIVE' });
    const req = { params: { id: 'p1' }, body: { status: 'LIVE' }, userId: 'u1' } as unknown as AuthedRequest;
    const res = mockRes();
    await updateProduct(req, res);
    expect(mockPrisma.product.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { status: 'LIVE' } });
  });
});

describe('deleteProduct', () => {
  it('returns 404 when the product is not the callers', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.product.findFirst.mockResolvedValue(null);
    const req = { params: { id: 'p1' }, userId: 'u1' } as unknown as AuthedRequest;
    const res = mockRes();
    await deleteProduct(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('deletes the product and returns 204', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.product.findFirst.mockResolvedValue({ id: 'p1', creatorId: 'c1' });
    const req = { params: { id: 'p1' }, userId: 'u1' } as unknown as AuthedRequest;
    const res = mockRes();
    await deleteProduct(req, res);
    expect(mockPrisma.product.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
    expect(res.status).toHaveBeenCalledWith(204);
  });
});
