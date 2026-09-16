import Stripe from 'stripe';

let cachedClient: Stripe | null = null;

// Lazy, checked-on-use -- same reasoning as auth.controller.ts's JWT_SECRET
// check: throwing here at import time would crash the whole server (health
// check and auth included) if STRIPE_SECRET_KEY isn't set yet at deploy time.
export function getStripe(): Stripe {
  if (cachedClient) return cachedClient;
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not set. Refusing to create a Stripe client.');
  }
  cachedClient = new Stripe(secretKey);
  return cachedClient;
}
