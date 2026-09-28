import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { mockFormationProvider } from './formation.mock';
import { getFormationProvider } from './formation.adapter';

const ORIGINAL_ENV = { ...process.env };
const SECRET = 'whsec_mock_test';

function sign(body: string, secret = SECRET) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

beforeEach(() => {
  process.env.FORMATION_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const input = {
  companyName: 'Jade Studio LLC',
  state: 'DE',
  founderName: 'Jade Williamson',
  founderEmail: 'jade@example.com',
  mailingAddress: { line1: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' },
};

describe('mockFormationProvider.getQuote', () => {
  it('uses the state fee table and adds a flat mock service cost', async () => {
    expect(await mockFormationProvider.getQuote('DE')).toEqual({ stateFeeCents: 11000, providerCostCents: 14900 });
  });

  it('falls back to a default state fee for states not in the table', async () => {
    expect(await mockFormationProvider.getQuote('MT')).toEqual({ stateFeeCents: 10000, providerCostCents: 13900 });
  });
});

describe('mockFormationProvider.submitFormation', () => {
  it('returns a fake provider order id', async () => {
    const result = await mockFormationProvider.submitFormation(input);
    expect(result.providerOrderId).toMatch(/^mock_/);
  });

  it('throws when the company name contains FAIL (forced-failure hook for verification)', async () => {
    await expect(mockFormationProvider.submitFormation({ ...input, companyName: 'Fail Test LLC' })).rejects.toThrow();
  });
});

describe('mockFormationProvider.parseStatusWebhook', () => {
  it('parses a correctly signed event', () => {
    const body = JSON.stringify({ providerOrderId: 'mock_1', status: 'COMPLETED', ein: '12-3456789', registeredAgentAssigned: true });
    const event = mockFormationProvider.parseStatusWebhook(Buffer.from(body), { 'x-formation-signature': sign(body) });
    expect(event).toEqual({ providerOrderId: 'mock_1', status: 'COMPLETED', ein: '12-3456789', registeredAgentAssigned: true });
  });

  it('drops unknown status values but keeps the rest', () => {
    const body = JSON.stringify({ providerOrderId: 'mock_1', status: 'WEIRD', ein: '12-3456789' });
    const event = mockFormationProvider.parseStatusWebhook(Buffer.from(body), { 'x-formation-signature': sign(body) });
    expect(event).toEqual({ providerOrderId: 'mock_1', ein: '12-3456789' });
  });

  it('throws on a wrong signature', () => {
    const body = JSON.stringify({ providerOrderId: 'mock_1', status: 'FILED' });
    expect(() => mockFormationProvider.parseStatusWebhook(Buffer.from(body), { 'x-formation-signature': sign(body, 'other') })).toThrow();
  });

  it('throws on a missing or malformed signature header', () => {
    const body = JSON.stringify({ providerOrderId: 'mock_1', status: 'FILED' });
    expect(() => mockFormationProvider.parseStatusWebhook(Buffer.from(body), {})).toThrow();
    expect(() => mockFormationProvider.parseStatusWebhook(Buffer.from(body), { 'x-formation-signature': 'zz' })).toThrow();
  });

  it('throws when the webhook secret is not configured', () => {
    delete process.env.FORMATION_WEBHOOK_SECRET;
    const body = JSON.stringify({ providerOrderId: 'mock_1', status: 'FILED' });
    expect(() => mockFormationProvider.parseStatusWebhook(Buffer.from(body), { 'x-formation-signature': sign(body) })).toThrow();
  });

  it('returns null for a validly signed body it does not understand', () => {
    const notJson = 'hello';
    expect(mockFormationProvider.parseStatusWebhook(Buffer.from(notJson), { 'x-formation-signature': sign(notJson) })).toBeNull();
    const noOrderId = JSON.stringify({ status: 'FILED' });
    expect(mockFormationProvider.parseStatusWebhook(Buffer.from(noOrderId), { 'x-formation-signature': sign(noOrderId) })).toBeNull();
  });
});

describe('getFormationProvider', () => {
  it('returns the mock provider by default', () => {
    delete process.env.FORMATION_PROVIDER;
    expect(getFormationProvider().name).toBe('MOCK');
  });

  it('throws for a provider that has no adapter yet', () => {
    process.env.FORMATION_PROVIDER = 'doola';
    expect(() => getFormationProvider()).toThrow();
  });
});
