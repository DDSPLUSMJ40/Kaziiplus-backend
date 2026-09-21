const REPLICATE_BASE_URL = 'https://api.replicate.com/v1';

// lucataco/remove-bg -- a community (non-official) model, so it must be
// called via the version-pinned /v1/predictions endpoint rather than the
// /v1/models/{owner}/{name}/predictions shorthand, which only resolves for
// official/partner models like black-forest-labs/flux-schnell.
const BACKGROUND_REMOVER_VERSION = '95fcc2a26d3899cd6c2691c900465aaeff466285a65c14638cc5f36f34befaf1';

export class ReplicateError extends Error {}

function getToken(): string {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    throw new Error('REPLICATE_API_TOKEN is not set. Refusing to call Replicate.');
  }
  return token;
}

// Prefer: wait makes Replicate hold the HTTP response open until the
// prediction finishes (bounded by the model's own timeout) instead of
// returning immediately with a "starting" status that would need polling.
async function runModel(model: string, input: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${REPLICATE_BASE_URL}/models/${model}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
      Prefer: 'wait',
    },
    body: JSON.stringify({ input }),
  });
  if (!res.ok) {
    throw new ReplicateError(`Replicate API error calling ${model}: ${res.status}`);
  }
  const data = await res.json() as any;
  if (data.status !== 'succeeded') {
    throw new ReplicateError(`Replicate prediction for ${model} did not succeed: ${data.status}`);
  }
  return data;
}

// Same behavior as runModel, but for a community model pinned to a
// specific version via the classic /v1/predictions endpoint.
async function runVersion(version: string, input: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${REPLICATE_BASE_URL}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
      Prefer: 'wait',
    },
    body: JSON.stringify({ version, input }),
  });
  if (!res.ok) {
    throw new ReplicateError(`Replicate API error calling version ${version}: ${res.status}`);
  }
  const data = await res.json() as any;
  if (data.status !== 'succeeded') {
    throw new ReplicateError(`Replicate prediction for version ${version} did not succeed: ${data.status}`);
  }
  return data;
}

function firstOutputUrl(data: { output: string | string[] }): string {
  return Array.isArray(data.output) ? data.output[0] : data.output;
}

async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new ReplicateError(`Could not download generated image: ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Two real calls, not one -- a base text-to-image model doesn't produce
// real alpha transparency from a prompt alone, so every generation is
// piped through a background-removal model before being returned. Not
// configurable (see spec §2.1) -- transparent is correct for a print file
// essentially always.
export async function generateImage(prompt: string): Promise<Buffer> {
  const generated = await runModel('black-forest-labs/flux-schnell', { prompt });
  const generatedUrl = firstOutputUrl(generated);

  const stripped = await runVersion(BACKGROUND_REMOVER_VERSION, { image: generatedUrl });
  const strippedUrl = firstOutputUrl(stripped);

  return downloadImage(strippedUrl);
}
