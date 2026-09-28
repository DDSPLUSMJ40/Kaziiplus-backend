import { describe, it, expect } from 'vitest';
import { USPS_STATES, formationCheckoutSchema, formationQuoteQuerySchema } from './formation.schemas';

const valid = {
  companyName: 'Jade Studio LLC',
  state: 'DE',
  founderName: 'Jade Williamson',
  founderEmail: 'jade@example.com',
  mailingAddress: { line1: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' },
  acknowledged: true,
};

describe('USPS_STATES', () => {
  it('lists exactly the 50 states', () => {
    expect(USPS_STATES).toHaveLength(50);
    expect(new Set(USPS_STATES).size).toBe(50);
  });
});

describe('formationQuoteQuerySchema', () => {
  it('accepts a valid state', () => {
    expect(formationQuoteQuerySchema.safeParse({ state: 'WY' }).success).toBe(true);
  });
  it('rejects an unknown state', () => {
    expect(formationQuoteQuerySchema.safeParse({ state: 'ZZ' }).success).toBe(false);
  });
});

describe('formationCheckoutSchema', () => {
  it('accepts a valid payload', () => {
    expect(formationCheckoutSchema.safeParse(valid).success).toBe(true);
  });

  it.each(['Jade Studio llc', 'Jade Studio, LLC', 'Jade Studio LLC '])('accepts LLC suffix in %j', (companyName) => {
    expect(formationCheckoutSchema.safeParse({ ...valid, companyName }).success).toBe(true);
  });

  it.each(['Jade Studio', 'Jade Studio Inc', 'Jade LLC Holdings', ''])('rejects a name that does not end in LLC: %j', (companyName) => {
    expect(formationCheckoutSchema.safeParse({ ...valid, companyName }).success).toBe(false);
  });

  it('rejects a name over 120 characters', () => {
    expect(formationCheckoutSchema.safeParse({ ...valid, companyName: `${'A'.repeat(118)} LLC` }).success).toBe(false);
  });

  it('requires the acknowledgement to be literally true', () => {
    expect(formationCheckoutSchema.safeParse({ ...valid, acknowledged: false }).success).toBe(false);
    const { acknowledged: _omit, ...withoutAck } = valid;
    expect(formationCheckoutSchema.safeParse(withoutAck).success).toBe(false);
  });

  it('rejects a bad formation state, mailing state, or zip', () => {
    expect(formationCheckoutSchema.safeParse({ ...valid, state: 'ZZ' }).success).toBe(false);
    expect(formationCheckoutSchema.safeParse({ ...valid, mailingAddress: { ...valid.mailingAddress, state: 'ZZ' } }).success).toBe(false);
    expect(formationCheckoutSchema.safeParse({ ...valid, mailingAddress: { ...valid.mailingAddress, zip: '787' } }).success).toBe(false);
  });

  it('accepts ZIP+4', () => {
    expect(formationCheckoutSchema.safeParse({ ...valid, mailingAddress: { ...valid.mailingAddress, zip: '78701-1234' } }).success).toBe(true);
  });

  it('rejects a bad founder email', () => {
    expect(formationCheckoutSchema.safeParse({ ...valid, founderEmail: 'not-an-email' }).success).toBe(false);
  });

  it('strips client-sent price fields rather than trusting them', () => {
    const result = formationCheckoutSchema.safeParse({ ...valid, totalCents: 1 });
    expect(result.success).toBe(true);
    if (result.success) expect('totalCents' in result.data).toBe(false);
  });
});
