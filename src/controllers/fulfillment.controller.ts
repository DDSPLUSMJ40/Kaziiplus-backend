import { Response } from 'express';
import { prisma } from '../lib/prisma';
import { AuthedRequest } from '../middleware/auth.middleware';
import { encrypt, decrypt } from '../lib/crypto';
import { validateToken, listCatalog, getCatalogProduct, PrintfulAuthError } from '../adapters/printful.adapter';
import { printfulConnectSchema } from '../schemas/fulfillment.schemas';

async function getCreatorProfileId(userId: string): Promise<string | null> {
  const profile = await prisma.creatorProfile.findUnique({ where: { userId }, select: { id: true } });
  return profile?.id ?? null;
}

async function getActiveConnection(creatorId: string) {
  return prisma.supplierConnection.findUnique({
    where: { creatorId_provider: { creatorId, provider: 'PRINTFUL' } },
  });
}

export async function connectPrintful(req: AuthedRequest, res: Response) {
  const parsed = printfulConnectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', details: parsed.error.flatten() });
  }
  const creatorId = await getCreatorProfileId(req.userId!);
  if (!creatorId) return res.status(404).json({ error: 'not_found' });

  try {
    await validateToken(parsed.data.apiToken);
  } catch (err) {
    if (err instanceof PrintfulAuthError) {
      return res.status(400).json({ error: 'invalid_printful_token' });
    }
    throw err;
  }

  const encryptedAccessToken = encrypt(parsed.data.apiToken);
  const connection = await prisma.supplierConnection.upsert({
    where: { creatorId_provider: { creatorId, provider: 'PRINTFUL' } },
    create: { creatorId, provider: 'PRINTFUL', encryptedAccessToken, status: 'ACTIVE' },
    update: { encryptedAccessToken, status: 'ACTIVE' },
  });
  return res.status(200).json({ connected: true, connectedAt: connection.connectedAt });
}

export async function disconnectPrintful(req: AuthedRequest, res: Response) {
  const creatorId = await getCreatorProfileId(req.userId!);
  if (!creatorId) return res.status(404).json({ error: 'not_found' });

  await prisma.supplierConnection
    .delete({ where: { creatorId_provider: { creatorId, provider: 'PRINTFUL' } } })
    .catch(() => null); // already disconnected -- idempotent either way
  return res.status(204).send();
}

export async function getPrintfulCatalog(req: AuthedRequest, res: Response) {
  const creatorId = await getCreatorProfileId(req.userId!);
  if (!creatorId) return res.status(404).json({ error: 'not_found' });

  const connection = await getActiveConnection(creatorId);
  if (!connection || connection.status !== 'ACTIVE') {
    return res.status(404).json({ error: 'not_connected' });
  }

  try {
    const catalog = await listCatalog(decrypt(connection.encryptedAccessToken));
    return res.json({ catalog });
  } catch (err) {
    if (err instanceof PrintfulAuthError) {
      await prisma.supplierConnection.update({ where: { id: connection.id }, data: { status: 'ERROR' } });
      return res.status(400).json({ error: 'printful_token_invalid' });
    }
    throw err;
  }
}

export async function getPrintfulCatalogProduct(req: AuthedRequest, res: Response) {
  const creatorId = await getCreatorProfileId(req.userId!);
  if (!creatorId) return res.status(404).json({ error: 'not_found' });

  const connection = await getActiveConnection(creatorId);
  if (!connection || connection.status !== 'ACTIVE') {
    return res.status(404).json({ error: 'not_connected' });
  }

  try {
    const product = await getCatalogProduct(decrypt(connection.encryptedAccessToken), req.params.id);
    return res.json({ product });
  } catch (err) {
    if (err instanceof PrintfulAuthError) {
      await prisma.supplierConnection.update({ where: { id: connection.id }, data: { status: 'ERROR' } });
      return res.status(400).json({ error: 'printful_token_invalid' });
    }
    throw err;
  }
}
