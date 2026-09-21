import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateImage, ReplicateError } from './replicate.adapter';

const originalFetch = global.fetch;

beforeEach(() => {
  process.env.REPLICATE_API_TOKEN = 'r8_test_token';
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

describe('generateImage', () => {
  it('throws if REPLICATE_API_TOKEN is not set', async () => {
    delete process.env.REPLICATE_API_TOKEN;
    await expect(generateImage('a mountain')).rejects.toThrow('REPLICATE_API_TOKEN is not set');
  });

  it('chains generation then background removal, then downloads the final image', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'succeeded', output: 'https://replicate.delivery/generated.png' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'succeeded', output: 'https://replicate.delivery/stripped.png' }))
      .mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as unknown as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateImage('a minimalist mountain line drawing');

    expect(result).toBeInstanceOf(Buffer);
    expect(Array.from(result)).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toContain('flux-schnell');
    expect(fetchMock.mock.calls[1][0]).toContain('background-remover');
    expect(fetchMock.mock.calls[1][1].body).toContain('https://replicate.delivery/generated.png');
    expect(fetchMock.mock.calls[2][0]).toBe('https://replicate.delivery/stripped.png');
  });

  it('throws ReplicateError if the generation call is not ok', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({}, false, 500)) as unknown as typeof fetch;
    await expect(generateImage('x')).rejects.toThrow(ReplicateError);
  });

  it('throws ReplicateError if a prediction does not succeed', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ status: 'failed' })) as unknown as typeof fetch;
    await expect(generateImage('x')).rejects.toThrow(ReplicateError);
  });
});
