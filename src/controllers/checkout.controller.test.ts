import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const mockPrisma = vi.hoisted(() => ({
  creatorProfile: { findUnique: vi.fn() },
  product: { findFirst: vi.fn() },
  order: { create: vi.fn() },
}));

const mockStripeClient = vi.hoisted(() => ({
  checkout: { sessions: { create: vi.fn() } },
}));

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
vi.mock('../lib/stripe', () => ({ getStripe: () => mockStripeClient }));

import { createCheckoutSession } from './checkout.controller';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FRONTEND_URL = 'https://kaziiplus.com';
});

describe('createCheckoutSession', () => {
  it('returns 400 on an invalid body', async () => {
    const req = { params: { slug: 'elena' }, body: {} } as unknown as Request;
    const res = mockRes();
    await createCheckoutSession(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 for an unknown storefront slug', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue(null);
    const req = {
      params: { slug: 'nobody' },
      body: { productId: 'p1', customerEmail: 'buyer@example.com' },
    } as unknown as Request;
    const res = mockRes();
    await createCheckoutSession(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 404 when the product is not LIVE or has no price', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.product.findFirst.mockResolvedValue(null);
    const req = {
      params: { slug: 'elena' },
      body: { productId: 'p1', customerEmail: 'buyer@example.com' },
    } as unknown as Request;
    const res = mockRes();
    await createCheckoutSession(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 404 when the product price is exactly zero', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.product.findFirst.mockResolvedValue({ id: 'p1', name: 'Free Sticker', price: '0.00' });
    const req = {
      params: { slug: 'elena' },
      body: { productId: 'p1', customerEmail: 'buyer@example.com' },
    } as unknown as Request;
    const res = mockRes();
    await createCheckoutSession(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockStripeClient.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('returns 400 when quantity exceeds the cap', async () => {
    const req = {
      params: { slug: 'elena' },
      body: { productId: 'p1', customerEmail: 'buyer@example.com', quantity: 1000000 },
    } as unknown as Request;
    const res = mockRes();
    await createCheckoutSession(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockStripeClient.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('creates a Stripe session and a PENDING order, returning the checkout URL', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.product.findFirst.mockResolvedValue({ id: 'p1', name: 'Tee', price: '20.00' });
    mockStripeClient.checkout.sessions.create.mockResolvedValue({ id: 'cs_123', url: 'https://checkout.stripe.com/cs_123' });

    const req = {
      params: { slug: 'elena' },
      body: { productId: 'p1', quantity: 2, customerEmail: 'buyer@example.com' },
    } as unknown as Request;
    const res = mockRes();

    await createCheckoutSession(req, res);

    expect(mockStripeClient.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'payment',
        customer_email: 'buyer@example.com',
        success_url: expect.stringContaining('https://kaziiplus.com'),
        cancel_url: expect.stringContaining('https://kaziiplus.com'),
      })
    );
    expect(mockPrisma.order.create).toHaveBeenCalledWith({
      data: {
        creatorId: 'c1',
        productId: 'p1',
        customerHandle: 'buyer@example.com',
        amount: 40,
        quantity: 2,
        customerEmail: 'buyer@example.com',
        stripeSessionId: 'cs_123',
        paymentStatus: 'PENDING',
      },
    });
    expect(res.json).toHaveBeenCalledWith({ checkoutUrl: 'https://checkout.stripe.com/cs_123' });
  });
});
