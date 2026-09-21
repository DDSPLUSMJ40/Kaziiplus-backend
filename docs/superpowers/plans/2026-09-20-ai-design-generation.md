# AI-Assisted Product Design Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a creator generate print-ready artwork from a text prompt in
the Builder, backed by Replicate, capped at 10 free generations per
creator per month.

**Architecture:** One new backend module (`src/adapters/replicate.adapter.ts`)
wrapping two chained Replicate API calls (image generation, then background
removal), one new creator-authed endpoint (`POST /ai/generate-design`), one
new Prisma table (`AiGeneration`) that doubles as the cap counter and a
prompt log, and a new Builder rail tab in `kazii-full-demo.html` that turns
a successful generation into a normal image layer via the existing
`addImageLayer()` — the print-file pipeline built for Printful fulfillment
needs zero changes.

**Tech Stack:** Express, Prisma, Zod, Vitest (backend, existing). Static
HTML/JS, no build step (frontend, existing). Replicate's REST API via
Node's built-in `fetch` (no new HTTP client dependency — `printful.adapter.ts`
already establishes this pattern).

**Spec:** `docs/superpowers/specs/2026-09-20-ai-design-generation-design.md`

## Global Constraints

- Every endpoint taking a body validates with a Zod schema via
  `.safeParse()`; on failure return `400 { error: 'validation_failed',
  details: parsed.error.flatten() }` — the existing convention, unchanged.
- `REPLICATE_API_TOKEN` is checked lazily inside the function that uses it,
  never at module load time — same reasoning as `getStripe()`/`getVariant()`
  checking their env vars: a module-load-time throw would crash the whole
  server (health check and auth included) if the var isn't set yet.
- **Fairness rule:** an `AiGeneration` row is created only after a
  *successful* generation. A Replicate failure returns an error to the
  creator without writing a row, so an outage never consumes their monthly
  quota.
- The prompt is capped at 500 characters (Zod `.max(500)`) — bounds cost
  and abuse without being restrictive for a real design prompt.
- No polling loop, no webhook, no job queue for Replicate calls — both
  calls use Replicate's synchronous `Prefer: wait` mode and the route
  handler awaits them directly.
- No creator-facing background-transparency toggle. Every generation is
  background-removed automatically; this is not configurable.
- **Every new frontend function called from an inline `onclick`/`oninput`
  attribute MUST be added to the `window.fn = fn` exposure block at the
  end of its enclosing IIFE.** This codebase has broken this exact way
  twice already this session (Publish button, name/price inputs in the
  Builder) — the Builder's code lives inside a `(function(){ ... })()` and
  inline HTML event attributes run in global scope, so anything they call
  must be explicitly exposed. Task 6 calls this out as its own step for
  each new function — do not skip it, and do not assume a function is
  reachable just because it compiles.

---

## Task 1: Schema — `AiGeneration` table

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `AiGeneration { id: String, creatorId: String, prompt: String,
  createdAt: DateTime }`, and `CreatorProfile.aiGenerations: AiGeneration[]`.
  Consumed by Task 3's cap-check query and creation call.

This task has no application code and therefore no Vitest tests —
`prisma validate` and a real migration against the live database are the
verification, matching how every other schema change in this project has
been verified.

- [ ] **Step 1: Add the model**

In `prisma/schema.prisma`, add this model near `SupplierConnection`:

```prisma
model AiGeneration {
  id        String         @id @default(cuid())
  creatorId String
  creator   CreatorProfile @relation(fields: [creatorId], references: [id], onDelete: Cascade)
  prompt    String
  createdAt DateTime       @default(now())

  @@map("ai_generations")
}
```

Add the inverse relation to `CreatorProfile` (alongside `supplierConnections`):

```prisma
model CreatorProfile {
  // ...existing fields unchanged...
  aiGenerations AiGeneration[]
  // ...existing relations unchanged...
}
```

- [ ] **Step 2: Validate the schema**

Run (from `kazii-backend/`, using the Postgres service's
`DATABASE_PUBLIC_URL` from Railway — same pattern as every prior migration
in this project):
```bash
DATABASE_URL="<DATABASE_PUBLIC_URL from Railway>" npx prisma validate
```
Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 3: Generate and apply the migration against the live database**

```bash
DATABASE_URL="<DATABASE_PUBLIC_URL from Railway>" npx prisma migrate dev --name add_ai_generations
```
Expected: a new folder under `prisma/migrations/` is created and applied;
ends with `Your database is now in sync with your schema.`

- [ ] **Step 4: Run the full build to confirm the generated Prisma client matches usage**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "Add AiGeneration table for AI design generation cap/log"
```

---

## Task 2: Replicate adapter

**Files:**
- Create: `src/adapters/replicate.adapter.ts`
- Test: `src/adapters/replicate.adapter.test.ts`

**Interfaces:**
- Produces: `generateImage(prompt: string): Promise<Buffer>` and
  `ReplicateError` (a class extending `Error`), exported from
  `src/adapters/replicate.adapter.ts`. Consumed by Task 3's controller.
- Consumes: `process.env.REPLICATE_API_TOKEN`, Node's global `fetch`.

- [ ] **Step 1: Write the failing tests**

Create `src/adapters/replicate.adapter.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- replicate.adapter`
Expected: FAIL — `Cannot find module './replicate.adapter'`.

- [ ] **Step 3: Implement the adapter**

Create `src/adapters/replicate.adapter.ts`:
```ts
const REPLICATE_BASE_URL = 'https://api.replicate.com/v1';

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
  const data = await res.json();
  if (data.status !== 'succeeded') {
    throw new ReplicateError(`Replicate prediction for ${model} did not succeed: ${data.status}`);
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

  const stripped = await runModel('851-labs/background-remover', { image: generatedUrl });
  const strippedUrl = firstOutputUrl(stripped);

  return downloadImage(strippedUrl);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- replicate.adapter`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/replicate.adapter.ts src/adapters/replicate.adapter.test.ts
git commit -m "Add Replicate adapter: generate + auto background removal"
```

---

## Task 3: Generation endpoint with cap enforcement

**Files:**
- Create: `src/schemas/ai.schemas.ts`
- Create: `src/controllers/ai.controller.ts`
- Test: `src/controllers/ai.controller.test.ts`

**Interfaces:**
- Consumes: `AuthedRequest` (`req.userId`), `generateImage` from
  `../adapters/replicate.adapter` (Task 2).
- Produces: `generateDesign(req: AuthedRequest, res: Response)`, exported
  from `src/controllers/ai.controller.ts`. Consumed by Task 4's routes.

- [ ] **Step 1: Write the schema**

Create `src/schemas/ai.schemas.ts`:
```ts
import { z } from 'zod';

export const generateDesignSchema = z.object({
  prompt: z.string().min(1, 'Prompt is required.').max(500, 'Keep prompts under 500 characters.'),
});
```

- [ ] **Step 2: Write the failing tests**

Create `src/controllers/ai.controller.test.ts`:
```ts
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- ai.controller`
Expected: FAIL — `Cannot find module './ai.controller'`.

- [ ] **Step 4: Implement the controller**

Create `src/controllers/ai.controller.ts`:
```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- ai.controller`
Expected: PASS (5 tests)

- [ ] **Step 6: Run the full build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/schemas/ai.schemas.ts src/controllers/ai.controller.ts src/controllers/ai.controller.test.ts
git commit -m "Add POST /ai/generate-design with monthly cap enforcement"
```

---

## Task 4: Route + mount

**Files:**
- Create: `src/routes/ai.routes.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `requireAuth`, `requireAccountType` from
  `../middleware/auth.middleware`; `generateDesign` from Task 3.

No new tests in this task — pure wiring, verified by the build and by
Task 5's live check.

- [ ] **Step 1: Create the route**

Create `src/routes/ai.routes.ts`:
```ts
import { Router } from 'express';
import { requireAuth, requireAccountType } from '../middleware/auth.middleware';
import { generateDesign } from '../controllers/ai.controller';

const router = Router();
router.use(requireAuth, requireAccountType('CREATOR'));

router.post('/generate-design', generateDesign);

export default router;
```

- [ ] **Step 2: Mount it in `index.ts`**

In `src/index.ts`, add the import alongside the other route imports:
```ts
import aiRoutes from './routes/ai.routes';
```

Add the mount line directly below `app.use('/fulfillment', fulfillmentRoutes);`:
```ts
app.use('/ai', aiRoutes);
```

- [ ] **Step 3: Run the full build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS, all suites (including the new `replicate.adapter` and
`ai.controller` suites from Tasks 2-3).

- [ ] **Step 5: Commit**

```bash
git add src/routes/ai.routes.ts src/index.ts
git commit -m "Mount POST /ai/generate-design"
```

---

## Task 5: Deploy and verify against production

**Files:** None — this task sets Railway configuration and runs
verification commands, no code changes.

**Interfaces:** None new — exercises Tasks 1-4 end-to-end against the real
`kaziiplus` Railway project (project ID `02028e4f-30ee-4e52-9bfd-db6b8c24992f`,
environment `production`, service `kazii-backend` /
`3dc2f631-5be2-49c1-b90c-f6cb99a77bcd`).

- [ ] **Step 1: Get a real Replicate API token**

From https://replicate.com/account/api-tokens (create a Replicate account
if none exists yet — no special verification needed for API access).

- [ ] **Step 2: Set the token on Railway**

Using `mcp__railway__set-variables` against the `kazii-backend` service:
`REPLICATE_API_TOKEN` = the token from Step 1.

- [ ] **Step 3: Push and confirm the deploy**

```bash
git push origin main
```
Poll `mcp__railway__list-deployments` (or `curl https://api.kaziiplus.com/health`)
until the new commit's deployment shows `SUCCESS`.

- [ ] **Step 4: Sign up a real test creator**

```bash
curl -sS -X POST https://api.kaziiplus.com/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"ai-design-verify@kaziiplus.com","password":"password123","accountType":"CREATOR","firstName":"AiDesignVerify"}'
```
Save the returned `token`.

- [ ] **Step 5: Verify a real generation**

```bash
TOKEN="<paste token>"
curl -sS -X POST https://api.kaziiplus.com/ai/generate-design \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"prompt":"a minimalist line drawing of a mountain range, single continuous line"}'
```
Expected: `200` with `imageBase64` (a long base64 string), `usedThisMonth: 1`,
`limit: 10`. Decode and inspect the image (e.g. write it to a file and open
it) to confirm it's a real, background-removed PNG — not just a
well-formed but wrong response.

- [ ] **Step 6: Verify the cap**

Repeat Step 5's request 9 more times (10 total). On the 11th call, expect
`429 { "error": "generation_limit_reached", "usedThisMonth": 10, "limit": 10 }`
and confirm via the database that exactly 10 `ai_generations` rows exist
for this creator (not 11) — proving the cap actually blocks the call
before it reaches Replicate.

- [ ] **Step 7: Verify the fairness rule against a real failure**

Temporarily unset `REPLICATE_API_TOKEN` on Railway (or use an obviously
invalid value), redeploy is not required for an env var change to take
effect on next request in most Railway configs, but confirm the running
process picks it up (it may require a restart — use
`mcp__railway__restart-service` if the value doesn't take effect).
Make one more generate-design request as the same test creator: expect
`500 { "error": "generation_failed" }`, then confirm via the database that
the `ai_generations` row count for this creator is still 10, not 11 —
proving the failed attempt didn't consume quota. Restore the real
`REPLICATE_API_TOKEN` value afterward.

- [ ] **Step 8: Clean up test data**

Delete the `ai-design-verify@kaziiplus.com` user's `ai_generations` rows,
then the `creator_profiles` row, then the `users` row (dependency order),
using the same `prisma db execute` pattern established throughout this
project.

- [ ] **Step 9: Commit nothing further**

This task is verification-only; if Steps 1-8 all pass, proceed to Task 6.
If anything fails, fix the underlying code (in Tasks 2-4) and repeat this
task's verification before moving on.

---

## Task 6: Builder UI — "AI Design" tab

**Files:**
- Modify: `kazii-frontend/kazii-full-demo.html`

**Interfaces:**
- Consumes: `POST /ai/generate-design` (Tasks 3-4), the existing
  `addImageLayer(dataUrl)` function (already in this file, used by manual
  artwork uploads), the existing `builderSetTab(tab)` / `renderPanel()`
  dispatch pattern, the existing `toast()` function.
- Produces: `generateAiDesign()`, `addPendingAiDesign()` — both must be
  added to the `window.fn = fn` exposure block per this task's explicit
  reminder steps below.

No Vitest here — this is a static file with no test runner. Verification
is a live, scripted browser check (matching the pattern used throughout
this project: headless Chrome via the Chrome DevTools Protocol, driving a
real signup and a real generation against the now-live backend from
Task 5).

- [ ] **Step 1: Add the rail button**

Find the Builder's rail `<div class="rail" id="rail">` block (it lists
Product, Color, Artwork, Text, Printful, Gelato, CJ Drop, Alibaba as
`rail-item` buttons). Add a new button between the `text` and `printful`
entries:
```html
<button class="rail-item" data-tab="ai" onclick="builderSetTab('ai')"><span class="ic">✦</span><span class="lbl">AI Design</span></button>
```

- [ ] **Step 2: Add state for the pending (not-yet-added) generation**

Find the Builder's `let state = { ... }` declaration. This is intentionally
**not** added to `state` itself — `state` is the persisted product-design
state (what gets saved/published), and a generation the creator hasn't
clicked "Add to design" on yet must not be part of that. Add a separate
module-level variable near `state`'s declaration:
```js
let pendingAiImage = null; // { dataUrl, usedThisMonth, limit } | null
let aiGenerating = false;
```

- [ ] **Step 3: Add the `renderPanel()` branch for the new tab**

Find `renderPanel()`'s `if/else if` chain (branches for `'product'`,
`'color'`, `'artwork'`, `'text'`, then the fulfillment-provider tabs). Add
a new branch immediately after the `'text'` branch and before the
fulfillment-provider one:
```js
else if(state.activeTab==='ai'){
  const usageLine = pendingAiImage
    ? `${pendingAiImage.usedThisMonth} of ${pendingAiImage.limit} free generations used this month`
    : '';
  panel.innerHTML = `
    <div class="panel-label">Generate with AI</div>
    <div class="panel-sub" style="font-size:12px; color:var(--text-soft); margin-bottom:16px; line-height:1.5;">Describe the artwork you want — Kazii generates it and you decide whether to add it to your design.</div>
    <label class="field-label">Prompt</label>
    <textarea class="text-input" id="aiPromptInput" style="min-height:80px; resize:vertical;" placeholder="e.g. a minimalist line drawing of a mountain range" ${aiGenerating ? 'disabled' : ''}>${pendingAiImage ? pendingAiImage.prompt : ''}</textarea>
    <button class="btn-block" onclick="generateAiDesign()" ${aiGenerating ? 'disabled' : ''}>${aiGenerating ? 'Generating…' : (pendingAiImage ? '↻ Regenerate' : 'Generate →')}</button>
    ${pendingAiImage ? `
      <div class="panel-sub" style="text-align:center; margin:14px 0;">— result —</div>
      <div style="width:100%; aspect-ratio:1; background:var(--panel-2); border:1px solid var(--line); border-radius:10px; margin-bottom:14px; overflow:hidden;">
        <img src="${pendingAiImage.dataUrl}" style="width:100%; height:100%; object-fit:contain;">
      </div>
      <button class="btn-block" onclick="addPendingAiDesign()">Add to design →</button>
    ` : ''}
    <div class="panel-sub" style="text-align:center; font-family:'IBM Plex Mono',monospace;">${usageLine}</div>
  `;
}
```

- [ ] **Step 4: Implement `generateAiDesign()`**

Find `saveBuilderProduct` (or any function referencing `API_BASE_URL` and
`localStorage.getItem('kaziiToken')`) to place this near the other
API-calling Builder functions. Add:
```js
async function generateAiDesign(){
  const token = localStorage.getItem('kaziiToken');
  if(!token){
    toast('Sign up to use AI design generation');
    goTo('auth'); authSetMode('signup');
    return;
  }
  const promptInput = document.getElementById('aiPromptInput');
  const prompt = promptInput ? promptInput.value.trim() : '';
  if(!prompt){ toast('Describe what you want first'); return; }

  aiGenerating = true;
  renderPanel();
  try {
    const res = await fetch(`${API_BASE_URL}/ai/generate-design`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ prompt })
    });
    const data = await res.json().catch(() => ({}));
    if(res.status === 429){
      toast(`You've used all ${data.limit} free generations this month`);
      return;
    }
    if(!res.ok){
      toast('Could not generate — try a different prompt.');
      return;
    }
    pendingAiImage = {
      dataUrl: `data:image/png;base64,${data.imageBase64}`,
      prompt,
      usedThisMonth: data.usedThisMonth,
      limit: data.limit
    };
  } catch(e){
    toast('Can’t reach the server — try again in a moment.');
  } finally {
    aiGenerating = false;
    renderPanel();
  }
}
```

- [ ] **Step 5: Implement `addPendingAiDesign()`**

Add directly below `generateAiDesign()`:
```js
function addPendingAiDesign(){
  if(!pendingAiImage) return;
  addImageLayer(pendingAiImage.dataUrl);
  toast('Added to your design');
  pendingAiImage = null;
  renderPanel();
}
```

This reuses the existing `addImageLayer(dataUrl)` function verbatim — a
generated design becomes an image layer exactly like a manual upload,
which is why the print-file pipeline needs no changes.

- [ ] **Step 6: Expose both new functions on `window` — REQUIRED, do not skip**

Find the Builder IIFE's `window.saveDesign = saveDesign;` line (in the
`window.X = X` block at the end of the Builder's `(function(){ ... })()`).
Add immediately after it:
```js
window.generateAiDesign = generateAiDesign;
window.addPendingAiDesign = addPendingAiDesign;
```

**Why this step exists as its own checklist item:** the Builder's code
lives inside an IIFE. Inline `onclick="generateAiDesign()"` and
`onclick="addPendingAiDesign()"` attributes run in global scope. Without
this exposure, clicking either button throws `ReferenceError: ... is not
defined` in production — this exact mistake happened twice already this
session (the Publish button, and the name/price input handlers). Step 7
below is specifically designed to catch it if it happens again.

- [ ] **Step 7: Commit**

```bash
cd kazii-frontend
git add kazii-full-demo.html
git commit -m "Add AI Design tab to the Builder, backed by /ai/generate-design"
git push origin main
```

- [ ] **Step 8: Wait for the frontend deploy**

Poll `https://www.kaziiplus.com/` until it contains the string
`generateAiDesign` (same pattern used throughout this project to confirm
a static-file deploy landed):
```bash
until curl -s https://www.kaziiplus.com/ | grep -q "generateAiDesign"; do sleep 3; done
```

- [ ] **Step 9: Live end-to-end verification via headless Chrome**

Using the Chrome DevTools Protocol screenshot/automation scripts already
established in this project's scratchpad (spawn `chrome.exe --headless=new`
with a remote debugging port, connect via `WebSocket`, use
`Runtime.evaluate` to drive the page): sign up a real test creator, call
`goTo('builder')`, call `builderSetTab('ai')`, fill `#aiPromptInput` and
call `generateAiDesign()`, wait for the result, verify
`document.getElementById('aiPromptInput')`'s sibling preview `<img>` has a
real `src` matching a `data:image/png;base64,` prefix, call
`addPendingAiDesign()`, then verify `state.layers` (this specific check
must run as code *inside* an already-established `saveDesign`-style call,
since `state` is not on `window` and a fresh `Runtime.evaluate` cannot see
it directly — evaluate `typeof state.layers.find(l=>l.type==='image')`
from inside a function this project already exposed, or simply proceed to
publish the product and verify the result server-side instead) contains a
new image layer whose `src` matches the generated image. Then call
`publishDesign()` and verify via `GET /products/:id/print-file.png`
(same verification already used for the artwork-upload print-file
feature) that the served bytes are non-empty and match what Replicate
returned.

- [ ] **Step 10: Clean up test data**

Delete the test creator's products and user via the same `prisma db execute`
pattern used throughout this project. Delete the `AiGeneration` rows too
(cascades automatically via `onDelete: Cascade` when the `CreatorProfile`
is deleted through the `User` delete, same as `SupplierConnection` and
`Product` already do — no separate delete statement needed).

---

## Self-Review Notes

- **Spec coverage:** §1 (data model) → Task 1. §2.1 (adapter, background
  removal) → Task 2. §2.2 (env var) → Task 5 Step 2. §2.3 (endpoint, cap,
  fairness rule) → Task 3. §3 (frontend tab, wiring, not-logged-in
  handling) → Task 6. §4 (error handling conventions) → Task 3's status
  codes. §5 (testing plan) → Tasks 2, 3, 5, 6. §6 (deferred items) is
  explicitly not built anywhere in this plan, matching the spec.
- **Window exposure:** called out explicitly as Task 6 Step 6, with its
  own rationale paragraph, per the project's own recent history of missing
  this step twice.
- **Type consistency check:** `generateImage(prompt: string): Promise<Buffer>`
  (Task 2) is the exact signature Task 3's controller imports and awaits.
  `generateDesign(req: AuthedRequest, res: Response)` (Task 3) is the exact
  signature Task 4's route imports. Frontend `pendingAiImage` shape
  (`{dataUrl, prompt, usedThisMonth, limit}`, Task 6 Step 2) matches what
  Step 4's `generateAiDesign()` constructs and what Step 3's `renderPanel()`
  branch reads.
