import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import type { FormationProvider, FormationStatusEvent, ProviderStatus } from './formation.adapter';

// Illustrative fees only -- real state filing fees come from the real provider.
const STATE_FEES_CENTS: Record<string, number> = { DE: 11000, WY: 10000, CA: 7000, TX: 30000, FL: 12500, NY: 20000 };
const DEFAULT_STATE_FEE_CENTS = 10000;
const MOCK_SERVICE_COST_CENTS = 3900;
const VALID_STATUSES: ProviderStatus[] = ['FILED', 'COMPLETED', 'FAILED'];

export const mockFormationProvider: FormationProvider = {
  name: 'MOCK',

  async getQuote(state) {
    const stateFeeCents = STATE_FEES_CENTS[state] ?? DEFAULT_STATE_FEE_CENTS;
    return { stateFeeCents, providerCostCents: stateFeeCents + MOCK_SERVICE_COST_CENTS };
  },

  async submitFormation(input) {
    // Forced-failure hook so live verification can exercise the refund path
    // with a real Stripe test payment. Safe: the mock only runs with a test key.
    if (input.companyName.toUpperCase().includes('FAIL')) {
      throw new Error('Mock provider: forced submission failure');
    }
    return { providerOrderId: `mock_${randomUUID()}` };
  },

  parseStatusWebhook(rawBody, headers) {
    const secret = process.env.FORMATION_WEBHOOK_SECRET;
    const header = headers['x-formation-signature'];
    if (!secret || typeof header !== 'string') {
      throw new Error('Missing webhook secret or signature');
    }
    const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'hex');
    const received = Buffer.from(header, 'hex');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new Error('Invalid signature');
    }

    let body: any;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return null;
    }
    if (!body || typeof body.providerOrderId !== 'string') return null;

    const event: FormationStatusEvent = { providerOrderId: body.providerOrderId };
    if (VALID_STATUSES.includes(body.status)) event.status = body.status;
    if (typeof body.ein === 'string') event.ein = body.ein;
    if (body.registeredAgentAssigned === true) event.registeredAgentAssigned = true;
    if (typeof body.failureReason === 'string') event.failureReason = body.failureReason;
    return event;
  },
};
