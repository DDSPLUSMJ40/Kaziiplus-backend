// Providers with a real adapter. Add 'doola' here in the same commit that
// adds src/adapters/doola.adapter.ts -- never before, or a misconfigured
// deploy would pass the guard and then throw inside getFormationProvider().
const IMPLEMENTED_PROVIDERS = ['mock'];

export function getMarkupCents(): number | null {
  const raw = process.env.FORMATION_MARKUP_CENTS;
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

export function isFormationAvailable(): boolean {
  if (process.env.FORMATION_ENABLED !== 'true') return false;
  if (getMarkupCents() === null) return false;

  const provider = (process.env.FORMATION_PROVIDER ?? 'mock').toLowerCase();
  if (!IMPLEMENTED_PROVIDERS.includes(provider)) return false;

  // The mock provider files nothing. It must never sit in front of a live
  // Stripe key, or real cards would be charged for a filing that never happens.
  if (provider === 'mock' && !(process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_test_')) return false;

  return true;
}
