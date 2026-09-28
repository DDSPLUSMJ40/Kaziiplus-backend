import { Response } from 'express';
import Stripe from 'stripe';
import { prisma } from '../lib/prisma';
import { getStripe } from '../lib/stripe';
import { AuthedRequest } from '../middleware/auth.middleware';
import { formationCheckoutSchema, formationQuoteQuerySchema } from '../schemas/formation.schemas';
import { getFormationProvider } from '../adapters/formation.adapter';
import { getMarkupCents, isFormationAvailable } from '../lib/formation.config';

async function getCreatorProfileId(userId: string): Promise<string | null> {
  const profile = await prisma.creatorProfile.findUnique({ where: { userId }, select: { id: true } });
  return profile?.id ?? null;
}

export async function getFormationQuote(req: AuthedRequest, res: Response) {
  if (!isFormationAvailable()) return res.status(503).json({ error: 'formation_unavailable' });

  const parsed = formationQuoteQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', details: parsed.error.flatten() });
  }

  const markupCents = getMarkupCents();
  if (markupCents === null) return res.status(503).json({ error: 'formation_unavailable' });

  let quote;
  try {
    quote = await getFormationProvider().getQuote(parsed.data.state);
  } catch {
    return res.status(503).json({ error: 'formation_unavailable' });
  }

  return res.json({
    stateFeeCents: quote.stateFeeCents,
    serviceFeeCents: quote.providerCostCents - quote.stateFeeCents + markupCents,
    totalCents: quote.providerCostCents + markupCents,
  });
}

export async function createFormationCheckout(req: AuthedRequest, res: Response) {
  if (!isFormationAvailable()) return res.status(503).json({ error: 'formation_unavailable' });

  const parsed = formationCheckoutSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', details: parsed.error.flatten() });
  }

  const creatorId = await getCreatorProfileId(req.userId!);
  if (!creatorId) return res.status(404).json({ error: 'not_found' });

  const frontendUrl = process.env.FRONTEND_URL;
  if (!frontendUrl) {
    throw new Error('FRONTEND_URL is not set. Refusing to build a checkout redirect.');
  }

  const markupCents = getMarkupCents();
  if (markupCents === null) return res.status(503).json({ error: 'formation_unavailable' });

  // The price is always recomputed here from the provider's quote -- nothing
  // the client sends can influence what Stripe charges.
  const provider = getFormationProvider();
  let quote;
  try {
    quote = await provider.getQuote(parsed.data.state);
  } catch {
    return res.status(503).json({ error: 'formation_unavailable' });
  }
  const totalCents = quote.providerCostCents + markupCents;

  const order = await prisma.formationOrder.create({
    data: {
      creatorId,
      provider: provider.name,
      companyName: parsed.data.companyName,
      state: parsed.data.state,
      founderName: parsed.data.founderName,
      founderEmail: parsed.data.founderEmail,
      mailingAddress: parsed.data.mailingAddress,
      providerCostCents: quote.providerCostCents,
      stateFeeCents: quote.stateFeeCents,
      markupCents,
      totalCents,
    },
  });

  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: `LLC formation — ${parsed.data.companyName}`,
            description: `Includes the ${parsed.data.state} state filing fee`,
          },
          unit_amount: totalCents,
        },
        quantity: 1,
      },
    ],
    customer_email: parsed.data.founderEmail,
    metadata: { kind: 'formation', formationOrderId: order.id },
    success_url: `${frontendUrl}/?formation=success`,
    cancel_url: `${frontendUrl}/?formation=cancelled`,
    // Managed Payments (on by default on this Stripe account) only supports
    // digital goods; a filing service is not one, so it is disabled per
    // session exactly as in checkout.controller.ts. Not yet in the installed
    // SDK's TS types, hence the cast.
    managed_payments: { enabled: false },
  } as Stripe.Checkout.SessionCreateParams);

  await prisma.formationOrder.update({ where: { id: order.id }, data: { stripeSessionId: session.id } });

  return res.json({ url: session.url });
}

export async function listFormationOrders(req: AuthedRequest, res: Response) {
  if (!isFormationAvailable()) return res.status(503).json({ error: 'formation_unavailable' });

  const creatorId = await getCreatorProfileId(req.userId!);
  if (!creatorId) return res.status(404).json({ error: 'not_found' });

  // Unpaid attempts are hidden; there is no cleanup job in v1.
  const orders = await prisma.formationOrder.findMany({
    where: { creatorId, status: { not: 'PENDING_PAYMENT' } },
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

  return res.json({ orders });
}
