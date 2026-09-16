import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { getStripe } from '../lib/stripe';

export async function handleStripeWebhook(req: Request, res: Response) {
  const signature = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret || typeof signature !== 'string') {
    return res.status(400).json({ error: 'invalid_signature' });
  }

  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch {
    return res.status(400).json({ error: 'invalid_signature' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as { id: string };
    await prisma.order.updateMany({ where: { stripeSessionId: session.id }, data: { paymentStatus: 'PAID' } });
  }

  return res.json({ received: true });
}

const router = Router();
router.post('/stripe', handleStripeWebhook);

export default router;
