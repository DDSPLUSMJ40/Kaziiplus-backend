import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { AuthedRequest } from '../middleware/auth.middleware';
import { updateStorefrontSchema } from '../schemas/storefront.schemas';

export async function getStorefront(req: Request, res: Response) {
  const creator = await prisma.creatorProfile.findUnique({
    where: { storefrontSlug: req.params.slug },
    select: {
      brandName: true,
      firstName: true,
      storefrontLive: true,
      products: { where: { status: 'LIVE' }, select: { id: true, name: true, productType: true, color: true, price: true } },
    },
  });
  if (!creator) return res.status(404).json({ error: 'not_found' });

  const brandName = creator.brandName ?? creator.firstName;
  if (!creator.storefrontLive) {
    return res.json({ live: false, brandName });
  }
  return res.json({ live: true, brandName, products: creator.products });
}

export async function updateMyStorefront(req: AuthedRequest, res: Response) {
  const parsed = updateStorefrontSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', details: parsed.error.flatten() });
  }

  if (parsed.data.storefrontSlug) {
    const existing = await prisma.creatorProfile.findUnique({ where: { storefrontSlug: parsed.data.storefrontSlug } });
    if (existing && existing.userId !== req.userId) {
      return res.status(409).json({ error: 'slug_taken', message: 'That storefront link is already in use.' });
    }
  }

  const creator = await prisma.creatorProfile.update({ where: { userId: req.userId! }, data: parsed.data });
  return res.json({ creator });
}

export async function getMyOrders(req: AuthedRequest, res: Response) {
  const creator = await prisma.creatorProfile.findUnique({ where: { userId: req.userId! }, select: { id: true } });
  if (!creator) return res.status(404).json({ error: 'not_found' });

  const orders = await prisma.order.findMany({
    where: { creatorId: creator.id },
    orderBy: { createdAt: 'desc' },
    include: { product: { select: { name: true } } },
  });
  return res.json({ orders });
}
