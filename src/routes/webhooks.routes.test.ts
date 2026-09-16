import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const mockPrisma = vi.hoisted(() => ({
  order: { updateMany: vi.fn() },
}));

const mockStripeClient = vi.hoisted(() => ({
  webhooks: { constructEvent: vi.fn() },
}));

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
vi.mock('../lib/stripe', () => ({ getStripe: () => mockStripeClient }));

import { handleStripeWebhook } from './webhooks.routes';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
});

describe('handleStripeWebhook', () => {
  it('returns 400 when the signature header is missing', async () => {
    const req = { headers: {}, body: Buffer.from('{}') } as unknown as Request;
    const res = mockRes();
    await handleStripeWebhook(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when Stripe rejects the signature', async () => {
    mockStripeClient.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('bad signature');
    });
    const req = { headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as unknown as Request;
    const res = mockRes();
    await handleStripeWebhook(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('marks the matching order PAID on checkout.session.completed', async () => {
    mockStripeClient.webhooks.constructEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_123' } },
    });
    const req = { headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as unknown as Request;
    const res = mockRes();
    await handleStripeWebhook(req, res);
    expect(mockPrisma.order.updateMany).toHaveBeenCalledWith({
      where: { stripeSessionId: 'cs_123' },
      data: { paymentStatus: 'PAID' },
    });
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  it('ignores event types other than checkout.session.completed', async () => {
    mockStripeClient.webhooks.constructEvent.mockReturnValue({
      type: 'payment_intent.created',
      data: { object: {} },
    });
    const req = { headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as unknown as Request;
    const res = mockRes();
    await handleStripeWebhook(req, res);
    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });
});
