import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const mockPrisma = vi.hoisted(() => ({
  order: { findUnique: vi.fn(), update: vi.fn() },
  fulfillmentOrder: { create: vi.fn() },
}));

const mockStripeClient = vi.hoisted(() => ({
  webhooks: { constructEvent: vi.fn() },
}));

const mockCreateOrder = vi.hoisted(() => vi.fn());

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
vi.mock('../lib/stripe', () => ({ getStripe: () => mockStripeClient }));
vi.mock('../lib/crypto', () => ({ decrypt: (v: string) => `decrypted:${v}` }));
vi.mock('../adapters/printful.adapter', () => ({ createOrder: mockCreateOrder }));

import { handleStripeWebhook } from './webhooks.routes';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

const shippingSession = {
  id: 'cs_123',
  collected_information: {
    shipping_details: {
      name: 'Jade Buyer',
      address: { line1: '123 Main St', line2: null, city: 'Austin', state: 'TX', country: 'US', postal_code: '78701' },
    },
  },
};

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

  it('ignores event types other than checkout.session.completed', async () => {
    mockStripeClient.webhooks.constructEvent.mockReturnValue({ type: 'payment_intent.created', data: { object: {} } });
    const req = { headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as unknown as Request;
    const res = mockRes();
    await handleStripeWebhook(req, res);
    expect(mockPrisma.order.findUnique).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  it('does nothing if no order matches the session (resilient to unknown/stale events)', async () => {
    mockStripeClient.webhooks.constructEvent.mockReturnValue({ type: 'checkout.session.completed', data: { object: { id: 'cs_unknown' } } });
    mockPrisma.order.findUnique.mockResolvedValue(null);
    const req = { headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as unknown as Request;
    const res = mockRes();
    await handleStripeWebhook(req, res);
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  it('marks the order PAID without shipping details, and does not attempt fulfillment', async () => {
    mockStripeClient.webhooks.constructEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_123' } },
    });
    mockPrisma.order.findUnique.mockResolvedValue({ id: 'o1', stripeSessionId: 'cs_123' });
    const req = { headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as unknown as Request;
    const res = mockRes();
    await handleStripeWebhook(req, res);
    expect(mockPrisma.order.update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: { paymentStatus: 'PAID' } });
    expect(mockPrisma.fulfillmentOrder.create).not.toHaveBeenCalled();
  });

  it('captures shipping details but skips fulfillment when the product has no bound Printful variant', async () => {
    mockStripeClient.webhooks.constructEvent.mockReturnValue({ type: 'checkout.session.completed', data: { object: shippingSession } });
    mockPrisma.order.findUnique
      .mockResolvedValueOnce({ id: 'o1', stripeSessionId: 'cs_123' }) // first lookup, before update
      .mockResolvedValueOnce({
        id: 'o1',
        shippingAddress: { name: 'Jade Buyer' },
        quantity: 1,
        customerEmail: 'buyer@example.com',
        product: { id: 'p1', printfulVariantId: null },
        creator: { supplierConnections: [] },
      });
    const req = { headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as unknown as Request;
    const res = mockRes();
    await handleStripeWebhook(req, res);
    expect(mockPrisma.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: expect.objectContaining({ paymentStatus: 'PAID' }),
    });
    expect(mockCreateOrder).not.toHaveBeenCalled();
    expect(mockPrisma.fulfillmentOrder.create).not.toHaveBeenCalled();
  });

  it('creates a real Printful order when shipping + variant + an active connection are all present', async () => {
    mockStripeClient.webhooks.constructEvent.mockReturnValue({ type: 'checkout.session.completed', data: { object: shippingSession } });
    mockPrisma.order.findUnique
      .mockResolvedValueOnce({ id: 'o1', stripeSessionId: 'cs_123' })
      .mockResolvedValueOnce({
        id: 'o1',
        shippingAddress: { name: 'Jade Buyer', address1: '123 Main St', city: 'Austin', stateCode: 'TX', countryCode: 'US', zip: '78701' },
        quantity: 2,
        customerEmail: 'buyer@example.com',
        product: { id: 'p1', printfulVariantId: 4011 },
        creator: { supplierConnections: [{ id: 'conn1', provider: 'PRINTFUL', status: 'ACTIVE', encryptedAccessToken: 'enc-token' }] },
      });
    mockCreateOrder.mockResolvedValue({ id: 555, status: 'pending' });

    const req = { headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as unknown as Request;
    const res = mockRes();
    await handleStripeWebhook(req, res);

    expect(mockCreateOrder).toHaveBeenCalledWith(
      'decrypted:enc-token',
      expect.objectContaining({ name: 'Jade Buyer', address1: '123 Main St', country_code: 'US' }),
      [expect.objectContaining({ variant_id: 4011, quantity: 2, files: [{ url: 'https://api.kaziiplus.com/products/p1/print-file.png' }] })]
    );
    expect(mockPrisma.fulfillmentOrder.create).toHaveBeenCalledWith({
      data: { kaziiOrderId: 'o1', connectionId: 'conn1', provider: 'PRINTFUL', providerOrderId: '555', status: 'SUBMITTED' },
    });
  });

  it('records FAILED (not SUBMITTED) when Printful confirms with HTTP 200 but result.status is failed', async () => {
    mockStripeClient.webhooks.constructEvent.mockReturnValue({ type: 'checkout.session.completed', data: { object: shippingSession } });
    mockPrisma.order.findUnique
      .mockResolvedValueOnce({ id: 'o1', stripeSessionId: 'cs_123' })
      .mockResolvedValueOnce({
        id: 'o1',
        shippingAddress: { name: 'Jade Buyer', address1: '123 Main St', city: 'Austin', countryCode: 'US', zip: '78701' },
        quantity: 1,
        customerEmail: 'buyer@example.com',
        product: { id: 'p1', printfulVariantId: 4011 },
        creator: { supplierConnections: [{ id: 'conn1', provider: 'PRINTFUL', status: 'ACTIVE', encryptedAccessToken: 'enc-token' }] },
      });
    mockCreateOrder.mockResolvedValue({ id: 999, status: 'failed', error: 'No payment method added' });

    const req = { headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as unknown as Request;
    const res = mockRes();
    await handleStripeWebhook(req, res);

    expect(mockPrisma.fulfillmentOrder.create).toHaveBeenCalledWith({
      data: { kaziiOrderId: 'o1', connectionId: 'conn1', provider: 'PRINTFUL', providerOrderId: '999', status: 'FAILED' },
    });
  });

  it('records a FAILED fulfillment order if the Printful call throws', async () => {
    mockStripeClient.webhooks.constructEvent.mockReturnValue({ type: 'checkout.session.completed', data: { object: shippingSession } });
    mockPrisma.order.findUnique
      .mockResolvedValueOnce({ id: 'o1', stripeSessionId: 'cs_123' })
      .mockResolvedValueOnce({
        id: 'o1',
        shippingAddress: { name: 'Jade Buyer', address1: '123 Main St', city: 'Austin', countryCode: 'US', zip: '78701' },
        quantity: 1,
        customerEmail: 'buyer@example.com',
        product: { id: 'p1', printfulVariantId: 4011 },
        creator: { supplierConnections: [{ id: 'conn1', provider: 'PRINTFUL', status: 'ACTIVE', encryptedAccessToken: 'enc-token' }] },
      });
    mockCreateOrder.mockRejectedValue(new Error('Printful API error: 400'));

    const req = { headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as unknown as Request;
    const res = mockRes();
    await handleStripeWebhook(req, res);

    expect(mockPrisma.fulfillmentOrder.create).toHaveBeenCalledWith({
      data: { kaziiOrderId: 'o1', connectionId: 'conn1', provider: 'PRINTFUL', status: 'FAILED' },
    });
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });
});
