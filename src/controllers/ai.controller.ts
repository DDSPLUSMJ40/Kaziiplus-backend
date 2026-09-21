import { Response } from 'express';
import { prisma } from '../lib/prisma';
import { AuthedRequest } from '../middleware/auth.middleware';
import { generateDesignSchema } from '../schemas/ai.schemas';
import { generateImage } from '../adapters/replicate.adapter';

const MONTHLY_GENERATION_LIMIT = 10;

async function getCreatorProfileId(userId: string): Promise<string | null> {
  const profile = await prisma.creatorProfile.findUnique({ where: { userId }, select: { id: true } });
  return profile?.id ?? null;
}

function startOfCurrentMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export async function generateDesign(req: AuthedRequest, res: Response) {
  const parsed = generateDesignSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', details: parsed.error.flatten() });
  }
  const creatorId = await getCreatorProfileId(req.userId!);
  if (!creatorId) return res.status(404).json({ error: 'not_found' });

  const usedThisMonth = await prisma.aiGeneration.count({
    where: { creatorId, createdAt: { gte: startOfCurrentMonth() } },
  });
  if (usedThisMonth >= MONTHLY_GENERATION_LIMIT) {
    return res.status(429).json({ error: 'generation_limit_reached', usedThisMonth, limit: MONTHLY_GENERATION_LIMIT });
  }

  let imageBuffer: Buffer;
  try {
    imageBuffer = await generateImage(parsed.data.prompt);
  } catch {
    // Fairness rule: no AiGeneration row is written on failure, so a
    // Replicate outage never consumes the creator's monthly quota.
    return res.status(500).json({ error: 'generation_failed' });
  }

  await prisma.aiGeneration.create({ data: { creatorId, prompt: parsed.data.prompt } });

  return res.json({
    imageBase64: imageBuffer.toString('base64'),
    usedThisMonth: usedThisMonth + 1,
    limit: MONTHLY_GENERATION_LIMIT,
  });
}
