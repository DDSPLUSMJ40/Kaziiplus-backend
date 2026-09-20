import { Request, Response } from 'express';
import Stripe from 'stripe';
import { prisma } from '../lib/prisma';
import { getStripe } from '../lib/stripe';
import { checkoutSchema } from '../schemas/checkout.schemas';

export async function createCheckoutSession(req: Request, res: Response) {
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', details: parsed.error.flatten() });
  }

  const creator = await prisma.creatorProfile.findUnique({ where: { storefrontSlug: req.params.slug } });
  if (!creator) return res.status(404).json({ error: 'not_found' });

  const product = await prisma.product.findFirst({
    where: { id: parsed.data.productId, creatorId: creator.id, status: 'LIVE' },
  });
  if (!product || product.price == null || Number(product.price) <= 0) {
    return res.status(404).json({ error: 'not_found' });
  }

  const frontendUrl = process.env.FRONTEND_URL;
  if (!frontendUrl) {
    throw new Error('FRONTEND_URL is not set. Refusing to build a checkout redirect.');
  }

  const unitPrice = Number(product.price);
  const amount = unitPrice * parsed.data.quantity;

  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          // txcd_99999999 is Stripe Tax's generic tangible-goods code --
          // correct categorization for physical merch if Stripe Tax is ever
          // enabled, independent of the Managed Payments opt-out below.
          product_data: { name: product.name, tax_code: 'txcd_99999999' },
          unit_amount: Math.round(unitPrice * 100),
        },
        quantity: parsed.data.quantity,
      },
    ],
    customer_email: parsed.data.customerEmail,
    // Required for Printful order creation, not optional metadata -- US
    // only for now, matching Printful's primary market; widen later.
    shipping_address_collection: { allowed_countries: ['US'] },
    success_url: `${frontendUrl}/store/${req.params.slug}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendUrl}/store/${req.params.slug}`,
    // Managed Payments (on by default on this Stripe account) only supports
    // digital goods -- Stripe's own eligibility docs list physical goods as
    // explicitly unsupported. Kazii sells physical merch, so it must be
    // disabled per session. Not yet in the installed SDK's TS types
    // (stripe@22.6.2), hence the cast.
    managed_payments: { enabled: false },
  } as Stripe.Checkout.SessionCreateParams);

  await prisma.order.create({
    data: {
      creatorId: creator.id,
      productId: product.id,
      customerHandle: parsed.data.customerEmail,
      amount,
      quantity: parsed.data.quantity,
      customerEmail: parsed.data.customerEmail,
      stripeSessionId: session.id,
      paymentStatus: 'PENDING',
    },
  });

  return res.json({ checkoutUrl: session.url });
}
