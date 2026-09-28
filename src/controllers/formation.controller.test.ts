import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Response } from 'express';
import type { AuthedRequest } from '../middleware/auth.middleware';

const mockPrisma = vi.hoisted(() => ({
  creatorProfile: { findUnique: vi.fn() },
  formationOrder: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
}));
const mockStripe = vi.hoisted(() => ({ checkout: { sessions: { create: vi.fn() } } }));
const mockProvider = vi.hoisted(() => ({ name: 'MOCK', getQuote: vi.fn() }));

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
vi.mock('../lib/stripe', () => ({ getStripe: () => mockStripe }));
vi.mock('../adapters/formation.adapter', () => ({ getFormationProvider: () => mockProvider }));

import { getFormationQuote, createFormationCheckout, listFormationOrders } from './formation.controller';

const ORIGINAL_ENV = { ...process.env };

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

const validBody = {
  companyName: 'Jade Studio LLC',
  state: 'DE',
  founderName: 'Jade Williamson',
  founderEmail: 'jade@example.com',
  mailingAddress: { line1: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' },
  acknowledged: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FORMATION_ENABLED = 'true';
  process.env.FORMATION_PROVIDER = 'mock';
  process.env.FORMATION_MARKUP_CENTS = '7900';
  process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';
  process.env.FRONTEND_URL = 'https://www.kaziiplus.com';
  mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
  mockProvider.getQuote.mockResolvedValue({ providerCostCents: 14900, stateFeeCents: 11000 });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('getFormationQuote', () => {
  it('returns 503 when formation is unavailable', async () => {
    delete process.env.FORMATION_ENABLED;
    const res = mockRes();
    await getFormationQuote({ query: { state: 'DE' }, userId: 'u1' } as unknown as AuthedRequest, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: 'formation_unavailable' });
  });

  it('returns 400 for an invalid state', async () => {
    const res = mockRes();
    await getFormationQuote({ query: { state: 'ZZ' }, userId: 'u1' } as unknown as AuthedRequest, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns the fee breakdown: service fee = provider cost - state fee + markup', async () => {
    const res = mockRes();
    await getFormationQuote({ query: { state: 'DE' }, userId: 'u1' } as unknown as AuthedRequest, res);
    expect(res.json).toHaveBeenCalledWith({ stateFeeCents: 11000, serviceFeeCents: 11800, totalCents: 22800 });
  });

  it('returns 503 when the provider cannot produce a quote', async () => {
    mockProvider.getQuote.mockRejectedValue(new Error('provider down'));
    const res = mockRes();
    await getFormationQuote({ query: { state: 'DE' }, userId: 'u1' } as unknown as AuthedRequest, res);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

describe('createFormationCheckout', () => {
  it('returns 503 when formation is unavailable (e.g. mock provider with a live Stripe key)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_abc123';
    const res = mockRes();
    await createFormationCheckout({ body: validBody, userId: 'u1' } as AuthedRequest, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('returns 400 when the acknowledgement is missing', async () => {
    const res = mockRes();
    await createFormationCheckout({ body: { ...validBody, acknowledged: false }, userId: 'u1' } as AuthedRequest, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.formationOrder.create).not.toHaveBeenCalled();
  });

  it('returns 404 when the caller has no creator profile', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue(null);
    const res = mockRes();
    await createFormationCheckout({ body: validBody, userId: 'u1' } as AuthedRequest, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('creates a PENDING order with server-computed frozen amounts, then a tagged Stripe session', async () => {
    mockPrisma.formationOrder.create.mockResolvedValue({ id: 'fo1' });
    mockStripe.checkout.sessions.create.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/pay/cs_1' });
    const res = mockRes();
    await createFormationCheckout({ body: validBody, userId: 'u1' } as AuthedRequest, res);

    expect(mockPrisma.formationOrder.create).toHaveBeenCalledWith({
      data: {
        creatorId: 'c1',
        provider: 'MOCK',
        companyName: 'Jade Studio LLC',
        state: 'DE',
        founderName: 'Jade Williamson',
        founderEmail: 'jade@example.com',
        mailingAddress: { line1: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' },
        providerCostCents: 14900,
        stateFeeCents: 11000,
        markupCents: 7900,
        totalCents: 22800,
      },
    });
    const sessionArgs = mockStripe.checkout.sessions.create.mock.calls[0][0];
    expect(sessionArgs.mode).toBe('payment');
    expect(sessionArgs.payment_method_types).toEqual(['card']);
    expect(sessionArgs.line_items[0].price_data.unit_amount).toBe(22800);
    expect(sessionArgs.metadata).toEqual({ kind: 'formation', formationOrderId: 'fo1' });
    expect(sessionArgs.customer_email).toBe('jade@example.com');
    expect(sessionArgs.success_url).toBe('https://www.kaziiplus.com/?formation=success');
    expect(sessionArgs.cancel_url).toBe('https://www.kaziiplus.com/?formation=cancelled');
    expect(mockPrisma.formationOrder.update).toHaveBeenCalledWith({ where: { id: 'fo1' }, data: { stripeSessionId: 'cs_1' } });
    expect(res.json).toHaveBeenCalledWith({ url: 'https://checkout.stripe.com/pay/cs_1' });
  });

  it('ignores any price the client sends', async () => {
    mockPrisma.formationOrder.create.mockResolvedValue({ id: 'fo1' });
    mockStripe.checkout.sessions.create.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/pay/cs_1' });
    const res = mockRes();
    await createFormationCheckout({ body: { ...validBody, totalCents: 1, markupCents: 0 }, userId: 'u1' } as AuthedRequest, res);
    expect(mockStripe.checkout.sessions.create.mock.calls[0][0].line_items[0].price_data.unit_amount).toBe(22800);
  });

  it('returns 503 when the provider cannot produce a quote', async () => {
    mockProvider.getQuote.mockRejectedValue(new Error('provider down'));
    const res = mockRes();
    await createFormationCheckout({ body: validBody, userId: 'u1' } as AuthedRequest, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(mockPrisma.formationOrder.create).not.toHaveBeenCalled();
  });
});

describe('listFormationOrders', () => {
  it('returns 503 when formation is unavailable', async () => {
    delete process.env.FORMATION_ENABLED;
    const res = mockRes();
    await listFormationOrders({ userId: 'u1' } as AuthedRequest, res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('returns 404 when the caller has no creator profile', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue(null);
    const res = mockRes();
    await listFormationOrders({ userId: 'u1' } as AuthedRequest, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("lists only the caller's paid-or-later orders, newest first", async () => {
    mockPrisma.formationOrder.findMany.mockResolvedValue([{ id: 'fo1', status: 'SUBMITTED' }]);
    const res = mockRes();
    await listFormationOrders({ userId: 'u1' } as AuthedRequest, res);
    expect(mockPrisma.formationOrder.findMany).toHaveBeenCalledWith({
      where: { creatorId: 'c1', status: { not: 'PENDING_PAYMENT' } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        companyName: true,
        state: true,
        founderEmail: true,
        status: true,
        totalCents: true,
        ein: true,
        registeredAgentAssigned: true,
        createdAt: true,
      },
    });
    expect(res.json).toHaveBeenCalledWith({ orders: [{ id: 'fo1', status: 'SUBMITTED' }] });
  });
});
