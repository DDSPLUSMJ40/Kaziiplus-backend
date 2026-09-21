import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response } from 'express';
import type { AuthedRequest } from '../middleware/auth.middleware';

const mockPrisma = vi.hoisted(() => ({
  creatorProfile: { findUnique: vi.fn() },
  aiGeneration: { count: vi.fn(), create: vi.fn() },
}));

const mockGenerateImage = vi.hoisted(() => vi.fn());

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
vi.mock('../adapters/replicate.adapter', () => ({ generateImage: mockGenerateImage }));

import { generateDesign } from './ai.controller';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
});

describe('generateDesign', () => {
  it('returns 400 on an empty prompt', async () => {
    const req = { body: { prompt: '' }, userId: 'u1' } as AuthedRequest;
    const res = mockRes();
    await generateDesign(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });

  it('returns 404 if the caller has no creator profile', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue(null);
    const req = { body: { prompt: 'a mountain' }, userId: 'u1' } as AuthedRequest;
    const res = mockRes();
    await generateDesign(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 429 without calling Replicate when the monthly cap is reached', async () => {
    mockPrisma.aiGeneration.count.mockResolvedValue(10);
    const req = { body: { prompt: 'a mountain' }, userId: 'u1' } as AuthedRequest;
    const res = mockRes();
    await generateDesign(req, res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });

  it('does not create an AiGeneration row if Replicate throws (fairness rule)', async () => {
    mockPrisma.aiGeneration.count.mockResolvedValue(3);
    mockGenerateImage.mockRejectedValue(new Error('Replicate down'));
    const req = { body: { prompt: 'a mountain' }, userId: 'u1' } as AuthedRequest;
    const res = mockRes();
    await generateDesign(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockPrisma.aiGeneration.create).not.toHaveBeenCalled();
  });

  it('creates an AiGeneration row and returns base64 on success', async () => {
    mockPrisma.aiGeneration.count.mockResolvedValue(3);
    mockGenerateImage.mockResolvedValue(Buffer.from([1, 2, 3]));
    const req = { body: { prompt: 'a mountain' }, userId: 'u1' } as AuthedRequest;
    const res = mockRes();
    await generateDesign(req, res);
    expect(mockPrisma.aiGeneration.create).toHaveBeenCalledWith({ data: { creatorId: 'c1', prompt: 'a mountain' } });
    expect(res.json).toHaveBeenCalledWith({
      imageBase64: Buffer.from([1, 2, 3]).toString('base64'),
      usedThisMonth: 4,
      limit: 10,
    });
  });
});
