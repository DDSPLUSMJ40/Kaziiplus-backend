import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import type Stripe from 'stripe';

const mockPrisma = vi.hoisted(() => ({
  formationOrder: { updateMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
}));
const mockStripe = vi.hoisted(() => ({ refunds: { create: vi.fn() } }));
const mockProvider = vi.hoisted(() => ({ name: 'MOCK', submitFormation: vi.fn(), parseStatusWebhook: vi.fn() }));

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
vi.mock('../lib/stripe', () => ({ getStripe: () => mockStripe }));
vi.mock('../adapters/formation.adapter', () => ({ getFormationProvider: () => mockProvider }));

import { handleFormationPaid, handleFormationProviderWebhook } from './formation.webhook.controller';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

const session = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'cs_1',
    payment_intent: 'pi_1',
    metadata: { kind: 'formation', formationOrderId: 'fo1' },
    ...overrides,
  }) as unknown as Stripe.Checkout.Session;

const order = {
  id: 'fo1',
  companyName: 'Jade Studio LLC',
  state: 'DE',
  founderName: 'Jade Williamson',
  founderEmail: 'jade@example.com',
  mailingAddress: { line1: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mockPrisma.formationOrder.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.formationOrder.findUnique.mockResolvedValue(order);
  mockProvider.submitFormation.mockResolvedValue({ providerOrderId: 'mock_1' });
  mockStripe.refunds.create.mockResolvedValue({ id: 're_1' });
});

describe('handleFormationPaid', () => {
  it('does nothing when the session has no formationOrderId', async () => {
    await handleFormationPaid(session({ metadata: { kind: 'formation' } }));
    expect(mockPrisma.formationOrder.updateMany).not.toHaveBeenCalled();
  });

  it('is a no-op on a Stripe redelivery (the atomic claim updates 0 rows)', async () => {
    mockPrisma.formationOrder.updateMany.mockResolvedValue({ count: 0 });
    await handleFormationPaid(session());
    expect(mockProvider.submitFormation).not.toHaveBeenCalled();
    expect(mockPrisma.formationOrder.update).not.toHaveBeenCalled();
  });

  it('claims PENDING_PAYMENT -> PAID atomically, submits, and records SUBMITTED', async () => {
    await handleFormationPaid(session());
    expect(mockPrisma.formationOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'fo1', status: 'PENDING_PAYMENT' },
      data: { status: 'PAID', stripePaymentIntentId: 'pi_1' },
    });
    expect(mockProvider.submitFormation).toHaveBeenCalledWith({
      companyName: 'Jade Studio LLC',
      state: 'DE',
      founderName: 'Jade Williamson',
      founderEmail: 'jade@example.com',
      mailingAddress: { line1: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' },
    });
    expect(mockPrisma.formationOrder.update).toHaveBeenCalledWith({
      where: { id: 'fo1' },
      data: { providerOrderId: 'mock_1', status: 'SUBMITTED' },
    });
    expect(mockStripe.refunds.create).not.toHaveBeenCalled();
  });

  it('accepts an expanded payment_intent object', async () => {
    await handleFormationPaid(session({ payment_intent: { id: 'pi_obj' } }));
    expect(mockPrisma.formationOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'fo1', status: 'PENDING_PAYMENT' },
      data: { status: 'PAID', stripePaymentIntentId: 'pi_obj' },
    });
  });

  it('marks FAILED, refunds through Stripe, then marks REFUNDED when submission fails', async () => {
    mockProvider.submitFormation.mockRejectedValue(new Error('provider exploded'));
    await handleFormationPaid(session());
    expect(mockPrisma.formationOrder.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'fo1' },
      data: { status: 'FAILED', failureReason: 'submission_failed' },
    });
    expect(mockStripe.refunds.create).toHaveBeenCalledWith({ payment_intent: 'pi_1' });
    expect(mockPrisma.formationOrder.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'fo1' },
      data: { status: 'REFUNDED' },
    });
  });

  it('leaves the order FAILED with refund_failed noted if the refund itself fails', async () => {
    mockProvider.submitFormation.mockRejectedValue(new Error('provider exploded'));
    mockStripe.refunds.create.mockRejectedValue(new Error('stripe down'));
    await handleFormationPaid(session());
    expect(mockPrisma.formationOrder.update).toHaveBeenLastCalledWith({
      where: { id: 'fo1' },
      data: { failureReason: 'submission_failed; refund_failed' },
    });
    expect(mockPrisma.formationOrder.update).not.toHaveBeenCalledWith({ where: { id: 'fo1' }, data: { status: 'REFUNDED' } });
  });

  it('marks FAILED without attempting a refund when there is no payment intent', async () => {
    mockProvider.submitFormation.mockRejectedValue(new Error('provider exploded'));
    await handleFormationPaid(session({ payment_intent: null }));
    expect(mockPrisma.formationOrder.update).toHaveBeenCalledWith({
      where: { id: 'fo1' },
      data: { status: 'FAILED', failureReason: 'submission_failed' },
    });
    expect(mockStripe.refunds.create).not.toHaveBeenCalled();
  });

  it('does not throw when failAndRefund itself fails (DB error on status write)', async () => {
    mockProvider.submitFormation.mockRejectedValue(new Error('provider exploded'));
    mockPrisma.formationOrder.update.mockRejectedValueOnce(new Error('DB down'));
    await expect(handleFormationPaid(session())).resolves.not.toThrow();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('failAndRefund itself failed'), expect.any(Error));
  });
});

describe('handleFormationProviderWebhook', () => {
  const req = { body: Buffer.from('{}'), headers: {} } as unknown as Request;

  it('returns 400 invalid_signature when the provider rejects the signature', async () => {
    mockProvider.parseStatusWebhook.mockImplementation(() => {
      throw new Error('Invalid signature');
    });
    const res = mockRes();
    await handleFormationProviderWebhook(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'invalid_signature' });
  });

  it('acknowledges an event the provider chose to ignore', async () => {
    mockProvider.parseStatusWebhook.mockReturnValue(null);
    const res = mockRes();
    await handleFormationProviderWebhook(req, res);
    expect(res.json).toHaveBeenCalledWith({ received: true });
    expect(mockPrisma.formationOrder.findUnique).not.toHaveBeenCalled();
  });

  it('returns 200 and changes nothing for an unknown providerOrderId', async () => {
    mockProvider.parseStatusWebhook.mockReturnValue({ providerOrderId: 'nope', status: 'FILED' });
    mockPrisma.formationOrder.findUnique.mockResolvedValue(null);
    const res = mockRes();
    await handleFormationProviderWebhook(req, res);
    expect(mockPrisma.formationOrder.update).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  it('advances SUBMITTED -> FILED', async () => {
    mockProvider.parseStatusWebhook.mockReturnValue({ providerOrderId: 'mock_1', status: 'FILED' });
    mockPrisma.formationOrder.findUnique.mockResolvedValue({ id: 'fo1', status: 'SUBMITTED' });
    await handleFormationProviderWebhook(req, mockRes());
    expect(mockPrisma.formationOrder.update).toHaveBeenCalledWith({ where: { id: 'fo1' }, data: { status: 'FILED' } });
  });

  it('advances to COMPLETED and stores the EIN and registered-agent flag', async () => {
    mockProvider.parseStatusWebhook.mockReturnValue({
      providerOrderId: 'mock_1',
      status: 'COMPLETED',
      ein: '12-3456789',
      registeredAgentAssigned: true,
    });
    mockPrisma.formationOrder.findUnique.mockResolvedValue({ id: 'fo1', status: 'FILED' });
    await handleFormationProviderWebhook(req, mockRes());
    expect(mockPrisma.formationOrder.update).toHaveBeenCalledWith({
      where: { id: 'fo1' },
      data: { status: 'COMPLETED', ein: '12-3456789', registeredAgentAssigned: true },
    });
  });

  it('never regresses status: a late FILED after COMPLETED changes nothing', async () => {
    mockProvider.parseStatusWebhook.mockReturnValue({ providerOrderId: 'mock_1', status: 'FILED' });
    mockPrisma.formationOrder.findUnique.mockResolvedValue({ id: 'fo1', status: 'COMPLETED' });
    await handleFormationProviderWebhook(req, mockRes());
    expect(mockPrisma.formationOrder.update).not.toHaveBeenCalled();
  });

  it('stores the registered-agent flag from an event that carries no status', async () => {
    mockProvider.parseStatusWebhook.mockReturnValue({ providerOrderId: 'mock_1', registeredAgentAssigned: true });
    mockPrisma.formationOrder.findUnique.mockResolvedValue({ id: 'fo1', status: 'FILED' });
    await handleFormationProviderWebhook(req, mockRes());
    expect(mockPrisma.formationOrder.update).toHaveBeenCalledWith({ where: { id: 'fo1' }, data: { registeredAgentAssigned: true } });
  });

  it.each(['SUBMITTED', 'FILED'])('applies a provider FAILED event while the order is %s (no refund)', async (status) => {
    mockProvider.parseStatusWebhook.mockReturnValue({ providerOrderId: 'mock_1', status: 'FAILED', failureReason: 'name_rejected' });
    mockPrisma.formationOrder.findUnique.mockResolvedValue({ id: 'fo1', status });
    await handleFormationProviderWebhook(req, mockRes());
    expect(mockPrisma.formationOrder.update).toHaveBeenCalledWith({
      where: { id: 'fo1' },
      data: { status: 'FAILED', failureReason: 'name_rejected' },
    });
    expect(mockStripe.refunds.create).not.toHaveBeenCalled();
  });

  it.each(['COMPLETED', 'FAILED', 'REFUNDED'])('ignores a provider FAILED event once the order is %s', async (status) => {
    mockProvider.parseStatusWebhook.mockReturnValue({ providerOrderId: 'mock_1', status: 'FAILED' });
    mockPrisma.formationOrder.findUnique.mockResolvedValue({ id: 'fo1', status });
    await handleFormationProviderWebhook(req, mockRes());
    expect(mockPrisma.formationOrder.update).not.toHaveBeenCalled();
  });
});
