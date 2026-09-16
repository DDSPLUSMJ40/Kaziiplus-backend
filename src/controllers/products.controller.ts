import { Response } from 'express';
import { prisma } from '../lib/prisma';
import { AuthedRequest } from '../middleware/auth.middleware';
import { createProductSchema, updateProductSchema } from '../schemas/products.schemas';

async function getCreatorProfileId(userId: string): Promise<string | null> {
  const profile = await prisma.creatorProfile.findUnique({ where: { userId }, select: { id: true } });
  return profile?.id ?? null;
}

export async function createProduct(req: AuthedRequest, res: Response) {
  const parsed = createProductSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', details: parsed.error.flatten() });
  }
  const creatorId = await getCreatorProfileId(req.userId!);
  if (!creatorId) return res.status(404).json({ error: 'not_found' });

  const product = await prisma.product.create({ data: { creatorId, ...parsed.data } });
  return res.status(201).json({ product });
}

export async function listProducts(req: AuthedRequest, res: Response) {
  const creatorId = await getCreatorProfileId(req.userId!);
  if (!creatorId) return res.status(404).json({ error: 'not_found' });

  const products = await prisma.product.findMany({ where: { creatorId }, orderBy: { createdAt: 'desc' } });
  return res.json({ products });
}

export async function getProduct(req: AuthedRequest, res: Response) {
  const creatorId = await getCreatorProfileId(req.userId!);
  if (!creatorId) return res.status(404).json({ error: 'not_found' });

  const product = await prisma.product.findFirst({ where: { id: req.params.id, creatorId } });
  if (!product) return res.status(404).json({ error: 'not_found' });
  return res.json({ product });
}

export async function updateProduct(req: AuthedRequest, res: Response) {
  const parsed = updateProductSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', details: parsed.error.flatten() });
  }
  const creatorId = await getCreatorProfileId(req.userId!);
  if (!creatorId) return res.status(404).json({ error: 'not_found' });

  const existing = await prisma.product.findFirst({ where: { id: req.params.id, creatorId } });
  if (!existing) return res.status(404).json({ error: 'not_found' });

  const product = await prisma.product.update({ where: { id: existing.id }, data: parsed.data });
  return res.json({ product });
}

export async function deleteProduct(req: AuthedRequest, res: Response) {
  const creatorId = await getCreatorProfileId(req.userId!);
  if (!creatorId) return res.status(404).json({ error: 'not_found' });

  const existing = await prisma.product.findFirst({ where: { id: req.params.id, creatorId } });
  if (!existing) return res.status(404).json({ error: 'not_found' });

  await prisma.product.delete({ where: { id: existing.id } });
  return res.status(204).send();
}
