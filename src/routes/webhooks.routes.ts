import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { prisma } from '../lib/prisma';
import { getStripe } from '../lib/stripe';
import { decrypt } from '../lib/crypto';
import { createOrder, PrintfulRecipient } from '../adapters/printful.adapter';

// Public URL fulfillment providers fetch print files from -- same domain
// the frontend's API_BASE_URL points at, hardcoded there for the same
// reason (this codebase has no build step / env-driven config for it).
const BACKEND_PUBLIC_URL = 'https://api.kaziiplus.com';

function extractShippingAddress(session: Stripe.Checkout.Session) {
  const details = session.collected_information?.shipping_details;
  if (!details?.address || !details.name) return null;
  return {
    name: details.name,
    address1: details.address.line1,
    address2: details.address.line2 ?? undefined,
    city: details.address.city,
    stateCode: details.address.state ?? undefined,
    countryCode: details.address.country,
    zip: details.address.postal_code,
  };
}

// Best-effort: a Printful failure here must never affect the Stripe
// response (the payment already succeeded) -- errors are recorded on a
// FulfillmentOrder row, not thrown back to the webhook caller.
async function attemptPrintfulFulfillment(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { product: true, creator: { include: { supplierConnections: true } } },
  });
  if (!order || !order.shippingAddress || order.product.printfulVariantId == null) return;

  const connection = order.creator.supplierConnections.find(
    (c) => c.provider === 'PRINTFUL' && c.status === 'ACTIVE'
  );
  if (!connection) return;

  const shipping = order.shippingAddress as {
    name: string;
    address1: string;
    address2?: string;
    city: string;
    stateCode?: string;
    countryCode: string;
    zip: string;
  };
  const recipient: PrintfulRecipient = {
    name: shipping.name,
    address1: shipping.address1,
    address2: shipping.address2,
    city: shipping.city,
    state_code: shipping.stateCode,
    country_code: shipping.countryCode,
    zip: shipping.zip,
    email: order.customerEmail ?? undefined,
  };

  try {
    const printfulOrder = await createOrder(decrypt(connection.encryptedAccessToken), recipient, [
      {
        variant_id: order.product.printfulVariantId,
        quantity: order.quantity,
        files: [{ url: `${BACKEND_PUBLIC_URL}/products/${order.product.id}/print-file.png` }],
      },
    ]);
    await prisma.fulfillmentOrder.create({
      data: {
        kaziiOrderId: order.id,
        connectionId: connection.id,
        provider: 'PRINTFUL',
        providerOrderId: String(printfulOrder.id),
        status: 'SUBMITTED',
      },
    });
  } catch {
    await prisma.fulfillmentOrder.create({
      data: { kaziiOrderId: order.id, connectionId: connection.id, provider: 'PRINTFUL', status: 'FAILED' },
    });
  }
}

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
    const session = event.data.object as Stripe.Checkout.Session;
    const shippingAddress = extractShippingAddress(session);

    const order = await prisma.order.findUnique({ where: { stripeSessionId: session.id } });
    if (order) {
      await prisma.order.update({
        where: { id: order.id },
        data: { paymentStatus: 'PAID', ...(shippingAddress ? { shippingAddress } : {}) },
      });
      if (shippingAddress) {
        await attemptPrintfulFulfillment(order.id);
      }
    }
  }

  return res.json({ received: true });
}

const router = Router();
router.post('/stripe', handleStripeWebhook);

export default router;
