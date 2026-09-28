import { Request, Response } from 'express';
import Stripe from 'stripe';
import { prisma } from '../lib/prisma';
import { getStripe } from '../lib/stripe';
import { getFormationProvider } from '../adapters/formation.adapter';

// Forward-only ordering for provider-reported progress. A status missing from
// this map (FAILED, REFUNDED) is terminal here and never overwritten by a
// FILED/COMPLETED event.
const STATUS_RANK: Partial<Record<string, number>> = {
  PENDING_PAYMENT: 0,
  PAID: 1,
  SUBMITTED: 2,
  FILED: 3,
  COMPLETED: 4,
};

async function failAndRefund(orderId: string, paymentIntentId: string | null, reason: string) {
  await prisma.formationOrder.update({ where: { id: orderId }, data: { status: 'FAILED', failureReason: reason } });
  if (!paymentIntentId) return;

  try {
    await getStripe().refunds.create({ payment_intent: paymentIntentId });
    await prisma.formationOrder.update({ where: { id: orderId }, data: { status: 'REFUNDED' } });
  } catch (err) {
    console.error(`Formation order ${orderId}: refund failed`, err);
    await prisma.formationOrder.update({ where: { id: orderId }, data: { failureReason: `${reason}; refund_failed` } });
  }
}

export async function handleFormationPaid(session: Stripe.Checkout.Session): Promise<void> {
  const orderId = session.metadata?.formationOrderId;
  if (!orderId) return;

  const paymentIntentId =
    typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent?.id ?? null);

  // Atomic claim: only the first delivery moves PENDING_PAYMENT -> PAID. A
  // Stripe redelivery updates 0 rows and must not submit a second filing.
  const claimed = await prisma.formationOrder.updateMany({
    where: { id: orderId, status: 'PENDING_PAYMENT' },
    data: { status: 'PAID', stripePaymentIntentId: paymentIntentId },
  });
  if (claimed.count === 0) return;

  try {
    const order = await prisma.formationOrder.findUnique({ where: { id: orderId } });
    if (!order) throw new Error('order vanished after claim');

    const { providerOrderId } = await getFormationProvider().submitFormation({
      companyName: order.companyName,
      state: order.state,
      founderName: order.founderName,
      founderEmail: order.founderEmail,
      mailingAddress: order.mailingAddress as {
        line1: string;
        line2?: string;
        city: string;
        state: string;
        zip: string;
      },
    });
    await prisma.formationOrder.update({ where: { id: orderId }, data: { providerOrderId, status: 'SUBMITTED' } });
  } catch (err) {
    // Provider internals never reach the creator or the DB -- only a generic
    // reason. The Stripe response is unaffected: the payment already succeeded.
    console.error(`Formation order ${orderId}: submission failed`, err);
    await failAndRefund(orderId, paymentIntentId, 'submission_failed');
  }
}

export async function handleFormationProviderWebhook(req: Request, res: Response) {
  let event;
  try {
    event = getFormationProvider().parseStatusWebhook(req.body, req.headers);
  } catch {
    return res.status(400).json({ error: 'invalid_signature' });
  }
  if (!event) return res.json({ received: true });

  const order = await prisma.formationOrder.findUnique({ where: { providerOrderId: event.providerOrderId } });
  if (!order) return res.json({ received: true });

  const data: {
    status?: 'FILED' | 'COMPLETED' | 'FAILED';
    ein?: string;
    registeredAgentAssigned?: boolean;
    failureReason?: string;
  } = {};

  if (event.ein) data.ein = event.ein;
  if (event.registeredAgentAssigned) data.registeredAgentAssigned = true;

  if (event.status === 'FILED' || event.status === 'COMPLETED') {
    const current = STATUS_RANK[order.status];
    if (current !== undefined && (STATUS_RANK[event.status] as number) > current) {
      data.status = event.status;
    }
  } else if (event.status === 'FAILED') {
    if (order.status === 'SUBMITTED' || order.status === 'FILED') {
      // Needs human judgment, so no auto-refund: log it and surface it to the
      // creator as "we'll contact you".
      console.error(`Formation order ${order.id}: provider reported failure (${event.failureReason ?? 'unspecified'})`);
      data.status = 'FAILED';
      data.failureReason = event.failureReason ?? 'provider_failed';
    }
  }

  if (Object.keys(data).length > 0) {
    await prisma.formationOrder.update({ where: { id: order.id }, data });
  }
  return res.json({ received: true });
}
