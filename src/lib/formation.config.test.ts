import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getMarkupCents, isFormationAvailable } from './formation.config';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.FORMATION_ENABLED = 'true';
  process.env.FORMATION_PROVIDER = 'mock';
  process.env.FORMATION_MARKUP_CENTS = '7900';
  process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('getMarkupCents', () => {
  it('parses a non-negative integer', () => {
    expect(getMarkupCents()).toBe(7900);
  });

  it('accepts zero', () => {
    process.env.FORMATION_MARKUP_CENTS = '0';
    expect(getMarkupCents()).toBe(0);
  });

  it.each(['abc', '-5', '12.5', '', ' 7900'])('returns null for invalid value %j', (value) => {
    process.env.FORMATION_MARKUP_CENTS = value;
    expect(getMarkupCents()).toBeNull();
  });

  it('returns null when unset', () => {
    delete process.env.FORMATION_MARKUP_CENTS;
    expect(getMarkupCents()).toBeNull();
  });
});

describe('isFormationAvailable', () => {
  it('is available when enabled, markup valid, mock provider, and a test Stripe key', () => {
    expect(isFormationAvailable()).toBe(true);
  });

  it('defaults the provider to mock when FORMATION_PROVIDER is unset', () => {
    delete process.env.FORMATION_PROVIDER;
    expect(isFormationAvailable()).toBe(true);
  });

  it('is unavailable unless FORMATION_ENABLED is exactly "true"', () => {
    process.env.FORMATION_ENABLED = 'yes';
    expect(isFormationAvailable()).toBe(false);
    delete process.env.FORMATION_ENABLED;
    expect(isFormationAvailable()).toBe(false);
  });

  it('is unavailable when the markup is missing or invalid', () => {
    delete process.env.FORMATION_MARKUP_CENTS;
    expect(isFormationAvailable()).toBe(false);
    process.env.FORMATION_MARKUP_CENTS = 'lots';
    expect(isFormationAvailable()).toBe(false);
  });

  it('refuses the mock provider with a live Stripe key (never charge real cards for a fake filing)', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_abc123';
    expect(isFormationAvailable()).toBe(false);
  });

  it('refuses the mock provider when the Stripe key is missing', () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(isFormationAvailable()).toBe(false);
  });

  it('is unavailable for a provider that has no adapter yet', () => {
    process.env.FORMATION_PROVIDER = 'doola';
    expect(isFormationAvailable()).toBe(false);
  });
});
