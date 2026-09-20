import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { AuthedRequest } from '../middleware/auth.middleware';
import { createProductSchema, updateProductSchema } from '../schemas/products.schemas';

async function getCreatorProfileId(userId: string): Promise<string | null> {
  const profile = await prisma.creatorProfile.findUnique({ where: { userId }, select: { id: true } });
  return profile?.id ?? null;
}

// printFileData is raw image bytes -- never put it in a JSON response (bloats
// the payload and doesn't serialize meaningfully anyway). Callers that need
// the actual bytes use GET /products/:id/print-file.png instead.
function serializeProduct(product: Record<string, unknown>) {
  const { printFileData, ...rest } = product;
  return { ...rest, hasPrintFile: !!printFileData };
}

function toPrismaData<T extends { printFileBase64?: string }>(parsed: T) {
  const { printFileBase64, ...rest } = parsed;
  return {
    ...rest,
    ...(printFileBase64 ? { printFileData: Buffer.from(printFileBase64, 'base64') } : {}),
  };
}

export async function createProduct(req: AuthedRequest, res: Response) {
  const parsed = createProductSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', details: parsed.error.flatten() });
  }
  const creatorId = await getCreatorProfileId(req.userId!);
  if (!creatorId) return res.status(404).json({ error: 'not_found' });

  const product = await prisma.product.create({ data: { creatorId, ...toPrismaData(parsed.data) } });
  return res.status(201).json({ product: serializeProduct(product) });
}

export async function listProducts(req: AuthedRequest, res: Response) {
  const creatorId = await getCreatorProfileId(req.userId!);
  if (!creatorId) return res.status(404).json({ error: 'not_found' });

  const products = await prisma.product.findMany({ where: { creatorId }, orderBy: { createdAt: 'desc' } });
  return res.json({ products: products.map(serializeProduct) });
}

export async function getProduct(req: AuthedRequest, res: Response) {
  const creatorId = await getCreatorProfileId(req.userId!);
  if (!creatorId) return res.status(404).json({ error: 'not_found' });

  const product = await prisma.product.findFirst({ where: { id: req.params.id, creatorId } });
  if (!product) return res.status(404).json({ error: 'not_found' });
  return res.json({ product: serializeProduct(product) });
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

  const product = await prisma.product.update({ where: { id: existing.id }, data: toPrismaData(parsed.data) });
  return res.json({ product: serializeProduct(product) });
}

export async function deleteProduct(req: AuthedRequest, res: Response) {
  const creatorId = await getCreatorProfileId(req.userId!);
  if (!creatorId) return res.status(404).json({ error: 'not_found' });

  const existing = await prisma.product.findFirst({ where: { id: req.params.id, creatorId } });
  if (!existing) return res.status(404).json({ error: 'not_found' });

  await prisma.product.delete({ where: { id: existing.id } });
  return res.status(204).send();
}

// Public (no auth) -- fulfillment providers like Printful fetch this URL
// directly, they don't have (and shouldn't need) a creator's JWT.
export async function getPrintFile(req: Request, res: Response) {
  const product = await prisma.product.findUnique({
    where: { id: req.params.id },
    select: { printFileData: true },
  });
  if (!product?.printFileData) return res.status(404).json({ error: 'not_found' });

  res.set('Content-Type', 'image/png');
  return res.send(product.printFileData);
}
