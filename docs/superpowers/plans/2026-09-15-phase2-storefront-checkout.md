# Phase 2: Products, Storefront & Checkout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Creators real, persisted products, a live public storefront, and real Stripe checkout — replacing the Builder's browser-only state and the frontend's hardcoded storefront demo data.

**Architecture:** Three new route groups (`/products`, public `/store/:slug` + creator `/creators/me/*`, `/webhooks/stripe`) added to the existing Express + Prisma + Zod backend, following the exact patterns already established in `auth.controller.ts` / `auth.schemas.ts` / `auth.middleware.ts`. Stripe Checkout Sessions (hosted redirect) handle payment; a webhook marks orders paid. No new architectural layers — same singleton-Prisma, same JWT auth middleware, same Zod-`safeParse`-then-400 convention.

**Tech Stack:** Express, Prisma, Zod, Stripe Node SDK (new dependency), Vitest (new dev dependency — this codebase has no test runner yet; see Task 1).

**Spec:** `docs/superpowers/specs/2026-09-10-phase2-storefront-printful-connect-design.md` (sections 1–4 and 6–8; this plan does not cover section 5, Printful connect+catalog — that is a separate, independent plan since the spec itself calls that slice "architecturally independent... could ship before, after, or in parallel").

## Global Constraints

- Every endpoint taking a body validates with a Zod schema via `.safeParse()`; on failure return `400 { error: 'validation_failed', details: parsed.error.flatten() }` — copied verbatim from `auth.controller.ts`'s existing pattern.
- Ownership checks (a product/order belongs to the caller) return `404`, never `403` — don't let a caller distinguish "doesn't exist" from "exists but isn't yours" (spec §7).
- Any endpoint that needs an env var that might be unset (Stripe keys, `FRONTEND_URL`) checks and throws lazily *inside the function that uses it*, never at module load — same pattern as `auth.controller.ts`'s `signToken()` checking `JWT_SECRET`. This matters because a module-load-time throw would crash the whole server (breaking `/health` and `/auth` too) if Stripe env vars aren't set yet at deploy time.
- Stripe webhook signature failures return `400`, not `500` (spec §7) — a bad signature is a rejected request, not a server fault.
- The `/webhooks/stripe` route must receive Stripe's **raw** request body to verify its signature, so it is mounted with `express.raw({ type: 'application/json' })` *before* `index.ts`'s global `express.json()` middleware — not as a normal route added after.
- `npx tsc` (the `build` script) must stay clean after every task — this codebase has no CI, so a broken build is only caught by running it.
- Printful order routing (`Explicitly out of scope` in spec §4) is NOT part of this plan. A `PAID` order just sits there, ready for a future slice.

---

## Task 1: Test infrastructure, slug generation, and real storefront links at signup

**Files:**
- Modify: `package.json` (add `vitest` devDependency + `test` script)
- Create: `vitest.config.ts`
- Create: `src/lib/slugify.ts`
- Test: `src/lib/slugify.test.ts`
- Modify: `src/controllers/auth.controller.ts` (wire slug generation into `signup()`)
- Test: `src/controllers/auth.controller.test.ts`

**Interfaces:**
- Produces: `slugify(input: string): string` — pure function, lowercases/hyphenates/strips.
- Produces: `generateUniqueStorefrontSlug(base: string): Promise<string>` — exported from `src/controllers/auth.controller.ts`, used by `signup()`.
- Consumes: `prisma.creatorProfile.findUnique({ where: { storefrontSlug } })` — the `storefrontSlug String? @unique` column already exists on `CreatorProfile` (added in Phase 1), no schema change needed for this task.

- [ ] **Step 1: Add Vitest**

Run:
```bash
npm install -D vitest
```

Add to `package.json` `"scripts"`:
```json
"test": "vitest run"
```

- [ ] **Step 2: Add Vitest config**

Create `vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
  },
});
```

- [ ] **Step 3: Write the failing test for `slugify`**

Create `src/lib/slugify.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { slugify } from './slugify';

describe('slugify', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugify('Elena Cruz')).toBe('elena-cruz');
  });

  it('strips punctuation', () => {
    expect(slugify("Jo's Candles!")).toBe('jos-candles');
  });

  it('collapses repeated whitespace into one hyphen', () => {
    expect(slugify('Multi   Space   Brand')).toBe('multi-space-brand');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('  -Leading Trailing-  ')).toBe('leading-trailing');
  });

  it('returns an empty string for input with no keepable characters', () => {
    expect(slugify('!!!')).toBe('');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- slugify`
Expected: FAIL — `Cannot find module './slugify'` (file doesn't exist yet).

- [ ] **Step 5: Implement `slugify`**

Create `src/lib/slugify.ts`:
```ts
// Turns a display name into a URL-safe storefront slug. Pure function --
// uniqueness against other creators is handled separately by the caller.
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- slugify`
Expected: PASS (5 tests)

- [ ] **Step 7: Write the failing test for signup's slug generation**

Read `src/controllers/auth.controller.ts` in full before editing it in the next step — the test below mocks `../lib/prisma` the same way `products.controller.test.ts` will in Task 3, so match that shape exactly.

Create `src/controllers/auth.controller.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const mockPrisma = {
  user: { findUnique: vi.fn(), create: vi.fn() },
  creatorProfile: { findUnique: vi.fn() },
};

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
vi.mock('bcryptjs', () => ({ default: { hash: vi.fn().mockResolvedValue('hashed'), compare: vi.fn() } }));
vi.mock('jsonwebtoken', () => ({ default: { sign: vi.fn().mockReturnValue('signed-token') } }));

import { signup, generateUniqueStorefrontSlug } from './auth.controller';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET = 'test-secret';
});

describe('generateUniqueStorefrontSlug', () => {
  it('returns the base slug when it is not taken', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue(null);
    const slug = await generateUniqueStorefrontSlug('Elena Cruz');
    expect(slug).toBe('elena-cruz');
  });

  it('appends a random suffix when the base slug is taken', async () => {
    mockPrisma.creatorProfile.findUnique
      .mockResolvedValueOnce({ id: 'existing' })
      .mockResolvedValueOnce(null);
    const slug = await generateUniqueStorefrontSlug('Elena Cruz');
    expect(slug).toMatch(/^elena-cruz-[a-z0-9]{4}$/);
  });

  it('falls back to "creator" when the base has no keepable characters', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue(null);
    const slug = await generateUniqueStorefrontSlug('!!!');
    expect(slug).toBe('creator');
  });
});

describe('signup assigns a storefront slug to new creators', () => {
  it('creates the user with a generated storefrontSlug on the creator profile', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.creatorProfile.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({ id: 'u1', email: 'jade@example.com', accountType: 'CREATOR' });

    const req = {
      body: { email: 'jade@example.com', password: 'password123', accountType: 'CREATOR', firstName: 'Jade' },
    } as Request;
    const res = mockRes();

    await signup(req, res);

    expect(mockPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          creatorProfile: expect.objectContaining({
            create: expect.objectContaining({ storefrontSlug: 'jade' }),
          }),
        }),
      })
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `npm test -- auth.controller`
Expected: FAIL — `generateUniqueStorefrontSlug` is not exported from `./auth.controller`.

- [ ] **Step 9: Wire slug generation into `signup()`**

In `src/controllers/auth.controller.ts`, add the import and the new exported function, and call it inside `signup()` before `prisma.user.create`:

```ts
import { slugify } from '../lib/slugify';
```

Add this function (exported, alongside `signToken`):
```ts
export async function generateUniqueStorefrontSlug(base: string): Promise<string> {
  const baseSlug = slugify(base) || 'creator';
  let candidate = baseSlug;
  let attempt = 0;
  while (await prisma.creatorProfile.findUnique({ where: { storefrontSlug: candidate } })) {
    attempt += 1;
    candidate = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
    if (attempt > 5) break; // astronomically unlikely to loop this long; don't hang the request
  }
  return candidate;
}
```

Inside `signup()`, before the `prisma.user.create` call, add:
```ts
  const storefrontSlug =
    data.accountType === 'CREATOR' ? await generateUniqueStorefrontSlug(data.brandName || data.firstName) : undefined;
```

Then update the `CREATOR` branch of the `prisma.user.create` data object to include it:
```ts
      ...(data.accountType === 'CREATOR' && {
        creatorProfile: {
          create: { firstName: data.firstName, brandName: data.brandName ?? null, storefrontSlug },
        },
      }),
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npm test -- auth.controller`
Expected: PASS (4 tests)

- [ ] **Step 11: Run the full build to confirm nothing broke**

Run: `npm run build`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/lib/slugify.ts src/lib/slugify.test.ts src/controllers/auth.controller.ts src/controllers/auth.controller.test.ts
git commit -m "Add Vitest, generate real storefront slugs for new creators"
```

---

## Task 2: Schema migration — storefront visibility and payment fields

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `CreatorProfile.storefrontLive: boolean` (default `true`), `PaymentStatus` enum (`PENDING | PAID | FAILED | REFUNDED`), `Order.paymentStatus: PaymentStatus` (default `PENDING`), `Order.stripeSessionId: string | null` (unique), `Order.quantity: number` (default `1`), `Order.customerEmail: string | null` — all consumed by Task 4 and Task 5.

This task has no application code and therefore no Vitest tests — `prisma validate` and a real migration against the live database are the verification, matching how Phase 1's schema was verified.

- [ ] **Step 1: Add the new enum and fields**

In `prisma/schema.prisma`, add this enum near the existing `OrderStatus` enum:
```prisma
enum PaymentStatus {
  PENDING
  PAID
  FAILED
  REFUNDED
}
```

Add `storefrontLive` to `CreatorProfile`:
```prisma
model CreatorProfile {
  // ...existing fields unchanged...
  storefrontLive Boolean  @default(true)
  // ...existing relations unchanged...
}
```

Add the new fields to `Order`:
```prisma
model Order {
  // ...existing fields unchanged...
  paymentStatus   PaymentStatus @default(PENDING)
  stripeSessionId String?       @unique
  quantity        Int           @default(1)
  customerEmail   String?
  // ...existing relations unchanged...
}
```

- [ ] **Step 2: Validate the schema**

Run: `npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 3: Generate and apply the migration against the live database**

Run (using the same Railway Postgres public connection string pattern established in Phase 1 — get the current value from the Postgres service's `DATABASE_PUBLIC_URL` variable on Railway if it has changed since Phase 1):
```bash
DATABASE_URL="<DATABASE_PUBLIC_URL from Railway>" npx prisma migrate dev --name add_storefront_and_payment_fields
```
Expected: a new folder under `prisma/migrations/` is created and applied; ends with `Your database is now in sync with your schema.`

- [ ] **Step 4: Run the full build to confirm the generated Prisma client still matches usage**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "Add storefrontLive and payment tracking fields to Order"
```

---

## Task 3: Product CRUD endpoints

**Files:**
- Create: `src/schemas/products.schemas.ts`
- Create: `src/controllers/products.controller.ts`
- Test: `src/controllers/products.controller.test.ts`
- Create: `src/routes/products.routes.ts`
- Modify: `src/index.ts` (mount `/products`)

**Interfaces:**
- Consumes: `AuthedRequest` from `src/middleware/auth.middleware.ts` (`req.userId`, `req.accountType`), `requireAuth`/`requireAccountType` middleware.
- Produces: `createProduct`, `listProducts`, `getProduct`, `updateProduct`, `deleteProduct` — all `(req: AuthedRequest, res: Response) => Promise<Response>`, exported from `src/controllers/products.controller.ts`, consumed by `src/routes/products.routes.ts`.

- [ ] **Step 1: Write the failing tests**

Create `src/schemas/products.schemas.ts` first (schemas have no failing-test step of their own — they're exercised through the controller tests below, same as `auth.schemas.ts` has no standalone test file):
```ts
import { z } from 'zod';

export const createProductSchema = z.object({
  name: z.string().min(1, 'Product name is required.'),
  productType: z.string().min(1, 'Product type is required.'),
  color: z.string().optional(),
  price: z.coerce.number().positive().optional(),
  designJson: z.any().optional(),
});

export const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  productType: z.string().min(1).optional(),
  color: z.string().optional(),
  price: z.coerce.number().positive().optional(),
  designJson: z.any().optional(),
  status: z.enum(['DRAFT', 'LIVE']).optional(),
});
```

Create `src/controllers/products.controller.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response } from 'express';
import type { AuthedRequest } from '../middleware/auth.middleware';

const mockPrisma = {
  creatorProfile: { findUnique: vi.fn() },
  product: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
};

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma }));

import { createProduct, listProducts, getProduct, updateProduct, deleteProduct } from './products.controller';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createProduct', () => {
  it('returns 400 on invalid body', async () => {
    const req = { body: {}, userId: 'u1' } as AuthedRequest;
    const res = mockRes();
    await createProduct(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 if the caller has no creator profile', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue(null);
    const req = { body: { name: 'Tee', productType: 'tshirt' }, userId: 'u1' } as AuthedRequest;
    const res = mockRes();
    await createProduct(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('creates a product scoped to the caller creator profile', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.product.create.mockResolvedValue({ id: 'p1', name: 'Tee', productType: 'tshirt' });
    const req = { body: { name: 'Tee', productType: 'tshirt' }, userId: 'u1' } as AuthedRequest;
    const res = mockRes();
    await createProduct(req, res);
    expect(mockPrisma.product.create).toHaveBeenCalledWith({
      data: { creatorId: 'c1', name: 'Tee', productType: 'tshirt' },
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('listProducts', () => {
  it('lists only the caller creator profile products', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.product.findMany.mockResolvedValue([{ id: 'p1' }]);
    const req = { userId: 'u1' } as AuthedRequest;
    const res = mockRes();
    await listProducts(req, res);
    expect(mockPrisma.product.findMany).toHaveBeenCalledWith({ where: { creatorId: 'c1' }, orderBy: { createdAt: 'desc' } });
    expect(res.json).toHaveBeenCalledWith({ products: [{ id: 'p1' }] });
  });
});

describe('getProduct', () => {
  it('returns 404 for a product belonging to a different creator', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.product.findFirst.mockResolvedValue(null);
    const req = { params: { id: 'p1' }, userId: 'u1' } as unknown as AuthedRequest;
    const res = mockRes();
    await getProduct(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns the product when it belongs to the caller', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.product.findFirst.mockResolvedValue({ id: 'p1', creatorId: 'c1' });
    const req = { params: { id: 'p1' }, userId: 'u1' } as unknown as AuthedRequest;
    const res = mockRes();
    await getProduct(req, res);
    expect(res.json).toHaveBeenCalledWith({ product: { id: 'p1', creatorId: 'c1' } });
  });
});

describe('updateProduct', () => {
  it('returns 400 on invalid body', async () => {
    const req = { params: { id: 'p1' }, body: { status: 'NOT_REAL' }, userId: 'u1' } as unknown as AuthedRequest;
    const res = mockRes();
    await updateProduct(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when the product is not the callers', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.product.findFirst.mockResolvedValue(null);
    const req = { params: { id: 'p1' }, body: { status: 'LIVE' }, userId: 'u1' } as unknown as AuthedRequest;
    const res = mockRes();
    await updateProduct(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('publishes a product by setting status to LIVE', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.product.findFirst.mockResolvedValue({ id: 'p1', creatorId: 'c1' });
    mockPrisma.product.update.mockResolvedValue({ id: 'p1', status: 'LIVE' });
    const req = { params: { id: 'p1' }, body: { status: 'LIVE' }, userId: 'u1' } as unknown as AuthedRequest;
    const res = mockRes();
    await updateProduct(req, res);
    expect(mockPrisma.product.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { status: 'LIVE' } });
  });
});

describe('deleteProduct', () => {
  it('returns 404 when the product is not the callers', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.product.findFirst.mockResolvedValue(null);
    const req = { params: { id: 'p1' }, userId: 'u1' } as unknown as AuthedRequest;
    const res = mockRes();
    await deleteProduct(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('deletes the product and returns 204', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.product.findFirst.mockResolvedValue({ id: 'p1', creatorId: 'c1' });
    const req = { params: { id: 'p1' }, userId: 'u1' } as unknown as AuthedRequest;
    const res = mockRes();
    await deleteProduct(req, res);
    expect(mockPrisma.product.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
    expect(res.status).toHaveBeenCalledWith(204);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- products.controller`
Expected: FAIL — `Cannot find module './products.controller'`.

- [ ] **Step 3: Implement the controller**

Create `src/controllers/products.controller.ts`:
```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- products.controller`
Expected: PASS (9 tests)

- [ ] **Step 5: Wire the routes**

Create `src/routes/products.routes.ts`:
```ts
import { Router } from 'express';
import { requireAuth, requireAccountType } from '../middleware/auth.middleware';
import { createProduct, listProducts, getProduct, updateProduct, deleteProduct } from '../controllers/products.controller';

const router = Router();
router.use(requireAuth, requireAccountType('CREATOR'));

router.post('/', createProduct);
router.get('/', listProducts);
router.get('/:id', getProduct);
router.patch('/:id', updateProduct);
router.delete('/:id', deleteProduct);

export default router;
```

In `src/index.ts`, add the import and mount it:
```ts
import productsRoutes from './routes/products.routes';
```
```ts
app.use('/products', productsRoutes);
```
(Add this line directly below the existing `app.use('/auth', authRoutes);` line.)

- [ ] **Step 6: Run the full build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/schemas/products.schemas.ts src/controllers/products.controller.ts src/controllers/products.controller.test.ts src/routes/products.routes.ts src/index.ts
git commit -m "Add product CRUD endpoints"
```

---

## Task 4: Public storefront and creator dashboard endpoints

**Files:**
- Create: `src/schemas/storefront.schemas.ts`
- Create: `src/controllers/storefront.controller.ts`
- Test: `src/controllers/storefront.controller.test.ts`
- Create: `src/routes/storefront.routes.ts` (not yet mounted in `src/index.ts` — Task 5 mounts it alongside the webhook route)

**Interfaces:**
- Consumes: `AuthedRequest`, `requireAuth`, `requireAccountType` (same as Task 3). `CreatorProfile.storefrontLive` and `Order.customerEmail`/`quantity`/`paymentStatus` from Task 2's migration.
- Produces: `getStorefront`, `updateMyStorefront`, `getMyOrders` — exported from `src/controllers/storefront.controller.ts`, and `src/routes/storefront.routes.ts` mounting them. Checkout (`POST /store/:slug/checkout`) is deliberately NOT wired in this task — it needs Stripe, which is Task 5 — Task 5 adds that one route to this same router file. This task's build stays green on its own; it does not reference anything Task 5 creates.

- [ ] **Step 1: Write the failing tests**

Create `src/schemas/storefront.schemas.ts`:
```ts
import { z } from 'zod';

export const updateStorefrontSchema = z.object({
  storefrontSlug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers, and hyphens only.')
    .optional(),
  storefrontLive: z.boolean().optional(),
});
```

Create `src/controllers/storefront.controller.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response, Request } from 'express';
import type { AuthedRequest } from '../middleware/auth.middleware';

const mockPrisma = {
  creatorProfile: { findUnique: vi.fn(), update: vi.fn() },
  order: { findMany: vi.fn() },
};

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma }));

import { getStorefront, updateMyStorefront, getMyOrders } from './storefront.controller';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getStorefront', () => {
  it('returns 404 for an unknown slug', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue(null);
    const req = { params: { slug: 'nobody' } } as unknown as Request;
    const res = mockRes();
    await getStorefront(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns live:false with just the brand name when the storefront is offline', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({
      brandName: 'Elena Studio',
      firstName: 'Elena',
      storefrontLive: false,
      products: [],
    });
    const req = { params: { slug: 'elena' } } as unknown as Request;
    const res = mockRes();
    await getStorefront(req, res);
    expect(res.json).toHaveBeenCalledWith({ live: false, brandName: 'Elena Studio' });
  });

  it('returns products when the storefront is live', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({
      brandName: 'Elena Studio',
      firstName: 'Elena',
      storefrontLive: true,
      products: [{ id: 'p1', name: 'Tee', productType: 'tshirt', color: null, price: '20.00' }],
    });
    const req = { params: { slug: 'elena' } } as unknown as Request;
    const res = mockRes();
    await getStorefront(req, res);
    expect(res.json).toHaveBeenCalledWith({
      live: true,
      brandName: 'Elena Studio',
      products: [{ id: 'p1', name: 'Tee', productType: 'tshirt', color: null, price: '20.00' }],
    });
  });
});

describe('updateMyStorefront', () => {
  it('returns 400 for an invalid slug', async () => {
    const req = { body: { storefrontSlug: 'Not Valid!' }, userId: 'u1' } as AuthedRequest;
    const res = mockRes();
    await updateMyStorefront(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 409 when the slug is already taken by someone else', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ userId: 'someone-else' });
    const req = { body: { storefrontSlug: 'taken' }, userId: 'u1' } as AuthedRequest;
    const res = mockRes();
    await updateMyStorefront(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('updates the storefront when the slug is free', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue(null);
    mockPrisma.creatorProfile.update.mockResolvedValue({ storefrontSlug: 'free-slug' });
    const req = { body: { storefrontSlug: 'free-slug' }, userId: 'u1' } as AuthedRequest;
    const res = mockRes();
    await updateMyStorefront(req, res);
    expect(mockPrisma.creatorProfile.update).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      data: { storefrontSlug: 'free-slug' },
    });
  });
});

describe('getMyOrders', () => {
  it('returns 404 when the caller has no creator profile', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue(null);
    const req = { userId: 'u1' } as AuthedRequest;
    const res = mockRes();
    await getMyOrders(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('lists orders for the callers own products', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.order.findMany.mockResolvedValue([{ id: 'o1' }]);
    const req = { userId: 'u1' } as AuthedRequest;
    const res = mockRes();
    await getMyOrders(req, res);
    expect(mockPrisma.order.findMany).toHaveBeenCalledWith({
      where: { creatorId: 'c1' },
      orderBy: { createdAt: 'desc' },
      include: { product: { select: { name: true } } },
    });
    expect(res.json).toHaveBeenCalledWith({ orders: [{ id: 'o1' }] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- storefront.controller`
Expected: FAIL — `Cannot find module './storefront.controller'`.

- [ ] **Step 3: Implement the controller**

Create `src/controllers/storefront.controller.ts`:
```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- storefront.controller`
Expected: PASS (8 tests)

- [ ] **Step 5: Wire the routes**

Create `src/routes/storefront.routes.ts` with the two endpoints this task built. Task 5 will add one more `router.post('/store/:slug/checkout', ...)` line to this same file once `checkout.controller.ts` exists — this task only wires what it built:
```ts
import { Router } from 'express';
import { requireAuth, requireAccountType } from '../middleware/auth.middleware';
import { getStorefront, updateMyStorefront, getMyOrders } from '../controllers/storefront.controller';

const router = Router();

router.get('/store/:slug', getStorefront);

router.patch('/creators/me/storefront', requireAuth, requireAccountType('CREATOR'), updateMyStorefront);
router.get('/creators/me/orders', requireAuth, requireAccountType('CREATOR'), getMyOrders);

export default router;
```

Note this file is not yet mounted in `src/index.ts` — that happens in Task 5's `index.ts` rewrite, once the checkout route is also in place. Running `npm run build` now would not catch a mounting mistake either way, since nothing imports this file yet; that's expected.

- [ ] **Step 6: Run the full build to confirm this task's own files compile**

Run: `npm run build`
Expected: exits 0 — this file is self-contained and doesn't reference anything Task 5 creates.

- [ ] **Step 7: Commit**

```bash
git add src/schemas/storefront.schemas.ts src/controllers/storefront.controller.ts src/controllers/storefront.controller.test.ts src/routes/storefront.routes.ts
git commit -m "Add public storefront and creator dashboard endpoints"
```

---

## Task 5: Stripe checkout and webhook

**Files:**
- Modify: `package.json` (add `stripe` dependency)
- Create: `src/lib/stripe.ts`
- Create: `src/schemas/checkout.schemas.ts`
- Create: `src/controllers/checkout.controller.ts`
- Test: `src/controllers/checkout.controller.test.ts`
- Create: `src/routes/webhooks.routes.ts`
- Test: `src/routes/webhooks.routes.test.ts`
- Modify: `src/routes/storefront.routes.ts` (add the checkout route from Task 4's file)
- Modify: `src/index.ts` (mount webhook route with raw body BEFORE `express.json()`, mount storefront routes from Task 4)
- Modify: `.env.example` (document new env vars)

**Interfaces:**
- Consumes: `Order.stripeSessionId`/`quantity`/`customerEmail`/`paymentStatus` (Task 2), `CreatorProfile` lookup by `storefrontSlug`, `Product` lookup (Task 3's model), Task 4's `src/routes/storefront.routes.ts`.
- Produces: `getStripe(): Stripe` from `src/lib/stripe.ts`. `createCheckoutSession(req: Request, res: Response)` from `src/controllers/checkout.controller.ts`, wired into Task 4's storefront router in this task's Step 8.

- [ ] **Step 1: Add the Stripe SDK**

Run:
```bash
npm install stripe
```

- [ ] **Step 2: Write the failing tests for the Stripe client wrapper and checkout controller**

Create `src/lib/stripe.ts` is done in Step 4 below — first write the tests that drive it.

Create `src/schemas/checkout.schemas.ts`:
```ts
import { z } from 'zod';

export const checkoutSchema = z.object({
  productId: z.string().min(1),
  quantity: z.coerce.number().int().positive().default(1),
  customerEmail: z.string().email('Enter a valid email address.'),
});
```

Create `src/controllers/checkout.controller.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const mockPrisma = {
  creatorProfile: { findUnique: vi.fn() },
  product: { findFirst: vi.fn() },
  order: { create: vi.fn() },
};

const mockStripeClient = {
  checkout: { sessions: { create: vi.fn() } },
};

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
vi.mock('../lib/stripe', () => ({ getStripe: () => mockStripeClient }));

import { createCheckoutSession } from './checkout.controller';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FRONTEND_URL = 'https://kaziiplus.com';
});

describe('createCheckoutSession', () => {
  it('returns 400 on an invalid body', async () => {
    const req = { params: { slug: 'elena' }, body: {} } as unknown as Request;
    const res = mockRes();
    await createCheckoutSession(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 for an unknown storefront slug', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue(null);
    const req = {
      params: { slug: 'nobody' },
      body: { productId: 'p1', customerEmail: 'buyer@example.com' },
    } as unknown as Request;
    const res = mockRes();
    await createCheckoutSession(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 404 when the product is not LIVE or has no price', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.product.findFirst.mockResolvedValue(null);
    const req = {
      params: { slug: 'elena' },
      body: { productId: 'p1', customerEmail: 'buyer@example.com' },
    } as unknown as Request;
    const res = mockRes();
    await createCheckoutSession(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('creates a Stripe session and a PENDING order, returning the checkout URL', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.product.findFirst.mockResolvedValue({ id: 'p1', name: 'Tee', price: '20.00' });
    mockStripeClient.checkout.sessions.create.mockResolvedValue({ id: 'cs_123', url: 'https://checkout.stripe.com/cs_123' });

    const req = {
      params: { slug: 'elena' },
      body: { productId: 'p1', quantity: 2, customerEmail: 'buyer@example.com' },
    } as unknown as Request;
    const res = mockRes();

    await createCheckoutSession(req, res);

    expect(mockStripeClient.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'payment',
        customer_email: 'buyer@example.com',
        success_url: expect.stringContaining('https://kaziiplus.com'),
        cancel_url: expect.stringContaining('https://kaziiplus.com'),
      })
    );
    expect(mockPrisma.order.create).toHaveBeenCalledWith({
      data: {
        creatorId: 'c1',
        productId: 'p1',
        customerHandle: 'buyer@example.com',
        amount: 40,
        quantity: 2,
        customerEmail: 'buyer@example.com',
        stripeSessionId: 'cs_123',
        paymentStatus: 'PENDING',
      },
    });
    expect(res.json).toHaveBeenCalledWith({ checkoutUrl: 'https://checkout.stripe.com/cs_123' });
  });
});
```

Create `src/routes/webhooks.routes.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const mockPrisma = {
  order: { updateMany: vi.fn() },
};

const mockStripeClient = {
  webhooks: { constructEvent: vi.fn() },
};

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
vi.mock('../lib/stripe', () => ({ getStripe: () => mockStripeClient }));

import { handleStripeWebhook } from './webhooks.routes';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
});

describe('handleStripeWebhook', () => {
  it('returns 400 when the signature header is missing', async () => {
    const req = { headers: {}, body: Buffer.from('{}') } as unknown as Request;
    const res = mockRes();
    await handleStripeWebhook(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when Stripe rejects the signature', async () => {
    mockStripeClient.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('bad signature');
    });
    const req = { headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as unknown as Request;
    const res = mockRes();
    await handleStripeWebhook(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('marks the matching order PAID on checkout.session.completed', async () => {
    mockStripeClient.webhooks.constructEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_123' } },
    });
    const req = { headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as unknown as Request;
    const res = mockRes();
    await handleStripeWebhook(req, res);
    expect(mockPrisma.order.updateMany).toHaveBeenCalledWith({
      where: { stripeSessionId: 'cs_123' },
      data: { paymentStatus: 'PAID' },
    });
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  it('ignores event types other than checkout.session.completed', async () => {
    mockStripeClient.webhooks.constructEvent.mockReturnValue({
      type: 'payment_intent.created',
      data: { object: {} },
    });
    const req = { headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as unknown as Request;
    const res = mockRes();
    await handleStripeWebhook(req, res);
    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- checkout.controller webhooks.routes`
Expected: FAIL — neither `./checkout.controller` nor `./webhooks.routes` exist yet.

- [ ] **Step 4: Implement the Stripe client wrapper**

Create `src/lib/stripe.ts`:
```ts
import Stripe from 'stripe';

let cachedClient: Stripe | null = null;

// Lazy, checked-on-use -- same reasoning as auth.controller.ts's JWT_SECRET
// check: throwing here at import time would crash the whole server (health
// check and auth included) if STRIPE_SECRET_KEY isn't set yet at deploy time.
export function getStripe(): Stripe {
  if (cachedClient) return cachedClient;
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not set. Refusing to create a Stripe client.');
  }
  cachedClient = new Stripe(secretKey);
  return cachedClient;
}
```

- [ ] **Step 5: Implement the checkout controller**

Create `src/controllers/checkout.controller.ts`:
```ts
import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { getStripe } from '../lib/stripe';
import { checkoutSchema } from '../schemas/checkout.schemas';

export async function createCheckoutSession(req: Request, res: Response) {
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', details: parsed.error.flatten() });
  }

  const creator = await prisma.creatorProfile.findUnique({ where: { storefrontSlug: req.params.slug } });
  if (!creator) return res.status(404).json({ error: 'not_found' });

  const product = await prisma.product.findFirst({
    where: { id: parsed.data.productId, creatorId: creator.id, status: 'LIVE' },
  });
  if (!product || !product.price) {
    return res.status(404).json({ error: 'not_found' });
  }

  const frontendUrl = process.env.FRONTEND_URL;
  if (!frontendUrl) {
    throw new Error('FRONTEND_URL is not set. Refusing to build a checkout redirect.');
  }

  const unitPrice = Number(product.price);
  const amount = unitPrice * parsed.data.quantity;

  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: { name: product.name },
          unit_amount: Math.round(unitPrice * 100),
        },
        quantity: parsed.data.quantity,
      },
    ],
    customer_email: parsed.data.customerEmail,
    success_url: `${frontendUrl}/store/${req.params.slug}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendUrl}/store/${req.params.slug}`,
  });

  await prisma.order.create({
    data: {
      creatorId: creator.id,
      productId: product.id,
      customerHandle: parsed.data.customerEmail,
      amount,
      quantity: parsed.data.quantity,
      customerEmail: parsed.data.customerEmail,
      stripeSessionId: session.id,
      paymentStatus: 'PENDING',
    },
  });

  return res.json({ checkoutUrl: session.url });
}
```

- [ ] **Step 6: Implement the webhook route**

Create `src/routes/webhooks.routes.ts`:
```ts
import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { getStripe } from '../lib/stripe';

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
    const session = event.data.object as { id: string };
    await prisma.order.updateMany({ where: { stripeSessionId: session.id }, data: { paymentStatus: 'PAID' } });
  }

  return res.json({ received: true });
}

const router = Router();
router.post('/stripe', handleStripeWebhook);

export default router;
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- checkout.controller webhooks.routes`
Expected: PASS (4 + 4 = 8 tests)

- [ ] **Step 8: Add the checkout route to Task 4's storefront router**

Modify `src/routes/storefront.routes.ts` — add the import and the one new route, keeping the two routes Task 4 already added:
```ts
import { Router } from 'express';
import { requireAuth, requireAccountType } from '../middleware/auth.middleware';
import { getStorefront, updateMyStorefront, getMyOrders } from '../controllers/storefront.controller';
import { createCheckoutSession } from '../controllers/checkout.controller';

const router = Router();

router.get('/store/:slug', getStorefront);
router.post('/store/:slug/checkout', createCheckoutSession);

router.patch('/creators/me/storefront', requireAuth, requireAccountType('CREATOR'), updateMyStorefront);
router.get('/creators/me/orders', requireAuth, requireAccountType('CREATOR'), getMyOrders);

export default router;
```

- [ ] **Step 9: Wire everything into `index.ts`**

Replace the full contents of `src/index.ts` with:
```ts
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.routes';
import productsRoutes from './routes/products.routes';
import storefrontRoutes from './routes/storefront.routes';
import webhooksRoutes from './routes/webhooks.routes';

dotenv.config();

const app = express();
app.use(cors());

// Stripe needs the raw, unparsed body to verify its signature -- this must
// be mounted before the global express.json() below, not after.
app.use('/webhooks', express.raw({ type: 'application/json' }), webhooksRoutes);

app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/auth', authRoutes);
app.use('/products', productsRoutes);
app.use('/', storefrontRoutes);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Kazii+ backend listening on port ${PORT}`);
});
```

- [ ] **Step 9: Document the new env vars**

Add to `.env.example`, after the existing `JWT_SECRET` line:
```
# Stripe test-mode keys -- from the Stripe dashboard's Developers > API keys page.
STRIPE_SECRET_KEY="sk_test_..."

# From Stripe's webhook endpoint settings (or `stripe listen` locally).
STRIPE_WEBHOOK_SECRET="whsec_..."

# Base URL of the deployed frontend -- used to build Stripe's success/cancel redirect URLs.
FRONTEND_URL="https://kaziiplus.com"
```

- [ ] **Step 10: Run the full build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 11: Run the full test suite**

Run: `npm test`
Expected: PASS, all suites (slugify, auth.controller, products.controller, storefront.controller, checkout.controller, webhooks.routes).

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json src/lib/stripe.ts src/schemas/checkout.schemas.ts src/controllers/checkout.controller.ts src/controllers/checkout.controller.test.ts src/routes/webhooks.routes.ts src/routes/webhooks.routes.test.ts src/index.ts .env.example
git commit -m "Add Stripe checkout and webhook, wire raw-body route ahead of JSON parser"
```

---

## Task 6: Deploy and verify against production

**Files:** None — this task sets Railway configuration and runs verification commands, no code changes.

**Interfaces:** None new — this task exercises everything Tasks 1–5 produced, end-to-end, against the real `kaziiplus` Railway project (project ID `02028e4f-30ee-4e52-9bfd-db6b8c24992f`, environment `production`, service `kazii-backend` / `3dc2f631-5be2-49c1-b90c-f6cb99a77bcd`) and the live `kaziiplus.com` domain.

- [ ] **Step 1: Get real Stripe test-mode keys**

This requires a Stripe account (create one at stripe.com if none exists yet — test mode needs no business verification). From the dashboard: Developers → API keys → copy the **test mode** Secret key (`sk_test_...`). Webhook secret comes after Step 3 below, since Stripe generates it when the endpoint is created.

- [ ] **Step 2: Set backend environment variables on Railway**

Using the Railway MCP tools (`mcp__railway__set-variables`) against the `kazii-backend` service, set:
- `STRIPE_SECRET_KEY` — the test-mode key from Step 1.
- `FRONTEND_URL` — `https://www.kaziiplus.com` (the frontend's live custom domain).

Leave `STRIPE_WEBHOOK_SECRET` for Step 3 — Stripe generates it when the webhook endpoint is registered, which needs the backend's live URL first.

- [ ] **Step 3: Register the Stripe webhook endpoint**

In the Stripe dashboard (test mode): Developers → Webhooks → Add endpoint. URL: `https://api.kaziiplus.com/webhooks/stripe`. Event: `checkout.session.completed`. Stripe shows a signing secret (`whsec_...`) on creation — set that as `STRIPE_WEBHOOK_SECRET` on the `kazii-backend` Railway service via `mcp__railway__set-variables`.

- [ ] **Step 4: Confirm the deploy is healthy**

Run: `curl https://api.kaziiplus.com/health`
Expected: `{"status":"ok"}` — confirms the new code deployed and didn't crash on boot (this is the check that the lazy Stripe/FRONTEND_URL checks from Task 5 were worth doing — a misconfigured Stripe key must not break this).

- [ ] **Step 5: Verify product CRUD against production**

Sign up a real test creator and exercise the product endpoints:
```bash
curl -sS -X POST https://api.kaziiplus.com/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"plan-verify@kaziiplus.com","password":"password123","accountType":"CREATOR","firstName":"Plan"}'
```
Save the returned `token`, then:
```bash
TOKEN="<paste token>"
curl -sS -X POST https://api.kaziiplus.com/products \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Verify Tee","productType":"tshirt","price":20}'
```
Expected: `201` with a `product` object. Save the returned product `id`, then:
```bash
curl -sS -X PATCH https://api.kaziiplus.com/products/<id> \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"LIVE"}'
```
Expected: `200` with `status: "LIVE"`.

- [ ] **Step 6: Verify the public storefront resolves**

```bash
curl -sS https://api.kaziiplus.com/store/plan
```
Expected: `{"live":true,"brandName":"Plan","products":[{"...":"...","name":"Verify Tee",...}]}` — the slug `plan` comes from `generateUniqueStorefrontSlug` slugifying the signup's `firstName` (Task 1).

- [ ] **Step 7: Verify checkout creates a real Stripe session**

```bash
curl -sS -X POST https://api.kaziiplus.com/store/plan/checkout \
  -H "Content-Type: application/json" \
  -d '{"productId":"<id>","quantity":1,"customerEmail":"buyer@example.com"}'
```
Expected: `{"checkoutUrl":"https://checkout.stripe.com/..."}`. Open that URL in a browser and pay with Stripe's test card `4242 4242 4242 4242`, any future expiry, any CVC.

- [ ] **Step 8: Verify the webhook marked the order PAID**

```bash
curl -sS -X GET https://api.kaziiplus.com/creators/me/orders -H "Authorization: Bearer $TOKEN"
```
Expected: the order from Step 7 shows `"paymentStatus":"PAID"` — confirms Stripe's webhook reached the backend and the raw-body signature verification worked end to end.

- [ ] **Step 9: Clean up test data**

Using the same `prisma db execute` pattern established during the original launch, delete the `plan-verify@kaziiplus.com` user, its `creator_profiles` row, the test `Order`, and the test `Product` row from the production database, in that dependency order (orders/products reference the creator profile; delete children before the parent).

- [ ] **Step 10: Update the backend README**

In `kazii-backend/README.md`, replace the "## What's next (not built yet)" section's "Product endpoints" and "Frontend wiring" bullets — both are now done. Leave the Supplier/Manufacturer directory and fulfillment-provider bullets as-is (still not built; that's Phase 3 and the separate Printful-connect plan).

- [ ] **Step 11: Commit the README update**

```bash
git add README.md
git commit -m "Update README: Phase 2 (products, storefront, checkout) is live"
git push origin main
```
