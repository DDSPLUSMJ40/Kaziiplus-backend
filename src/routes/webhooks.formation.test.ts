import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const mockPrisma = vi.hoisted(() => ({
  order: { findUnique: vi.fn(), update: vi.fn() },
  fulfillmentOrder: { create: vi.fn() },
}));
const mockStripeClient = vi.hoisted(() => ({ webhooks: { constructEvent: vi.fn() } }));
const mockHandleFormationPaid = vi.hoisted(() => vi.fn());

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
vi.mock('../lib/stripe', () => ({ getStripe: () => mockStripeClient }));
vi.mock('../lib/crypto', () => ({ decrypt: (v: string) => v }));
vi.mock('../adapters/printful.adapter', () => ({ createOrder: vi.fn() }));
vi.mock('../controllers/formation.webhook.controller', () => ({
  handleFormationPaid: mockHandleFormationPaid,
  handleFormationProviderWebhook: vi.fn(),
}));

import { handleStripeWebhook } from './webhooks.routes';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

const req = { headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
});

describe('handleStripeWebhook — formation branch', () => {
  it('routes a formation session to handleFormationPaid and skips the storefront order path', async () => {
    const session = { id: 'cs_f', metadata: { kind: 'formation', formationOrderId: 'fo1' } };
    mockStripeClient.webhooks.constructEvent.mockReturnValue({ type: 'checkout.session.completed', data: { object: session } });
    const res = mockRes();
    await handleStripeWebhook(req, res);
    expect(mockHandleFormationPaid).toHaveBeenCalledWith(session);
    expect(mockPrisma.order.findUnique).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  it('leaves storefront sessions on the existing order path', async () => {
    mockStripeClient.webhooks.constructEvent.mockReturnValue({ type: 'checkout.session.completed', data: { object: { id: 'cs_s' } } });
    mockPrisma.order.findUnique.mockResolvedValue({ id: 'o1', stripeSessionId: 'cs_s' });
    const res = mockRes();
    await handleStripeWebhook(req, res);
    expect(mockHandleFormationPaid).not.toHaveBeenCalled();
    expect(mockPrisma.order.update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: { paymentStatus: 'PAID' } });
  });
});
