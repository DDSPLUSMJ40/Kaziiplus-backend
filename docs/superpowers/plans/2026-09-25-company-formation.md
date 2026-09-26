# Company Formation for Creators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a logged-in creator form a US LLC (with EIN and registered agent) from inside Kazii+, paying through Stripe, with a swappable formation provider behind an adapter and a mock provider built first.

**Architecture:** A new `FormationOrder` table tracks each filing. A provider adapter (`formation.adapter.ts` + `formation.mock.ts`) hides the filing provider; creator endpoints under `/formation` quote a price, create a Stripe Checkout Session, and list orders. Two webhooks drive state: the existing Stripe webhook branches on `metadata.kind === 'formation'` to submit the paid order to the provider, and a new signature-verified `/webhooks/formation` route moves the order forward as the provider reports progress. A "Company" tab in the workspace (separate repo, `kazii-frontend`) is the creator-facing UI.

**Tech Stack:** Express, Prisma, Zod, Stripe, Vitest (backend, existing). Static HTML/JS, no build step (frontend, existing).

**Spec:** `docs/superpowers/specs/2026-09-25-company-formation-design.md`

## Global Constraints

- **LLC only.** `companyName` must end in "LLC" (case-insensitive). No C-Corp path.
- **US-resident founders only.** `mailingAddress` is a US address with a 2-letter USPS state code and a 5-digit (or ZIP+4) zip.
- **The server recomputes the price.** Checkout never trusts a client-sent price; `totalCents = providerCostCents + markupCents`, both frozen on the order at creation.
- **Mock-in-live guard.** The mock provider only runs when `STRIPE_SECRET_KEY` starts with `sk_test_`. Otherwise every formation endpoint returns `503 { error: 'formation_unavailable' }`. This exists so the mock can never take a real card payment for a filing that will never happen.
- **`FORMATION_ENABLED` must equal the string `'true'`** or every creator-facing formation endpoint returns `503 formation_unavailable`. Missing or invalid `FORMATION_MARKUP_CENTS` (must be a non-negative integer) does the same, so a misconfigured deploy cannot sell at zero margin by accident.
- **Never store or log an SSN or date of birth.** There are no columns for them; do not add any.
- **Atomic paid transition.** `PENDING_PAYMENT → PAID` is a single `updateMany` guarded by `status = PENDING_PAYMENT`; a Stripe redelivery updates 0 rows and does nothing.
- **Refund on permanent submission failure.** Submission failure after payment sets `FAILED`, refunds through Stripe, then sets `REFUNDED`. If the refund itself fails the order stays `FAILED` with `failureReason` ending `; refund_failed`.
- **Provider statuses only move forward** (`SUBMITTED → FILED → COMPLETED`). A provider `FAILED` event applies only while the order is `SUBMITTED` or `FILED`, sets `FAILED` with no auto-refund, and is ignored once the order is `COMPLETED`, `FAILED`, or `REFUNDED`. An unknown `providerOrderId` returns `200`.
- Every endpoint taking a body validates with a Zod schema via `.safeParse()`; on failure return `400 { error: 'validation_failed', details: parsed.error.flatten() }`.
- **Every new route handler that awaits Prisma, Stripe, or a provider is wrapped in `asyncHandler`** (`src/middleware/asyncHandler.ts`). The AI feature's final review caught this omission; do not repeat it.
- **Every new frontend function called from an inline `onclick`/`onchange`/`oninput` attribute MUST be added to the `window.fn = fn` exposure block at the end of its IIFE.** This project has broken exactly this way repeatedly; Task 6 lists it as its own step per function.
- Environment variables are set on Railway, never committed: `FORMATION_ENABLED`, `FORMATION_PROVIDER`, `FORMATION_MARKUP_CENTS`, `FORMATION_WEBHOOK_SECRET`.
- Repo hygiene: never `git add -A`; always stage explicit files. After any `prisma/schema.prisma` change run `npx prisma generate` (a stale generated client caused a build failure earlier in this project).

## File Structure

| File | Repo | Responsibility |
|---|---|---|
| `prisma/schema.prisma` (+ migration) | backend | `FormationStatus` enum, `FormationOrder` model, `CreatorProfile.formationOrders` |
| `src/lib/formation.config.ts` | backend | `getMarkupCents()`, `isFormationAvailable()` |
| `src/schemas/formation.schemas.ts` | backend | Zod schemas and the 50-state list |
| `src/adapters/formation.adapter.ts` | backend | Provider types + `getFormationProvider()` |
| `src/adapters/formation.mock.ts` | backend | Mock provider (quote table, fake submit, HMAC-verified webhook) |
| `src/controllers/formation.controller.ts` | backend | `getFormationQuote`, `createFormationCheckout`, `listFormationOrders` |
| `src/routes/formation.routes.ts` | backend | Creator-authed `/formation` router |
| `src/controllers/formation.webhook.controller.ts` | backend | `handleFormationPaid`, `handleFormationProviderWebhook` |
| `src/routes/webhooks.routes.ts` | backend | Modify: Stripe branch for `kind: 'formation'`, new `/formation` webhook route |
| `src/index.ts` | backend | Modify: mount `/formation` |
| `kazii-full-demo.html` | frontend | "Company" workspace tab |

---

## Task 1: Schema — `FormationOrder`

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: enum `FormationStatus` (`PENDING_PAYMENT | PAID | SUBMITTED | FILED | COMPLETED | FAILED | REFUNDED`) and model `FormationOrder` (fields below), and `CreatorProfile.formationOrders: FormationOrder[]`. Consumed by Tasks 4 and 5 as `prisma.formationOrder`.

This task has no application code and no Vitest tests — `prisma validate`, a real migration, and a passing build are the verification, as with every other schema change in this project.

- [ ] **Step 1: Add the enum and model**

In `prisma/schema.prisma`, add near `AiGeneration`:

```prisma
enum FormationStatus {
  PENDING_PAYMENT
  PAID
  SUBMITTED
  FILED
  COMPLETED
  FAILED
  REFUNDED
}

model FormationOrder {
  id                      String          @id @default(cuid())
  creatorId               String
  creator                 CreatorProfile  @relation(fields: [creatorId], references: [id], onDelete: Cascade)
  provider                String
  providerOrderId         String?         @unique
  companyName             String
  state                   String
  founderName             String
  founderEmail            String
  mailingAddress          Json
  providerCostCents       Int
  stateFeeCents           Int
  markupCents             Int
  totalCents              Int
  stripeSessionId         String?         @unique
  stripePaymentIntentId   String?
  status                  FormationStatus @default(PENDING_PAYMENT)
  ein                     String?
  registeredAgentAssigned Boolean         @default(false)
  failureReason           String?
  createdAt               DateTime        @default(now())
  updatedAt               DateTime        @updatedAt

  @@map("formation_orders")
}
```

Add the inverse relation inside `model CreatorProfile`, alongside `aiGenerations`:

```prisma
  formationOrders FormationOrder[]
```

- [ ] **Step 2: Validate**

Run (from `kazii-backend/`):
```bash
DATABASE_URL="$(railway variables --service Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)" npx prisma validate
```
Expected: `The schema at prisma\schema.prisma is valid`. Do not echo the URL.

- [ ] **Step 3: Create and apply the migration against the live database**

```bash
DATABASE_URL="$(railway variables --service Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)" npx prisma migrate dev --name add_formation_orders
```
Expected: a new folder under `prisma/migrations/` is created and applied; ends with `Your database is now in sync with your schema.` and regenerates the client.

- [ ] **Step 4: Regenerate the client and build**

```bash
npx prisma generate
npm run build
```
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "Add FormationOrder table for embedded company formation"
```

---

## Task 2: Config, availability guard, and Zod schemas

**Files:**
- Create: `src/lib/formation.config.ts`
- Create: `src/schemas/formation.schemas.ts`
- Test: `src/lib/formation.config.test.ts`
- Test: `src/schemas/formation.schemas.test.ts`

**Interfaces:**
- Produces:
  - `getMarkupCents(): number | null`
  - `isFormationAvailable(): boolean`
  - `USPS_STATES` (readonly tuple of the 50 state codes), `stateSchema`, `formationQuoteQuerySchema`, `formationCheckoutSchema`. Consumed by Task 4.

- [ ] **Step 1: Write the failing config tests**

Create `src/lib/formation.config.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getMarkupCents, isFormationAvailable } from './formation.config';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.FORMATION_ENABLED = 'true';
  process.env.FORMATION_PROVIDER = 'mock';
  process.env.FORMATION_MARKUP_CENTS = '7900';
  process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('getMarkupCents', () => {
  it('parses a non-negative integer', () => {
    expect(getMarkupCents()).toBe(7900);
  });

  it('accepts zero', () => {
    process.env.FORMATION_MARKUP_CENTS = '0';
    expect(getMarkupCents()).toBe(0);
  });

  it.each(['abc', '-5', '12.5', '', ' 7900'])('returns null for invalid value %j', (value) => {
    process.env.FORMATION_MARKUP_CENTS = value;
    expect(getMarkupCents()).toBeNull();
  });

  it('returns null when unset', () => {
    delete process.env.FORMATION_MARKUP_CENTS;
    expect(getMarkupCents()).toBeNull();
  });
});

describe('isFormationAvailable', () => {
  it('is available when enabled, markup valid, mock provider, and a test Stripe key', () => {
    expect(isFormationAvailable()).toBe(true);
  });

  it('defaults the provider to mock when FORMATION_PROVIDER is unset', () => {
    delete process.env.FORMATION_PROVIDER;
    expect(isFormationAvailable()).toBe(true);
  });

  it('is unavailable unless FORMATION_ENABLED is exactly "true"', () => {
    process.env.FORMATION_ENABLED = 'yes';
    expect(isFormationAvailable()).toBe(false);
    delete process.env.FORMATION_ENABLED;
    expect(isFormationAvailable()).toBe(false);
  });

  it('is unavailable when the markup is missing or invalid', () => {
    delete process.env.FORMATION_MARKUP_CENTS;
    expect(isFormationAvailable()).toBe(false);
    process.env.FORMATION_MARKUP_CENTS = 'lots';
    expect(isFormationAvailable()).toBe(false);
  });

  it('refuses the mock provider with a live Stripe key (never charge real cards for a fake filing)', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_abc123';
    expect(isFormationAvailable()).toBe(false);
  });

  it('refuses the mock provider when the Stripe key is missing', () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(isFormationAvailable()).toBe(false);
  });

  it('is unavailable for a provider that has no adapter yet', () => {
    process.env.FORMATION_PROVIDER = 'doola';
    expect(isFormationAvailable()).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing schema tests**

Create `src/schemas/formation.schemas.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { USPS_STATES, formationCheckoutSchema, formationQuoteQuerySchema } from './formation.schemas';

const valid = {
  companyName: 'Jade Studio LLC',
  state: 'DE',
  founderName: 'Jade Williamson',
  founderEmail: 'jade@example.com',
  mailingAddress: { line1: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' },
  acknowledged: true,
};

describe('USPS_STATES', () => {
  it('lists exactly the 50 states', () => {
    expect(USPS_STATES).toHaveLength(50);
    expect(new Set(USPS_STATES).size).toBe(50);
  });
});

describe('formationQuoteQuerySchema', () => {
  it('accepts a valid state', () => {
    expect(formationQuoteQuerySchema.safeParse({ state: 'WY' }).success).toBe(true);
  });
  it('rejects an unknown state', () => {
    expect(formationQuoteQuerySchema.safeParse({ state: 'ZZ' }).success).toBe(false);
  });
});

describe('formationCheckoutSchema', () => {
  it('accepts a valid payload', () => {
    expect(formationCheckoutSchema.safeParse(valid).success).toBe(true);
  });

  it.each(['Jade Studio llc', 'Jade Studio, LLC', 'Jade Studio LLC '])('accepts LLC suffix in %j', (companyName) => {
    expect(formationCheckoutSchema.safeParse({ ...valid, companyName }).success).toBe(true);
  });

  it.each(['Jade Studio', 'Jade Studio Inc', 'Jade LLC Holdings', ''])('rejects a name that does not end in LLC: %j', (companyName) => {
    expect(formationCheckoutSchema.safeParse({ ...valid, companyName }).success).toBe(false);
  });

  it('rejects a name over 120 characters', () => {
    expect(formationCheckoutSchema.safeParse({ ...valid, companyName: `${'A'.repeat(118)} LLC` }).success).toBe(false);
  });

  it('requires the acknowledgement to be literally true', () => {
    expect(formationCheckoutSchema.safeParse({ ...valid, acknowledged: false }).success).toBe(false);
    const { acknowledged: _omit, ...withoutAck } = valid;
    expect(formationCheckoutSchema.safeParse(withoutAck).success).toBe(false);
  });

  it('rejects a bad formation state, mailing state, or zip', () => {
    expect(formationCheckoutSchema.safeParse({ ...valid, state: 'ZZ' }).success).toBe(false);
    expect(formationCheckoutSchema.safeParse({ ...valid, mailingAddress: { ...valid.mailingAddress, state: 'ZZ' } }).success).toBe(false);
    expect(formationCheckoutSchema.safeParse({ ...valid, mailingAddress: { ...valid.mailingAddress, zip: '787' } }).success).toBe(false);
  });

  it('accepts ZIP+4', () => {
    expect(formationCheckoutSchema.safeParse({ ...valid, mailingAddress: { ...valid.mailingAddress, zip: '78701-1234' } }).success).toBe(true);
  });

  it('rejects a bad founder email', () => {
    expect(formationCheckoutSchema.safeParse({ ...valid, founderEmail: 'not-an-email' }).success).toBe(false);
  });

  it('strips client-sent price fields rather than trusting them', () => {
    const result = formationCheckoutSchema.safeParse({ ...valid, totalCents: 1 });
    expect(result.success).toBe(true);
    if (result.success) expect('totalCents' in result.data).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- formation.config formation.schemas`
Expected: FAIL — `Cannot find module './formation.config'` / `'./formation.schemas'`.

- [ ] **Step 4: Implement the config**

Create `src/lib/formation.config.ts`:
```ts
// Providers with a real adapter. Add 'doola' here in the same commit that
// adds src/adapters/doola.adapter.ts -- never before, or a misconfigured
// deploy would pass the guard and then throw inside getFormationProvider().
const IMPLEMENTED_PROVIDERS = ['mock'];

export function getMarkupCents(): number | null {
  const raw = process.env.FORMATION_MARKUP_CENTS;
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

export function isFormationAvailable(): boolean {
  if (process.env.FORMATION_ENABLED !== 'true') return false;
  if (getMarkupCents() === null) return false;

  const provider = (process.env.FORMATION_PROVIDER ?? 'mock').toLowerCase();
  if (!IMPLEMENTED_PROVIDERS.includes(provider)) return false;

  // The mock provider files nothing. It must never sit in front of a live
  // Stripe key, or real cards would be charged for a filing that never happens.
  if (provider === 'mock' && !(process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_test_')) return false;

  return true;
}
```

- [ ] **Step 5: Implement the schemas**

Create `src/schemas/formation.schemas.ts`:
```ts
import { z } from 'zod';

export const USPS_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const;

export const stateSchema = z.enum(USPS_STATES);

export const formationQuoteQuerySchema = z.object({ state: stateSchema });

export const formationCheckoutSchema = z.object({
  companyName: z
    .string()
    .trim()
    .min(1, 'Company name is required.')
    .max(120, 'Company name must be 120 characters or fewer.')
    .refine((v) => /(^|[\s,])llc$/i.test(v), 'Company name must end in "LLC".'),
  state: stateSchema,
  founderName: z.string().trim().min(1).max(120),
  founderEmail: z.string().trim().email().max(200),
  mailingAddress: z.object({
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(100),
    state: stateSchema,
    zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, 'Enter a 5-digit ZIP code.'),
  }),
  acknowledged: z.literal(true, {
    errorMap: () => ({ message: 'You must acknowledge that Kazii+ is not a law firm.' }),
  }),
});

export type FormationCheckoutInput = z.infer<typeof formationCheckoutSchema>;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- formation.config formation.schemas`
Expected: PASS (all cases).

- [ ] **Step 7: Run the build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/lib/formation.config.ts src/lib/formation.config.test.ts src/schemas/formation.schemas.ts src/schemas/formation.schemas.test.ts
git commit -m "Add formation availability guard and Zod schemas"
```

---

## Task 3: Provider adapter and mock provider

**Files:**
- Create: `src/adapters/formation.adapter.ts`
- Create: `src/adapters/formation.mock.ts`
- Test: `src/adapters/formation.mock.test.ts`

**Interfaces:**
- Produces (from `formation.adapter.ts`): types `FormationQuote`, `FormationInput`, `ProviderStatus`, `FormationStatusEvent`, `FormationProvider`, and `getFormationProvider(): FormationProvider`. Consumed by Tasks 4 and 5.
- Produces (from `formation.mock.ts`): `mockFormationProvider: FormationProvider`.
- The mock verifies a webhook header `x-formation-signature` = hex HMAC-SHA256 of the raw body keyed by `FORMATION_WEBHOOK_SECRET`. Task 7 uses this to advance statuses.
- Mock-only affordance: `submitFormation` throws when `companyName` contains "FAIL" (case-insensitive), so Task 7 can exercise the refund path against real Stripe test payments.

- [ ] **Step 1: Write the failing tests**

Create `src/adapters/formation.mock.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { mockFormationProvider } from './formation.mock';
import { getFormationProvider } from './formation.adapter';

const ORIGINAL_ENV = { ...process.env };
const SECRET = 'whsec_mock_test';

function sign(body: string, secret = SECRET) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

beforeEach(() => {
  process.env.FORMATION_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const input = {
  companyName: 'Jade Studio LLC',
  state: 'DE',
  founderName: 'Jade Williamson',
  founderEmail: 'jade@example.com',
  mailingAddress: { line1: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' },
};

describe('mockFormationProvider.getQuote', () => {
  it('uses the state fee table and adds a flat mock service cost', async () => {
    expect(await mockFormationProvider.getQuote('DE')).toEqual({ stateFeeCents: 11000, providerCostCents: 14900 });
  });

  it('falls back to a default state fee for states not in the table', async () => {
    expect(await mockFormationProvider.getQuote('MT')).toEqual({ stateFeeCents: 10000, providerCostCents: 13900 });
  });
});

describe('mockFormationProvider.submitFormation', () => {
  it('returns a fake provider order id', async () => {
    const result = await mockFormationProvider.submitFormation(input);
    expect(result.providerOrderId).toMatch(/^mock_/);
  });

  it('throws when the company name contains FAIL (forced-failure hook for verification)', async () => {
    await expect(mockFormationProvider.submitFormation({ ...input, companyName: 'Fail Test LLC' })).rejects.toThrow();
  });
});

describe('mockFormationProvider.parseStatusWebhook', () => {
  it('parses a correctly signed event', () => {
    const body = JSON.stringify({ providerOrderId: 'mock_1', status: 'COMPLETED', ein: '12-3456789', registeredAgentAssigned: true });
    const event = mockFormationProvider.parseStatusWebhook(Buffer.from(body), { 'x-formation-signature': sign(body) });
    expect(event).toEqual({ providerOrderId: 'mock_1', status: 'COMPLETED', ein: '12-3456789', registeredAgentAssigned: true });
  });

  it('drops unknown status values but keeps the rest', () => {
    const body = JSON.stringify({ providerOrderId: 'mock_1', status: 'WEIRD', ein: '12-3456789' });
    const event = mockFormationProvider.parseStatusWebhook(Buffer.from(body), { 'x-formation-signature': sign(body) });
    expect(event).toEqual({ providerOrderId: 'mock_1', ein: '12-3456789' });
  });

  it('throws on a wrong signature', () => {
    const body = JSON.stringify({ providerOrderId: 'mock_1', status: 'FILED' });
    expect(() => mockFormationProvider.parseStatusWebhook(Buffer.from(body), { 'x-formation-signature': sign(body, 'other') })).toThrow();
  });

  it('throws on a missing or malformed signature header', () => {
    const body = JSON.stringify({ providerOrderId: 'mock_1', status: 'FILED' });
    expect(() => mockFormationProvider.parseStatusWebhook(Buffer.from(body), {})).toThrow();
    expect(() => mockFormationProvider.parseStatusWebhook(Buffer.from(body), { 'x-formation-signature': 'zz' })).toThrow();
  });

  it('throws when the webhook secret is not configured', () => {
    delete process.env.FORMATION_WEBHOOK_SECRET;
    const body = JSON.stringify({ providerOrderId: 'mock_1', status: 'FILED' });
    expect(() => mockFormationProvider.parseStatusWebhook(Buffer.from(body), { 'x-formation-signature': sign(body) })).toThrow();
  });

  it('returns null for a validly signed body it does not understand', () => {
    const notJson = 'hello';
    expect(mockFormationProvider.parseStatusWebhook(Buffer.from(notJson), { 'x-formation-signature': sign(notJson) })).toBeNull();
    const noOrderId = JSON.stringify({ status: 'FILED' });
    expect(mockFormationProvider.parseStatusWebhook(Buffer.from(noOrderId), { 'x-formation-signature': sign(noOrderId) })).toBeNull();
  });
});

describe('getFormationProvider', () => {
  it('returns the mock provider by default', () => {
    delete process.env.FORMATION_PROVIDER;
    expect(getFormationProvider().name).toBe('MOCK');
  });

  it('throws for a provider that has no adapter yet', () => {
    process.env.FORMATION_PROVIDER = 'doola';
    expect(() => getFormationProvider()).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- formation.mock`
Expected: FAIL — `Cannot find module './formation.mock'`.

- [ ] **Step 3: Implement the adapter interface**

Create `src/adapters/formation.adapter.ts`:
```ts
import { mockFormationProvider } from './formation.mock';

export interface FormationQuote {
  providerCostCents: number; // all-in wholesale, including the state filing fee
  stateFeeCents: number; // the state-filing-fee portion, for the price breakdown
}

export interface FormationInput {
  companyName: string;
  state: string;
  founderName: string;
  founderEmail: string;
  mailingAddress: { line1: string; line2?: string; city: string; state: string; zip: string };
}

export type ProviderStatus = 'FILED' | 'COMPLETED' | 'FAILED';

export interface FormationStatusEvent {
  providerOrderId: string;
  status?: ProviderStatus;
  ein?: string;
  registeredAgentAssigned?: boolean;
  failureReason?: string;
}

export interface FormationProvider {
  name: 'MOCK' | 'DOOLA';
  getQuote(state: string): Promise<FormationQuote>;
  submitFormation(input: FormationInput): Promise<{ providerOrderId: string }>;
  // Throws on an invalid signature; returns null for an event we ignore.
  parseStatusWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): FormationStatusEvent | null;
}

export function getFormationProvider(): FormationProvider {
  const name = (process.env.FORMATION_PROVIDER ?? 'mock').toLowerCase();
  if (name === 'mock') return mockFormationProvider;
  throw new Error(`Unknown or unimplemented FORMATION_PROVIDER: ${name}`);
}
```

- [ ] **Step 4: Implement the mock provider**

Create `src/adapters/formation.mock.ts`:
```ts
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import type { FormationProvider, FormationStatusEvent, ProviderStatus } from './formation.adapter';

// Illustrative fees only -- real state filing fees come from the real provider.
const STATE_FEES_CENTS: Record<string, number> = { DE: 11000, WY: 10000, CA: 7000, TX: 30000, FL: 12500, NY: 20000 };
const DEFAULT_STATE_FEE_CENTS = 10000;
const MOCK_SERVICE_COST_CENTS = 3900;
const VALID_STATUSES: ProviderStatus[] = ['FILED', 'COMPLETED', 'FAILED'];

export const mockFormationProvider: FormationProvider = {
  name: 'MOCK',

  async getQuote(state) {
    const stateFeeCents = STATE_FEES_CENTS[state] ?? DEFAULT_STATE_FEE_CENTS;
    return { stateFeeCents, providerCostCents: stateFeeCents + MOCK_SERVICE_COST_CENTS };
  },

  async submitFormation(input) {
    // Forced-failure hook so live verification can exercise the refund path
    // with a real Stripe test payment. Safe: the mock only runs with a test key.
    if (input.companyName.toUpperCase().includes('FAIL')) {
      throw new Error('Mock provider: forced submission failure');
    }
    return { providerOrderId: `mock_${randomUUID()}` };
  },

  parseStatusWebhook(rawBody, headers) {
    const secret = process.env.FORMATION_WEBHOOK_SECRET;
    const header = headers['x-formation-signature'];
    if (!secret || typeof header !== 'string') {
      throw new Error('Missing webhook secret or signature');
    }
    const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'hex');
    const received = Buffer.from(header, 'hex');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new Error('Invalid signature');
    }

    let body: any;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return null;
    }
    if (!body || typeof body.providerOrderId !== 'string') return null;

    const event: FormationStatusEvent = { providerOrderId: body.providerOrderId };
    if (VALID_STATUSES.includes(body.status)) event.status = body.status;
    if (typeof body.ein === 'string') event.ein = body.ein;
    if (body.registeredAgentAssigned === true) event.registeredAgentAssigned = true;
    if (typeof body.failureReason === 'string') event.failureReason = body.failureReason;
    return event;
  },
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- formation.mock`
Expected: PASS (all cases).

- [ ] **Step 6: Run the build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/formation.adapter.ts src/adapters/formation.mock.ts src/adapters/formation.mock.test.ts
git commit -m "Add formation provider adapter and mock provider"
```

---

## Task 4: Creator endpoints (`/formation`)

**Files:**
- Create: `src/controllers/formation.controller.ts`
- Create: `src/routes/formation.routes.ts`
- Modify: `src/index.ts`
- Test: `src/controllers/formation.controller.test.ts`

**Interfaces:**
- Consumes: `getFormationProvider` (Task 3), `isFormationAvailable` / `getMarkupCents` (Task 2), `formationQuoteQuerySchema` / `formationCheckoutSchema` (Task 2), `prisma.formationOrder` (Task 1), `getStripe` from `src/lib/stripe`.
- Produces: `getFormationQuote`, `createFormationCheckout`, `listFormationOrders` (each `(req: AuthedRequest, res: Response) => Promise<Response | void>`), and the mounted routes `GET /formation/quote`, `POST /formation/checkout`, `GET /formation/orders`. Response shapes: quote `{ stateFeeCents, serviceFeeCents, totalCents }`; checkout `{ url }`; orders `{ orders: [...] }`.

- [ ] **Step 1: Write the failing tests**

Create `src/controllers/formation.controller.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Response } from 'express';
import type { AuthedRequest } from '../middleware/auth.middleware';

const mockPrisma = vi.hoisted(() => ({
  creatorProfile: { findUnique: vi.fn() },
  formationOrder: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
}));
const mockStripe = vi.hoisted(() => ({ checkout: { sessions: { create: vi.fn() } } }));
const mockProvider = vi.hoisted(() => ({ name: 'MOCK', getQuote: vi.fn() }));

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
vi.mock('../lib/stripe', () => ({ getStripe: () => mockStripe }));
vi.mock('../adapters/formation.adapter', () => ({ getFormationProvider: () => mockProvider }));

import { getFormationQuote, createFormationCheckout, listFormationOrders } from './formation.controller';

const ORIGINAL_ENV = { ...process.env };

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

const validBody = {
  companyName: 'Jade Studio LLC',
  state: 'DE',
  founderName: 'Jade Williamson',
  founderEmail: 'jade@example.com',
  mailingAddress: { line1: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' },
  acknowledged: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FORMATION_ENABLED = 'true';
  process.env.FORMATION_PROVIDER = 'mock';
  process.env.FORMATION_MARKUP_CENTS = '7900';
  process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';
  process.env.FRONTEND_URL = 'https://www.kaziiplus.com';
  mockPrisma.creatorProfile.findUnique.mockResolvedValue({ id: 'c1' });
  mockProvider.getQuote.mockResolvedValue({ providerCostCents: 14900, stateFeeCents: 11000 });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('getFormationQuote', () => {
  it('returns 503 when formation is unavailable', async () => {
    delete process.env.FORMATION_ENABLED;
    const res = mockRes();
    await getFormationQuote({ query: { state: 'DE' }, userId: 'u1' } as unknown as AuthedRequest, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: 'formation_unavailable' });
  });

  it('returns 400 for an invalid state', async () => {
    const res = mockRes();
    await getFormationQuote({ query: { state: 'ZZ' }, userId: 'u1' } as unknown as AuthedRequest, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns the fee breakdown: service fee = provider cost - state fee + markup', async () => {
    const res = mockRes();
    await getFormationQuote({ query: { state: 'DE' }, userId: 'u1' } as unknown as AuthedRequest, res);
    expect(res.json).toHaveBeenCalledWith({ stateFeeCents: 11000, serviceFeeCents: 11800, totalCents: 22800 });
  });

  it('returns 503 when the provider cannot produce a quote', async () => {
    mockProvider.getQuote.mockRejectedValue(new Error('provider down'));
    const res = mockRes();
    await getFormationQuote({ query: { state: 'DE' }, userId: 'u1' } as unknown as AuthedRequest, res);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

describe('createFormationCheckout', () => {
  it('returns 503 when formation is unavailable (e.g. mock provider with a live Stripe key)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_abc123';
    const res = mockRes();
    await createFormationCheckout({ body: validBody, userId: 'u1' } as AuthedRequest, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('returns 400 when the acknowledgement is missing', async () => {
    const res = mockRes();
    await createFormationCheckout({ body: { ...validBody, acknowledged: false }, userId: 'u1' } as AuthedRequest, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.formationOrder.create).not.toHaveBeenCalled();
  });

  it('returns 404 when the caller has no creator profile', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue(null);
    const res = mockRes();
    await createFormationCheckout({ body: validBody, userId: 'u1' } as AuthedRequest, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('creates a PENDING order with server-computed frozen amounts, then a tagged Stripe session', async () => {
    mockPrisma.formationOrder.create.mockResolvedValue({ id: 'fo1' });
    mockStripe.checkout.sessions.create.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/pay/cs_1' });
    const res = mockRes();
    await createFormationCheckout({ body: validBody, userId: 'u1' } as AuthedRequest, res);

    expect(mockPrisma.formationOrder.create).toHaveBeenCalledWith({
      data: {
        creatorId: 'c1',
        provider: 'MOCK',
        companyName: 'Jade Studio LLC',
        state: 'DE',
        founderName: 'Jade Williamson',
        founderEmail: 'jade@example.com',
        mailingAddress: { line1: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' },
        providerCostCents: 14900,
        stateFeeCents: 11000,
        markupCents: 7900,
        totalCents: 22800,
      },
    });
    const sessionArgs = mockStripe.checkout.sessions.create.mock.calls[0][0];
    expect(sessionArgs.mode).toBe('payment');
    expect(sessionArgs.line_items[0].price_data.unit_amount).toBe(22800);
    expect(sessionArgs.metadata).toEqual({ kind: 'formation', formationOrderId: 'fo1' });
    expect(sessionArgs.customer_email).toBe('jade@example.com');
    expect(sessionArgs.success_url).toBe('https://www.kaziiplus.com/?formation=success');
    expect(sessionArgs.cancel_url).toBe('https://www.kaziiplus.com/?formation=cancelled');
    expect(mockPrisma.formationOrder.update).toHaveBeenCalledWith({ where: { id: 'fo1' }, data: { stripeSessionId: 'cs_1' } });
    expect(res.json).toHaveBeenCalledWith({ url: 'https://checkout.stripe.com/pay/cs_1' });
  });

  it('ignores any price the client sends', async () => {
    mockPrisma.formationOrder.create.mockResolvedValue({ id: 'fo1' });
    mockStripe.checkout.sessions.create.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/pay/cs_1' });
    const res = mockRes();
    await createFormationCheckout({ body: { ...validBody, totalCents: 1, markupCents: 0 }, userId: 'u1' } as AuthedRequest, res);
    expect(mockStripe.checkout.sessions.create.mock.calls[0][0].line_items[0].price_data.unit_amount).toBe(22800);
  });

  it('returns 503 when the provider cannot produce a quote', async () => {
    mockProvider.getQuote.mockRejectedValue(new Error('provider down'));
    const res = mockRes();
    await createFormationCheckout({ body: validBody, userId: 'u1' } as AuthedRequest, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(mockPrisma.formationOrder.create).not.toHaveBeenCalled();
  });
});

describe('listFormationOrders', () => {
  it('returns 503 when formation is unavailable', async () => {
    delete process.env.FORMATION_ENABLED;
    const res = mockRes();
    await listFormationOrders({ userId: 'u1' } as AuthedRequest, res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('returns 404 when the caller has no creator profile', async () => {
    mockPrisma.creatorProfile.findUnique.mockResolvedValue(null);
    const res = mockRes();
    await listFormationOrders({ userId: 'u1' } as AuthedRequest, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("lists only the caller's paid-or-later orders, newest first", async () => {
    mockPrisma.formationOrder.findMany.mockResolvedValue([{ id: 'fo1', status: 'SUBMITTED' }]);
    const res = mockRes();
    await listFormationOrders({ userId: 'u1' } as AuthedRequest, res);
    expect(mockPrisma.formationOrder.findMany).toHaveBeenCalledWith({
      where: { creatorId: 'c1', status: { not: 'PENDING_PAYMENT' } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        companyName: true,
        state: true,
        founderEmail: true,
        status: true,
        totalCents: true,
        ein: true,
        registeredAgentAssigned: true,
        createdAt: true,
      },
    });
    expect(res.json).toHaveBeenCalledWith({ orders: [{ id: 'fo1', status: 'SUBMITTED' }] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- formation.controller`
Expected: FAIL — `Cannot find module './formation.controller'`.

- [ ] **Step 3: Implement the controller**

Create `src/controllers/formation.controller.ts`:
```ts
import { Response } from 'express';
import Stripe from 'stripe';
import { prisma } from '../lib/prisma';
import { getStripe } from '../lib/stripe';
import { AuthedRequest } from '../middleware/auth.middleware';
import { formationCheckoutSchema, formationQuoteQuerySchema } from '../schemas/formation.schemas';
import { getFormationProvider } from '../adapters/formation.adapter';
import { getMarkupCents, isFormationAvailable } from '../lib/formation.config';

async function getCreatorProfileId(userId: string): Promise<string | null> {
  const profile = await prisma.creatorProfile.findUnique({ where: { userId }, select: { id: true } });
  return profile?.id ?? null;
}

export async function getFormationQuote(req: AuthedRequest, res: Response) {
  if (!isFormationAvailable()) return res.status(503).json({ error: 'formation_unavailable' });

  const parsed = formationQuoteQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', details: parsed.error.flatten() });
  }

  const markupCents = getMarkupCents();
  if (markupCents === null) return res.status(503).json({ error: 'formation_unavailable' });

  let quote;
  try {
    quote = await getFormationProvider().getQuote(parsed.data.state);
  } catch {
    return res.status(503).json({ error: 'formation_unavailable' });
  }

  return res.json({
    stateFeeCents: quote.stateFeeCents,
    serviceFeeCents: quote.providerCostCents - quote.stateFeeCents + markupCents,
    totalCents: quote.providerCostCents + markupCents,
  });
}

export async function createFormationCheckout(req: AuthedRequest, res: Response) {
  if (!isFormationAvailable()) return res.status(503).json({ error: 'formation_unavailable' });

  const parsed = formationCheckoutSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', details: parsed.error.flatten() });
  }

  const creatorId = await getCreatorProfileId(req.userId!);
  if (!creatorId) return res.status(404).json({ error: 'not_found' });

  const frontendUrl = process.env.FRONTEND_URL;
  if (!frontendUrl) {
    throw new Error('FRONTEND_URL is not set. Refusing to build a checkout redirect.');
  }

  const markupCents = getMarkupCents();
  if (markupCents === null) return res.status(503).json({ error: 'formation_unavailable' });

  // The price is always recomputed here from the provider's quote -- nothing
  // the client sends can influence what Stripe charges.
  const provider = getFormationProvider();
  let quote;
  try {
    quote = await provider.getQuote(parsed.data.state);
  } catch {
    return res.status(503).json({ error: 'formation_unavailable' });
  }
  const totalCents = quote.providerCostCents + markupCents;

  const order = await prisma.formationOrder.create({
    data: {
      creatorId,
      provider: provider.name,
      companyName: parsed.data.companyName,
      state: parsed.data.state,
      founderName: parsed.data.founderName,
      founderEmail: parsed.data.founderEmail,
      mailingAddress: parsed.data.mailingAddress,
      providerCostCents: quote.providerCostCents,
      stateFeeCents: quote.stateFeeCents,
      markupCents,
      totalCents,
    },
  });

  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: `LLC formation — ${parsed.data.companyName}`,
            description: `Includes the ${parsed.data.state} state filing fee`,
          },
          unit_amount: totalCents,
        },
        quantity: 1,
      },
    ],
    customer_email: parsed.data.founderEmail,
    metadata: { kind: 'formation', formationOrderId: order.id },
    success_url: `${frontendUrl}/?formation=success`,
    cancel_url: `${frontendUrl}/?formation=cancelled`,
    // Managed Payments (on by default on this Stripe account) only supports
    // digital goods; a filing service is not one, so it is disabled per
    // session exactly as in checkout.controller.ts. Not yet in the installed
    // SDK's TS types, hence the cast.
    managed_payments: { enabled: false },
  } as Stripe.Checkout.SessionCreateParams);

  await prisma.formationOrder.update({ where: { id: order.id }, data: { stripeSessionId: session.id } });

  return res.json({ url: session.url });
}

export async function listFormationOrders(req: AuthedRequest, res: Response) {
  if (!isFormationAvailable()) return res.status(503).json({ error: 'formation_unavailable' });

  const creatorId = await getCreatorProfileId(req.userId!);
  if (!creatorId) return res.status(404).json({ error: 'not_found' });

  // Unpaid attempts are hidden; there is no cleanup job in v1.
  const orders = await prisma.formationOrder.findMany({
    where: { creatorId, status: { not: 'PENDING_PAYMENT' } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      companyName: true,
      state: true,
      founderEmail: true,
      status: true,
      totalCents: true,
      ein: true,
      registeredAgentAssigned: true,
      createdAt: true,
    },
  });

  return res.json({ orders });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- formation.controller`
Expected: PASS (all cases).

- [ ] **Step 5: Create the router**

Create `src/routes/formation.routes.ts`:
```ts
import { Router } from 'express';
import { requireAuth, requireAccountType } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/asyncHandler';
import { getFormationQuote, createFormationCheckout, listFormationOrders } from '../controllers/formation.controller';

const router = Router();
router.use(requireAuth, requireAccountType('CREATOR'));

router.get('/quote', asyncHandler(getFormationQuote));
router.post('/checkout', asyncHandler(createFormationCheckout));
router.get('/orders', asyncHandler(listFormationOrders));

export default router;
```

- [ ] **Step 6: Mount it in `src/index.ts`**

Add the import beside the other route imports:
```ts
import formationRoutes from './routes/formation.routes';
```
Add the mount directly below `app.use('/ai', aiRoutes);`:
```ts
app.use('/formation', formationRoutes);
```

- [ ] **Step 7: Run the build and the full suite**

Run: `npm run build && npm test`
Expected: build exits 0; all suites pass.

- [ ] **Step 8: Commit**

```bash
git add src/controllers/formation.controller.ts src/controllers/formation.controller.test.ts src/routes/formation.routes.ts src/index.ts
git commit -m "Add /formation quote, checkout, and orders endpoints"
```

---

## Task 5: Webhooks — Stripe branch and provider status

**Files:**
- Create: `src/controllers/formation.webhook.controller.ts`
- Modify: `src/routes/webhooks.routes.ts`
- Test: `src/controllers/formation.webhook.controller.test.ts`
- Test: `src/routes/webhooks.formation.test.ts`

**Interfaces:**
- Consumes: `getFormationProvider` and `FormationStatusEvent` (Task 3), `prisma.formationOrder` (Task 1), `getStripe`.
- Produces: `handleFormationPaid(session: Stripe.Checkout.Session): Promise<void>` and `handleFormationProviderWebhook(req: Request, res: Response): Promise<Response | void>`. `webhooks.routes.ts` gains the Stripe branch and `POST /webhooks/formation`.

- [ ] **Step 1: Write the failing handler tests**

Create `src/controllers/formation.webhook.controller.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import type Stripe from 'stripe';

const mockPrisma = vi.hoisted(() => ({
  formationOrder: { updateMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
}));
const mockStripe = vi.hoisted(() => ({ refunds: { create: vi.fn() } }));
const mockProvider = vi.hoisted(() => ({ name: 'MOCK', submitFormation: vi.fn(), parseStatusWebhook: vi.fn() }));

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
vi.mock('../lib/stripe', () => ({ getStripe: () => mockStripe }));
vi.mock('../adapters/formation.adapter', () => ({ getFormationProvider: () => mockProvider }));

import { handleFormationPaid, handleFormationProviderWebhook } from './formation.webhook.controller';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

const session = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'cs_1',
    payment_intent: 'pi_1',
    metadata: { kind: 'formation', formationOrderId: 'fo1' },
    ...overrides,
  }) as unknown as Stripe.Checkout.Session;

const order = {
  id: 'fo1',
  companyName: 'Jade Studio LLC',
  state: 'DE',
  founderName: 'Jade Williamson',
  founderEmail: 'jade@example.com',
  mailingAddress: { line1: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mockPrisma.formationOrder.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.formationOrder.findUnique.mockResolvedValue(order);
  mockProvider.submitFormation.mockResolvedValue({ providerOrderId: 'mock_1' });
  mockStripe.refunds.create.mockResolvedValue({ id: 're_1' });
});

describe('handleFormationPaid', () => {
  it('does nothing when the session has no formationOrderId', async () => {
    await handleFormationPaid(session({ metadata: { kind: 'formation' } }));
    expect(mockPrisma.formationOrder.updateMany).not.toHaveBeenCalled();
  });

  it('is a no-op on a Stripe redelivery (the atomic claim updates 0 rows)', async () => {
    mockPrisma.formationOrder.updateMany.mockResolvedValue({ count: 0 });
    await handleFormationPaid(session());
    expect(mockProvider.submitFormation).not.toHaveBeenCalled();
    expect(mockPrisma.formationOrder.update).not.toHaveBeenCalled();
  });

  it('claims PENDING_PAYMENT -> PAID atomically, submits, and records SUBMITTED', async () => {
    await handleFormationPaid(session());
    expect(mockPrisma.formationOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'fo1', status: 'PENDING_PAYMENT' },
      data: { status: 'PAID', stripePaymentIntentId: 'pi_1' },
    });
    expect(mockProvider.submitFormation).toHaveBeenCalledWith({
      companyName: 'Jade Studio LLC',
      state: 'DE',
      founderName: 'Jade Williamson',
      founderEmail: 'jade@example.com',
      mailingAddress: { line1: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' },
    });
    expect(mockPrisma.formationOrder.update).toHaveBeenCalledWith({
      where: { id: 'fo1' },
      data: { providerOrderId: 'mock_1', status: 'SUBMITTED' },
    });
    expect(mockStripe.refunds.create).not.toHaveBeenCalled();
  });

  it('accepts an expanded payment_intent object', async () => {
    await handleFormationPaid(session({ payment_intent: { id: 'pi_obj' } }));
    expect(mockPrisma.formationOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'fo1', status: 'PENDING_PAYMENT' },
      data: { status: 'PAID', stripePaymentIntentId: 'pi_obj' },
    });
  });

  it('marks FAILED, refunds through Stripe, then marks REFUNDED when submission fails', async () => {
    mockProvider.submitFormation.mockRejectedValue(new Error('provider exploded'));
    await handleFormationPaid(session());
    expect(mockPrisma.formationOrder.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'fo1' },
      data: { status: 'FAILED', failureReason: 'submission_failed' },
    });
    expect(mockStripe.refunds.create).toHaveBeenCalledWith({ payment_intent: 'pi_1' });
    expect(mockPrisma.formationOrder.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'fo1' },
      data: { status: 'REFUNDED' },
    });
  });

  it('leaves the order FAILED with refund_failed noted if the refund itself fails', async () => {
    mockProvider.submitFormation.mockRejectedValue(new Error('provider exploded'));
    mockStripe.refunds.create.mockRejectedValue(new Error('stripe down'));
    await handleFormationPaid(session());
    expect(mockPrisma.formationOrder.update).toHaveBeenLastCalledWith({
      where: { id: 'fo1' },
      data: { failureReason: 'submission_failed; refund_failed' },
    });
    expect(mockPrisma.formationOrder.update).not.toHaveBeenCalledWith({ where: { id: 'fo1' }, data: { status: 'REFUNDED' } });
  });

  it('marks FAILED without attempting a refund when there is no payment intent', async () => {
    mockProvider.submitFormation.mockRejectedValue(new Error('provider exploded'));
    await handleFormationPaid(session({ payment_intent: null }));
    expect(mockPrisma.formationOrder.update).toHaveBeenCalledWith({
      where: { id: 'fo1' },
      data: { status: 'FAILED', failureReason: 'submission_failed' },
    });
    expect(mockStripe.refunds.create).not.toHaveBeenCalled();
  });
});

describe('handleFormationProviderWebhook', () => {
  const req = { body: Buffer.from('{}'), headers: {} } as unknown as Request;

  it('returns 400 invalid_signature when the provider rejects the signature', async () => {
    mockProvider.parseStatusWebhook.mockImplementation(() => {
      throw new Error('Invalid signature');
    });
    const res = mockRes();
    await handleFormationProviderWebhook(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'invalid_signature' });
  });

  it('acknowledges an event the provider chose to ignore', async () => {
    mockProvider.parseStatusWebhook.mockReturnValue(null);
    const res = mockRes();
    await handleFormationProviderWebhook(req, res);
    expect(res.json).toHaveBeenCalledWith({ received: true });
    expect(mockPrisma.formationOrder.findUnique).not.toHaveBeenCalled();
  });

  it('returns 200 and changes nothing for an unknown providerOrderId', async () => {
    mockProvider.parseStatusWebhook.mockReturnValue({ providerOrderId: 'nope', status: 'FILED' });
    mockPrisma.formationOrder.findUnique.mockResolvedValue(null);
    const res = mockRes();
    await handleFormationProviderWebhook(req, res);
    expect(mockPrisma.formationOrder.update).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  it('advances SUBMITTED -> FILED', async () => {
    mockProvider.parseStatusWebhook.mockReturnValue({ providerOrderId: 'mock_1', status: 'FILED' });
    mockPrisma.formationOrder.findUnique.mockResolvedValue({ id: 'fo1', status: 'SUBMITTED' });
    await handleFormationProviderWebhook(req, mockRes());
    expect(mockPrisma.formationOrder.update).toHaveBeenCalledWith({ where: { id: 'fo1' }, data: { status: 'FILED' } });
  });

  it('advances to COMPLETED and stores the EIN and registered-agent flag', async () => {
    mockProvider.parseStatusWebhook.mockReturnValue({
      providerOrderId: 'mock_1',
      status: 'COMPLETED',
      ein: '12-3456789',
      registeredAgentAssigned: true,
    });
    mockPrisma.formationOrder.findUnique.mockResolvedValue({ id: 'fo1', status: 'FILED' });
    await handleFormationProviderWebhook(req, mockRes());
    expect(mockPrisma.formationOrder.update).toHaveBeenCalledWith({
      where: { id: 'fo1' },
      data: { status: 'COMPLETED', ein: '12-3456789', registeredAgentAssigned: true },
    });
  });

  it('never regresses status: a late FILED after COMPLETED changes nothing', async () => {
    mockProvider.parseStatusWebhook.mockReturnValue({ providerOrderId: 'mock_1', status: 'FILED' });
    mockPrisma.formationOrder.findUnique.mockResolvedValue({ id: 'fo1', status: 'COMPLETED' });
    await handleFormationProviderWebhook(req, mockRes());
    expect(mockPrisma.formationOrder.update).not.toHaveBeenCalled();
  });

  it('stores the registered-agent flag from an event that carries no status', async () => {
    mockProvider.parseStatusWebhook.mockReturnValue({ providerOrderId: 'mock_1', registeredAgentAssigned: true });
    mockPrisma.formationOrder.findUnique.mockResolvedValue({ id: 'fo1', status: 'FILED' });
    await handleFormationProviderWebhook(req, mockRes());
    expect(mockPrisma.formationOrder.update).toHaveBeenCalledWith({ where: { id: 'fo1' }, data: { registeredAgentAssigned: true } });
  });

  it.each(['SUBMITTED', 'FILED'])('applies a provider FAILED event while the order is %s (no refund)', async (status) => {
    mockProvider.parseStatusWebhook.mockReturnValue({ providerOrderId: 'mock_1', status: 'FAILED', failureReason: 'name_rejected' });
    mockPrisma.formationOrder.findUnique.mockResolvedValue({ id: 'fo1', status });
    await handleFormationProviderWebhook(req, mockRes());
    expect(mockPrisma.formationOrder.update).toHaveBeenCalledWith({
      where: { id: 'fo1' },
      data: { status: 'FAILED', failureReason: 'name_rejected' },
    });
    expect(mockStripe.refunds.create).not.toHaveBeenCalled();
  });

  it.each(['COMPLETED', 'FAILED', 'REFUNDED'])('ignores a provider FAILED event once the order is %s', async (status) => {
    mockProvider.parseStatusWebhook.mockReturnValue({ providerOrderId: 'mock_1', status: 'FAILED' });
    mockPrisma.formationOrder.findUnique.mockResolvedValue({ id: 'fo1', status });
    await handleFormationProviderWebhook(req, mockRes());
    expect(mockPrisma.formationOrder.update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Write the failing Stripe-branch tests**

Create `src/routes/webhooks.formation.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const mockPrisma = vi.hoisted(() => ({
  order: { findUnique: vi.fn(), update: vi.fn() },
  fulfillmentOrder: { create: vi.fn() },
}));
const mockStripeClient = vi.hoisted(() => ({ webhooks: { constructEvent: vi.fn() } }));
const mockHandleFormationPaid = vi.hoisted(() => vi.fn());

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
vi.mock('../lib/stripe', () => ({ getStripe: () => mockStripeClient }));
vi.mock('../lib/crypto', () => ({ decrypt: (v: string) => v }));
vi.mock('../adapters/printful.adapter', () => ({ createOrder: vi.fn() }));
vi.mock('../controllers/formation.webhook.controller', () => ({
  handleFormationPaid: mockHandleFormationPaid,
  handleFormationProviderWebhook: vi.fn(),
}));

import { handleStripeWebhook } from './webhooks.routes';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

const req = { headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
});

describe('handleStripeWebhook — formation branch', () => {
  it('routes a formation session to handleFormationPaid and skips the storefront order path', async () => {
    const session = { id: 'cs_f', metadata: { kind: 'formation', formationOrderId: 'fo1' } };
    mockStripeClient.webhooks.constructEvent.mockReturnValue({ type: 'checkout.session.completed', data: { object: session } });
    const res = mockRes();
    await handleStripeWebhook(req, res);
    expect(mockHandleFormationPaid).toHaveBeenCalledWith(session);
    expect(mockPrisma.order.findUnique).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  it('leaves storefront sessions on the existing order path', async () => {
    mockStripeClient.webhooks.constructEvent.mockReturnValue({ type: 'checkout.session.completed', data: { object: { id: 'cs_s' } } });
    mockPrisma.order.findUnique.mockResolvedValue({ id: 'o1', stripeSessionId: 'cs_s' });
    const res = mockRes();
    await handleStripeWebhook(req, res);
    expect(mockHandleFormationPaid).not.toHaveBeenCalled();
    expect(mockPrisma.order.update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: { paymentStatus: 'PAID' } });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- formation.webhook webhooks.formation`
Expected: FAIL — `Cannot find module './formation.webhook.controller'`.

- [ ] **Step 4: Implement the webhook controller**

Create `src/controllers/formation.webhook.controller.ts`:
```ts
import { Request, Response } from 'express';
import Stripe from 'stripe';
import { prisma } from '../lib/prisma';
import { getStripe } from '../lib/stripe';
import { getFormationProvider } from '../adapters/formation.adapter';

// Forward-only ordering for provider-reported progress. A status missing from
// this map (FAILED, REFUNDED) is terminal here and never overwritten by a
// FILED/COMPLETED event.
const STATUS_RANK: Partial<Record<string, number>> = {
  PENDING_PAYMENT: 0,
  PAID: 1,
  SUBMITTED: 2,
  FILED: 3,
  COMPLETED: 4,
};

async function failAndRefund(orderId: string, paymentIntentId: string | null, reason: string) {
  await prisma.formationOrder.update({ where: { id: orderId }, data: { status: 'FAILED', failureReason: reason } });
  if (!paymentIntentId) return;

  try {
    await getStripe().refunds.create({ payment_intent: paymentIntentId });
    await prisma.formationOrder.update({ where: { id: orderId }, data: { status: 'REFUNDED' } });
  } catch (err) {
    console.error(`Formation order ${orderId}: refund failed`, err);
    await prisma.formationOrder.update({ where: { id: orderId }, data: { failureReason: `${reason}; refund_failed` } });
  }
}

export async function handleFormationPaid(session: Stripe.Checkout.Session): Promise<void> {
  const orderId = session.metadata?.formationOrderId;
  if (!orderId) return;

  const paymentIntentId =
    typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent?.id ?? null);

  // Atomic claim: only the first delivery moves PENDING_PAYMENT -> PAID. A
  // Stripe redelivery updates 0 rows and must not submit a second filing.
  const claimed = await prisma.formationOrder.updateMany({
    where: { id: orderId, status: 'PENDING_PAYMENT' },
    data: { status: 'PAID', stripePaymentIntentId: paymentIntentId },
  });
  if (claimed.count === 0) return;

  try {
    const order = await prisma.formationOrder.findUnique({ where: { id: orderId } });
    if (!order) throw new Error('order vanished after claim');

    const { providerOrderId } = await getFormationProvider().submitFormation({
      companyName: order.companyName,
      state: order.state,
      founderName: order.founderName,
      founderEmail: order.founderEmail,
      mailingAddress: order.mailingAddress as {
        line1: string;
        line2?: string;
        city: string;
        state: string;
        zip: string;
      },
    });
    await prisma.formationOrder.update({ where: { id: orderId }, data: { providerOrderId, status: 'SUBMITTED' } });
  } catch (err) {
    // Provider internals never reach the creator or the DB -- only a generic
    // reason. The Stripe response is unaffected: the payment already succeeded.
    console.error(`Formation order ${orderId}: submission failed`, err);
    await failAndRefund(orderId, paymentIntentId, 'submission_failed');
  }
}

export async function handleFormationProviderWebhook(req: Request, res: Response) {
  let event;
  try {
    event = getFormationProvider().parseStatusWebhook(req.body, req.headers);
  } catch {
    return res.status(400).json({ error: 'invalid_signature' });
  }
  if (!event) return res.json({ received: true });

  const order = await prisma.formationOrder.findUnique({ where: { providerOrderId: event.providerOrderId } });
  if (!order) return res.json({ received: true });

  const data: {
    status?: 'FILED' | 'COMPLETED' | 'FAILED';
    ein?: string;
    registeredAgentAssigned?: boolean;
    failureReason?: string;
  } = {};

  if (event.ein) data.ein = event.ein;
  if (event.registeredAgentAssigned) data.registeredAgentAssigned = true;

  if (event.status === 'FILED' || event.status === 'COMPLETED') {
    const current = STATUS_RANK[order.status];
    if (current !== undefined && (STATUS_RANK[event.status] as number) > current) {
      data.status = event.status;
    }
  } else if (event.status === 'FAILED') {
    if (order.status === 'SUBMITTED' || order.status === 'FILED') {
      // Needs human judgment, so no auto-refund: log it and surface it to the
      // creator as "we'll contact you".
      console.error(`Formation order ${order.id}: provider reported failure (${event.failureReason ?? 'unspecified'})`);
      data.status = 'FAILED';
      data.failureReason = event.failureReason ?? 'provider_failed';
    }
  }

  if (Object.keys(data).length > 0) {
    await prisma.formationOrder.update({ where: { id: order.id }, data });
  }
  return res.json({ received: true });
}
```

- [ ] **Step 5: Wire the Stripe branch and the provider route in `webhooks.routes.ts`**

Add the imports at the top of `src/routes/webhooks.routes.ts` (below the existing imports):
```ts
import { asyncHandler } from '../middleware/asyncHandler';
import { handleFormationPaid, handleFormationProviderWebhook } from '../controllers/formation.webhook.controller';
```

Replace the `checkout.session.completed` block in `handleStripeWebhook`:
```ts
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const shippingAddress = extractShippingAddress(session);
```
with:
```ts
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;

    // Formation payments carry metadata.kind === 'formation' (set in
    // formation.controller.ts); everything else is a storefront order.
    if (session.metadata?.kind === 'formation') {
      await handleFormationPaid(session);
      return res.json({ received: true });
    }

    const shippingAddress = extractShippingAddress(session);
```

Replace the router registration at the bottom:
```ts
const router = Router();
router.post('/stripe', handleStripeWebhook);
```
with:
```ts
// Both wrapped so a Prisma/Stripe rejection reaches the global error handler
// instead of crashing the process (see asyncHandler.ts). The /webhooks mount
// in index.ts already applies express.raw, which both handlers need.
const router = Router();
router.post('/stripe', asyncHandler(handleStripeWebhook));
router.post('/formation', asyncHandler(handleFormationProviderWebhook));
```

- [ ] **Step 6: Run the new tests, then the whole suite**

Run: `npm test -- formation.webhook webhooks.formation webhooks.routes`
Expected: PASS — including the pre-existing `webhooks.routes.test.ts` suite, unchanged.

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 7: Run the build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/controllers/formation.webhook.controller.ts src/controllers/formation.webhook.controller.test.ts src/routes/webhooks.routes.ts src/routes/webhooks.formation.test.ts
git commit -m "Add formation Stripe branch and provider status webhook"
```

---

## Task 6: Frontend — "Company" workspace tab

**Repo:** `kazii-frontend` (separate repo; committed directly to its `main`, as with every prior frontend change — do **not** push until Task 7 says so).

**Files:**
- Modify: `kazii-full-demo.html`

**Interfaces:**
- Consumes: `GET /formation/orders`, `GET /formation/quote?state=`, `POST /formation/checkout` (Task 4), the existing `API_BASE_URL`, `toast()`, `goTo()`, `appSetTab()`, `authSetMode()`, and the app IIFE's `renderAll()`.
- Produces: `renderCompany()` (called from `renderAll()`), plus four functions referenced from inline HTML attributes — `formationFormChanged`, `loadFormationQuote`, `startFormationCheckout`, `refreshFormationOrders` — each of which MUST be exposed on `window` (Steps 8–11).

No test runner exists for this file. Verification is a syntax parse in this task and a live browser check in Task 7.

Anchors in the current file (verify with a search before editing — line numbers drift): the app screen's sidebar `<nav>` (contains `data-tab="analytics"`), the `id="tab-analytics"` panel followed by the closing `</div>` of `.content-area`, the Inventory screen's second sidebar `<nav>` (buttons using `goTo('app'); appSetTab(...)`), the app IIFE (contains `function renderAll(){` and the `window.appSetTab = appSetTab;` block), and the init lines at the very bottom (`authSetMode('signin'); const _pathSlug = ...`).

- [ ] **Step 1: Add the sidebar button in the app screen**

In the `#screen-app` sidebar `<nav>`, add directly after the Analytics button:
```html
    <button data-tab="company" onclick="appSetTab('company')"><span class="ic">◈</span> Company</button>
```

- [ ] **Step 2: Add the sidebar button in the Inventory screen's nav**

In the second sidebar `<nav>` (the one whose buttons call `goTo('app'); appSetTab('...')`), add directly after the Analytics button:
```html
    <button onclick="goTo('app'); appSetTab('company')"><span class="ic">◈</span> Company</button>
```

- [ ] **Step 3: Add the tab panel**

Directly after the closing `</div></div>` of `#tab-analytics` (and before the `</div>` that closes `.content-area`), add:
```html
  <!-- COMPANY -->
  <div class="tabpanel" id="tab-company"><div class="page">
    <div class="topbar"><div><h1>Company</h1><p>Form your LLC without leaving Kazii+ — we handle the filing, EIN, and registered agent.</p></div></div>
    <div id="companyBody"></div>
  </div></div>
```

- [ ] **Step 4: Add state, helpers, and data fetching to the app IIFE**

Inside the app IIFE, directly above the `function renderAll(){` line, add:
```js
  /* ---------- COMPANY (LLC formation) ---------- */
  const FORMATION_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];
  const FORMATION_STEPS = ['PAID','SUBMITTED','FILED','COMPLETED'];
  const FORMATION_STEP_LABELS = { PAID:'Paid', SUBMITTED:'Submitted', FILED:'Filed with the state', COMPLETED:'Completed' };
  const FORMATION_INPUT_STYLE = 'width:100%; box-sizing:border-box; background:var(--panel-2); border:1px solid var(--line); border-radius:8px; color:var(--text); padding:11px 12px; font-size:13px;';
  let formationOrders = null;       // null = not loaded yet, otherwise an array
  let formationUnavailable = false; // true once the API answers 503
  let formationQuote = null;        // { stateFeeCents, serviceFeeCents, totalCents } | null
  let formationBusy = false;

  // Company names and emails are user-supplied and rendered via innerHTML.
  function formationEsc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function formationUsd(cents){
    return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  async function fetchFormationOrders(){
    const token = localStorage.getItem('kaziiToken');
    try {
      const res = await fetch(`${API_BASE_URL}/formation/orders`, { headers: { 'Authorization': `Bearer ${token}` } });
      if(res.status === 503){ formationUnavailable = true; formationOrders = []; return; }
      const data = await res.json().catch(() => ({}));
      formationOrders = res.ok ? (data.orders || []) : [];
    } catch(e){
      formationOrders = [];
    }
  }
```

- [ ] **Step 5: Add the rendering functions**

Directly below the block from Step 4 (still above `function renderAll(){`), add:
```js
  function renderCompanyOrders(){
    const el = document.getElementById('companyOrders');
    if(!el) return;
    if(!formationOrders || !formationOrders.length){ el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="panel-box" style="padding:20px 24px; margin-bottom:20px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
          <h2 style="margin:0;">Your filings</h2>
          <button class="mono" style="font-size:11px; color:var(--text-soft); background:none; border:none; cursor:pointer;" onclick="refreshFormationOrders()">↻ Refresh status</button>
        </div>
        ${formationOrders.map(o => {
          const idx = FORMATION_STEPS.indexOf(o.status);
          let detail;
          if(o.status === 'REFUNDED'){
            detail = `<div style="color:var(--text-soft); font-size:13px;">This filing couldn’t be submitted, so your payment was refunded.</div>`;
          } else if(o.status === 'FAILED'){
            detail = `<div style="color:var(--rust); font-size:13px;">Something went wrong with this filing. We’ll contact you at ${formationEsc(o.founderEmail)}.</div>`;
          } else {
            detail = `<div style="display:flex; gap:18px; flex-wrap:wrap; font-size:13px;">${FORMATION_STEPS.map((s,i) =>
              `<span style="color:${i <= idx ? 'var(--green)' : 'var(--text-soft)'};">${i <= idx ? '●' : '○'} ${FORMATION_STEP_LABELS[s]}</span>`).join('')}</div>`;
          }
          const extras = [
            o.ein ? `EIN: <span class="mono">${formationEsc(o.ein)}</span>` : '',
            o.registeredAgentAssigned ? 'Registered agent assigned' : '',
          ].filter(Boolean).join(' · ');
          return `
            <div style="padding:14px 0; border-top:1px solid var(--line);">
              <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                <div style="font-weight:600;">${formationEsc(o.companyName)} <span class="mono" style="color:var(--text-soft); font-weight:400;">· ${formationEsc(o.state)}</span></div>
                <div class="mono" style="color:var(--text-soft); font-size:12px;">${formationUsd(o.totalCents)} · ${new Date(o.createdAt).toLocaleDateString()}</div>
              </div>
              ${detail}
              ${extras ? `<div style="margin-top:8px; font-size:12px; color:var(--text-soft);">${extras}</div>` : ''}
            </div>`;
        }).join('')}
      </div>`;
  }

  function renderFormationQuote(){
    const el = document.getElementById('fcQuote');
    if(!el) return;
    if(!formationQuote){
      el.innerHTML = `<div style="color:var(--text-soft); font-size:13px;">Choose a state to see your price.</div>`;
      return;
    }
    const row = (label, cents, bold) => `<div style="display:flex; justify-content:space-between; padding:6px 0; font-size:13px; ${bold ? 'border-top:1px solid var(--line); margin-top:6px; font-weight:600;' : ''}"><span>${label}</span><span class="mono">${formationUsd(cents)}</span></div>`;
    el.innerHTML = row('State filing fee', formationQuote.stateFeeCents) + row('Kazii+ service fee', formationQuote.serviceFeeCents) + row('Total', formationQuote.totalCents, true);
  }

  function renderCompany(){
    const body = document.getElementById('companyBody');
    if(!body) return;

    if(!localStorage.getItem('kaziiToken')){
      body.innerHTML = `
        <div class="panel-box" style="padding:28px;">
          <h2 style="margin:0 0 8px;">Turn your brand into a real company</h2>
          <p style="color:var(--text-soft); font-size:14px; line-height:1.6; margin:0 0 18px;">Form a US LLC, get your EIN, and a registered agent — all without leaving Kazii+. Create a free account to get started.</p>
          <button style="padding:12px 20px; border-radius:10px; border:none; background:var(--tag); color:#171308; font-weight:600; cursor:pointer;" onclick="goTo('auth'); authSetMode('signup');">Create an account →</button>
        </div>`;
      return;
    }

    if(formationOrders === null){
      body.innerHTML = `<div class="mono" style="color:var(--text-soft); padding:16px;">Loading…</div>`;
      fetchFormationOrders().then(renderCompany);
      return;
    }

    if(formationUnavailable){
      body.innerHTML = `
        <div class="panel-box" style="padding:28px;">
          <h2 style="margin:0 0 8px;">Coming soon</h2>
          <p style="color:var(--text-soft); font-size:14px; line-height:1.6; margin:0;">Company formation is on its way. We’ll let you know as soon as you can form your LLC from here.</p>
        </div>`;
      return;
    }

    const stateOptions = `<option value="">Select…</option>` + FORMATION_STATES.map(s => `<option value="${s}">${s}</option>`).join('');
    const label = t => `<label style="display:block; font-size:11.5px; color:var(--text-soft); margin-bottom:6px;">${t}</label>`;
    body.innerHTML = `
      <div id="companyOrders"></div>
      <div class="panel-box" style="padding:24px;">
        <h2 style="margin:0 0 6px;">Form a new LLC</h2>
        <p style="color:var(--text-soft); font-size:13px; margin:0 0 20px;">US-resident founders only.</p>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:14px;">
          <div>${label('Company name (must end in LLC)')}<input id="fcName" style="${FORMATION_INPUT_STYLE}" oninput="formationFormChanged()" placeholder="Jade Studio LLC"></div>
          <div>${label('State of formation')}<select id="fcState" style="${FORMATION_INPUT_STYLE}" onchange="loadFormationQuote()">${stateOptions}</select></div>
          <div>${label('Founder legal name')}<input id="fcFounder" style="${FORMATION_INPUT_STYLE}" oninput="formationFormChanged()"></div>
          <div>${label('Founder email')}<input id="fcEmail" type="email" style="${FORMATION_INPUT_STYLE}" oninput="formationFormChanged()"></div>
          <div>${label('Mailing address')}<input id="fcLine1" style="${FORMATION_INPUT_STYLE}" oninput="formationFormChanged()"></div>
          <div>${label('Apt / suite (optional)')}<input id="fcLine2" style="${FORMATION_INPUT_STYLE}" oninput="formationFormChanged()"></div>
          <div>${label('City')}<input id="fcCity" style="${FORMATION_INPUT_STYLE}" oninput="formationFormChanged()"></div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px;">
            <div>${label('State')}<select id="fcAddrState" style="${FORMATION_INPUT_STYLE}" onchange="formationFormChanged()">${stateOptions}</select></div>
            <div>${label('ZIP')}<input id="fcZip" style="${FORMATION_INPUT_STYLE}" oninput="formationFormChanged()" placeholder="78701"></div>
          </div>
        </div>
        <div id="fcQuote" style="margin:18px 0; padding:14px 16px; background:var(--panel-2); border:1px solid var(--line); border-radius:10px;"></div>
        <label style="display:flex; gap:10px; align-items:flex-start; font-size:13px; line-height:1.5; margin-bottom:18px; cursor:pointer;">
          <input id="fcAck" type="checkbox" onchange="formationFormChanged()" style="margin-top:3px;">
          <span>I understand Kazii+ is not a law firm, and this is not legal or tax advice.</span>
        </label>
        <button id="fcPay" disabled onclick="startFormationCheckout()" style="width:100%; padding:13px; border-radius:10px; border:none; background:var(--tag); color:#171308; font-weight:600; cursor:pointer; opacity:0.5;">Pay &amp; form my LLC</button>
      </div>`;
    renderCompanyOrders();
    renderFormationQuote();
  }
```

- [ ] **Step 6: Add the four onclick/onchange-bound functions**

Directly below the block from Step 5 (still above `function renderAll(){`), add:
```js
  function formationFormValues(){
    const v = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    return {
      companyName: v('fcName'), state: v('fcState'), founderName: v('fcFounder'), founderEmail: v('fcEmail'),
      mailingAddress: { line1: v('fcLine1'), line2: v('fcLine2') || undefined, city: v('fcCity'), state: v('fcAddrState'), zip: v('fcZip') },
      acknowledged: !!(document.getElementById('fcAck') && document.getElementById('fcAck').checked),
    };
  }

  function formationFormChanged(){
    const btn = document.getElementById('fcPay');
    if(!btn) return;
    const f = formationFormValues();
    const complete = f.companyName && f.state && f.founderName && f.founderEmail && f.mailingAddress.line1 &&
      f.mailingAddress.city && f.mailingAddress.state && f.mailingAddress.zip && f.acknowledged && formationQuote;
    btn.disabled = !complete || formationBusy;
    btn.style.opacity = btn.disabled ? '0.5' : '1';
  }

  async function loadFormationQuote(){
    const state = document.getElementById('fcState').value;
    if(!state){ formationQuote = null; renderFormationQuote(); formationFormChanged(); return; }
    const token = localStorage.getItem('kaziiToken');
    try {
      const res = await fetch(`${API_BASE_URL}/formation/quote?state=${encodeURIComponent(state)}`, { headers: { 'Authorization': `Bearer ${token}` } });
      formationQuote = res.ok ? await res.json() : null;
      if(!res.ok) toast('Couldn’t load a price for that state — try again in a moment.');
    } catch(e){
      formationQuote = null;
      toast('Can’t reach the server — try again in a moment.');
    }
    renderFormationQuote();
    formationFormChanged();
  }

  async function startFormationCheckout(){
    const token = localStorage.getItem('kaziiToken');
    if(!token){ toast('Sign up to form your company'); goTo('auth'); authSetMode('signup'); return; }
    formationBusy = true;
    formationFormChanged();
    try {
      const res = await fetch(`${API_BASE_URL}/formation/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(formationFormValues())
      });
      const data = await res.json().catch(() => ({}));
      if(res.ok && data.url){ window.location.href = data.url; return; }
      if(res.status === 400) toast('Please check the form — every field is required and the company name must end in LLC.');
      else if(res.status === 503) toast('Company formation isn’t available right now.');
      else toast('Something went wrong — please try again.');
    } catch(e){
      toast('Can’t reach the server — try again in a moment.');
    }
    formationBusy = false;
    formationFormChanged();
  }

  async function refreshFormationOrders(){
    await fetchFormationOrders();
    renderCompanyOrders();
  }
```

- [ ] **Step 7: Call `renderCompany()` from `renderAll()`**

Change the `renderAll` body from:
```js
    renderOverview(); renderProducts(); renderOrders(); renderStorefront(); renderSocialFeed(); renderSuppliers(); renderFulfillmentGrid(); renderAnalytics();
```
to:
```js
    renderOverview(); renderProducts(); renderOrders(); renderStorefront(); renderSocialFeed(); renderSuppliers(); renderFulfillmentGrid(); renderAnalytics(); renderCompany();
```

- [ ] **Step 8: Expose `formationFormChanged` on `window` — REQUIRED, do not skip**

In the app IIFE's `window.X = X` block (it starts at `window.appSetTab = appSetTab;`), add:
```js
  window.formationFormChanged = formationFormChanged;
```

- [ ] **Step 9: Expose `loadFormationQuote` on `window` — REQUIRED, do not skip**

In the same block, add:
```js
  window.loadFormationQuote = loadFormationQuote;
```

- [ ] **Step 10: Expose `startFormationCheckout` on `window` — REQUIRED, do not skip**

In the same block, add:
```js
  window.startFormationCheckout = startFormationCheckout;
```

- [ ] **Step 11: Expose `refreshFormationOrders` on `window` — REQUIRED, do not skip**

In the same block, add:
```js
  window.refreshFormationOrders = refreshFormationOrders;
```

**Why Steps 8–11 are four separate checklist items:** the app code lives inside an IIFE, but the inline `oninput`/`onchange`/`onclick` attributes above run in global scope. A function that isn't on `window` throws `ReferenceError: ... is not defined` the first time a creator touches the form. This exact mistake has broken this project's Publish button and Builder inputs before. After Step 11, open the file and confirm all four names literally appear in the exposure block — do not assume.

- [ ] **Step 12: Route the Stripe return to the Company tab**

Replace the init lines at the very bottom of the file:
```js
authSetMode('signin');
const _pathSlug = window.location.pathname.replace(/^\/+|\/+$/g, '');
if(_pathSlug){
  loadRealStorefront(_pathSlug);
} else {
  goTo('site');
}
```
with:
```js
authSetMode('signin');
const _pathSlug = window.location.pathname.replace(/^\/+|\/+$/g, '');
const _formationReturn = new URLSearchParams(window.location.search).get('formation');
if(_pathSlug){
  loadRealStorefront(_pathSlug);
} else if(_formationReturn && localStorage.getItem('kaziiToken')){
  goTo('app');
  appSetTab('company');
  toast(_formationReturn === 'success' ? 'Payment received — your filing is on its way.' : 'Payment cancelled — you were not charged.');
  history.replaceState(null, '', window.location.pathname);
} else {
  goTo('site');
}
```

- [ ] **Step 13: Syntax check and exposure check**

Run (from `kazii-frontend/`):
```bash
node -e "const fs=require('fs');const h=fs.readFileSync('kazii-full-demo.html','utf8');const m=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)];m.forEach(x=>{new Function(x[1]);});console.log('inline script blocks parsed OK:',m.length)"
```
Expected: prints `inline script blocks parsed OK: <n>` with no SyntaxError.

Then confirm the four exposures literally exist:
```bash
grep -n "window.formationFormChanged\|window.loadFormationQuote\|window.startFormationCheckout\|window.refreshFormationOrders" kazii-full-demo.html
```
Expected: exactly four matching lines.

- [ ] **Step 14: Commit (do not push)**

```bash
git add kazii-full-demo.html
git commit -m "Add Company tab for embedded LLC formation"
```

---

## Task 7: Deploy and verify against production

**Files:** None in the codebase except a README edit (Step 1) — this task runs configuration and verification commands. Scratch scripts live in the session scratchpad, never in the repo, and are deleted afterward.

**Interfaces:** Exercises Tasks 1–6 end to end against the real Railway backend, the real Postgres, and **real Stripe test-mode** checkout. Replicate's model-slug bug was only caught by live verification because unit tests mock the world; this task is the equivalent gate here, so it must use a real Stripe test checkout, not just mocks.

- [ ] **Step 1: Update the backend README**

In `README.md`, in the "Not yet real" section add a bullet after the "Social media connection" bullet:
```
- **Company formation** — built behind `FORMATION_ENABLED` (off) with a
  mock provider; the real provider (doola) needs a partnership agreement
  before its adapter can be written. See
  `docs/superpowers/specs/2026-09-25-company-formation-design.md`.
```
And extend the environment-variables paragraph so it ends: `... `REPLICATE_API_TOKEN`, `NODE_ENV`, `FRONTEND_URL`, and (company formation) `FORMATION_ENABLED`, `FORMATION_PROVIDER`, `FORMATION_MARKUP_CENTS`, `FORMATION_WEBHOOK_SECRET`.`

Commit: `git add README.md && git commit -m "Document company formation in the README"`

- [ ] **Step 2: Confirm the production Stripe key is TEST mode — before anything else**

Print only the key's prefix, never the key:
```bash
railway variables --service kazii-backend --kv | grep '^STRIPE_SECRET_KEY=' | cut -c1-26
```
Expected: `STRIPE_SECRET_KEY=sk_test_`. If it prints `STRIPE_SECRET_KEY=sk_live_`, **STOP**: the mock provider must not be enabled against a live key (the guard would refuse anyway). Report to the user and do not continue.

- [ ] **Step 3: Push the backend and confirm the deploy**

```bash
git push origin main
```
Poll `mcp__railway__list-deployments` (service `kazii-backend`, id `3dc2f631-5be2-49c1-b90c-f6cb99a77bcd`, project `02028e4f-30ee-4e52-9bfd-db6b8c24992f`) until the newest deployment's `commitHash` matches the pushed HEAD and its status is `SUCCESS`. The migration already ran in Task 1, so the deploy log should say `No pending migrations to apply.`

- [ ] **Step 4: Verify the feature-off state (flag unset)**

Sign up a throwaway test creator and save its token:
```bash
curl -sS -X POST https://api.kaziiplus.com/auth/signup -H "Content-Type: application/json" \
  -d '{"email":"formation-verify@kaziiplus.com","password":"password123","accountType":"CREATOR","firstName":"FormationVerify"}'
```
Then, with `TOKEN` set to the returned token:
```bash
curl -sS -o /dev/null -w "quote: HTTP %{http_code}\n" "https://api.kaziiplus.com/formation/quote?state=DE" -H "Authorization: Bearer $TOKEN"
curl -sS -o /dev/null -w "orders: HTTP %{http_code}\n" https://api.kaziiplus.com/formation/orders -H "Authorization: Bearer $TOKEN"
```
Expected: both `HTTP 503`. Unauthenticated `GET /formation/orders` must return `401`.

- [ ] **Step 5: Push the frontend and confirm it is live**

```bash
cd ../kazii-frontend && git push origin main
until curl -s https://www.kaziiplus.com/ | grep -q "formationFormChanged"; do sleep 5; done; echo "FRONTEND LIVE"
```

- [ ] **Step 6: Verify the "Coming soon" UI state**

Create `verify_company_ui.mjs` in the session scratchpad (never in the repo). It drives headless Chrome over the DevTools protocol, the same approach as the project's earlier `shot.mjs`:

```js
// usage: node verify_company_ui.mjs <token> <off|form|orders>
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [,, token, mode] = process.argv;
const port = 9400 + Math.floor(Math.random() * 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, '--window-size=1400,1400',
  '--user-data-dir=' + process.env.TEMP + '\\chrome-verify-' + port, 'https://www.kaziiplus.com/',
], { stdio: 'ignore' });

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((p) => p.type === 'page');
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error('debugger did not come up');
}

let msgId = 1;
function send(ws, method, params = {}) {
  return new Promise((resolve) => {
    const id = msgId++;
    const handler = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.id === id) { ws.removeEventListener('message', handler); resolve(data.result); }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const run = async (ws, expression) =>
  (await send(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;

let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++; };

try {
  const page = await findPage();
  const ws = await new Promise((resolve, reject) => {
    const s = new WebSocket(page.webSocketDebuggerUrl);
    s.addEventListener('open', () => resolve(s));
    s.addEventListener('error', reject);
  });
  await send(ws, 'Page.enable');
  await sleep(3000);
  await run(ws, `localStorage.setItem('kaziiToken', ${JSON.stringify(token)}); localStorage.setItem('kaziiUser', JSON.stringify({accountType:'CREATOR'})); location.reload();`);
  await sleep(4000);
  await run(ws, `goTo('app'); appSetTab('company');`);
  await sleep(3000);

  for (const fn of ['formationFormChanged', 'loadFormationQuote', 'startFormationCheckout', 'refreshFormationOrders']) {
    check(`window.${fn} is a function`, (await run(ws, `typeof window.${fn}`)) === 'function');
  }
  const text = await run(ws, `document.getElementById('companyBody').innerText`);
  if (mode === 'off') {
    check('shows "Coming soon"', text.includes('Coming soon'));
  } else {
    check('form rendered', await run(ws, `!!document.getElementById('fcName') && !!document.getElementById('fcState')`));
    check('pay button starts disabled', await run(ws, `document.getElementById('fcPay').disabled`));
    if (mode === 'form') {
      await run(ws, `document.getElementById('fcState').value = 'DE'; loadFormationQuote()`);
      await sleep(2500);
      const quote = await run(ws, `document.getElementById('fcQuote').innerText`);
      check('quote shows $110.00 / $118.00 / $228.00', ['$110.00', '$118.00', '$228.00'].every((s) => quote.includes(s)));
      await run(ws, `(() => {
        const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
        set('fcName', 'Verify Studio LLC'); set('fcFounder', 'Formation Verify'); set('fcEmail', 'formation-verify@kaziiplus.com');
        set('fcLine1', '123 Main St'); set('fcCity', 'Austin'); set('fcZip', '78701');
        document.getElementById('fcAddrState').value = 'TX';
        document.getElementById('fcAck').checked = true;
        formationFormChanged();
      })()`);
      check('pay button enables once the form is complete and acknowledged', (await run(ws, `document.getElementById('fcPay').disabled`)) === false);
    } else {
      check('orders list shows the EIN from the completed filing', text.includes('12-3456789'));
      check('orders list shows the refunded message', text.toLowerCase().includes('refunded'));
    }
  }
  const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  writeFileSync(`company-${mode}.png`, Buffer.from(shot.data, 'base64'));
  ws.close();
} finally {
  chrome.kill();
}
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
```

Run it in `off` mode:
```bash
node verify_company_ui.mjs "$TOKEN" off
```
Expected: `PASS  shows "Coming soon"`, four `PASS  window.<fn> is a function` lines, and `ALL CHECKS PASSED`.

- [ ] **Step 7: Enable formation in test mode**

Generate a webhook secret and set the four variables on the `kazii-backend` service (Railway MCP `set-variables`, or `railway variables --service kazii-backend --set KEY=VALUE`):
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"   # use as FORMATION_WEBHOOK_SECRET
```
- `FORMATION_ENABLED=true`
- `FORMATION_PROVIDER=mock`
- `FORMATION_MARKUP_CENTS=7900`
- `FORMATION_WEBHOOK_SECRET=<the generated value>`

Wait for the redeploy (`/health` returns ok and the newest deployment is `SUCCESS`).

- [ ] **Step 8: Verify the quote endpoint and validation**

```bash
curl -sS "https://api.kaziiplus.com/formation/quote?state=DE" -H "Authorization: Bearer $TOKEN"
```
Expected: `{"stateFeeCents":11000,"serviceFeeCents":11800,"totalCents":22800}`.

```bash
curl -sS -o /dev/null -w "bad state: HTTP %{http_code}\n" "https://api.kaziiplus.com/formation/quote?state=ZZ" -H "Authorization: Bearer $TOKEN"
curl -sS -X POST https://api.kaziiplus.com/formation/checkout -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"companyName":"No Suffix Inc","state":"DE","founderName":"A B","founderEmail":"a@example.com","mailingAddress":{"line1":"1 Main St","city":"Austin","state":"TX","zip":"78701"},"acknowledged":true}' -w "\nno-LLC checkout: HTTP %{http_code}\n"
```
Expected: `400` for both.

- [ ] **Step 9: Real Stripe test-mode checkout — success path**

Create a checkout (server recomputes the price; the client sends none):
```bash
curl -sS -X POST https://api.kaziiplus.com/formation/checkout -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"companyName":"Verify Studio LLC","state":"DE","founderName":"Formation Verify","founderEmail":"formation-verify@kaziiplus.com","mailingAddress":{"line1":"123 Main St","city":"Austin","state":"TX","zip":"78701"},"acknowledged":true}'
```
Expected: `{"url":"https://checkout.stripe.com/..."}`. Open that URL and pay with Stripe's test card `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP — with headless Chrome via CDP where Stripe's field selectors cooperate, otherwise ask the user to open the URL and pay. The Stripe page should show **$228.00**.

Then read the order straight from the database with a throwaway script (from `kazii-backend/`, so `@prisma/client` resolves; delete it afterward):
```js
// verify_formation_scratch.mjs
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const rows = await prisma.formationOrder.findMany({
  where: { creator: { user: { email: 'formation-verify@kaziiplus.com' } } },
  orderBy: { createdAt: 'asc' },
  select: { companyName: true, status: true, providerOrderId: true, totalCents: true, stripePaymentIntentId: true, ein: true, registeredAgentAssigned: true, failureReason: true },
});
console.log(JSON.stringify(rows, null, 2));
await prisma.$disconnect();
```
```bash
DATABASE_URL="$(railway variables --service Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)" node verify_formation_scratch.mjs
```
Expected: one row, `status: "SUBMITTED"`, `totalCents: 22800`, a `providerOrderId` starting `mock_`, and a `pi_` payment intent. **If the row is still `PENDING_PAYMENT`,** the Stripe webhook never arrived: the test-mode webhook endpoint (`https://api.kaziiplus.com/webhooks/stripe`, event `checkout.session.completed`) is probably not registered in the Stripe dashboard. That is a change to the user's Stripe account — **STOP and ask the user** to register it (or confirm it exists) rather than working around it.

- [ ] **Step 10: Advance the order with signed provider webhooks**

Create `post_formation_event_scratch.mjs` in the session scratchpad:
```js
// usage: FORMATION_WEBHOOK_SECRET=<secret> node post_formation_event_scratch.mjs '<json event>' [signWithThisSecretInstead]
import { createHmac } from 'node:crypto';

const [,, body, secretOverride] = process.argv;
const secret = secretOverride || process.env.FORMATION_WEBHOOK_SECRET;
const signature = createHmac('sha256', secret).update(body).digest('hex');
const res = await fetch('https://api.kaziiplus.com/webhooks/formation', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-formation-signature': signature },
  body,
});
console.log('HTTP', res.status, await res.text());
```
Using the `providerOrderId` from Step 9 (shown as `<id>`), post in order and re-run the Step 9 database script after each:

1. `node post_formation_event_scratch.mjs '{"providerOrderId":"<id>","status":"FILED"}'` → expect `HTTP 200`, status `FILED`.
2. The same `FILED` event again → expect `HTTP 200`, status unchanged.
3. `node post_formation_event_scratch.mjs '{"providerOrderId":"<id>","status":"COMPLETED","ein":"12-3456789","registeredAgentAssigned":true}'` → expect `HTTP 200`, status `COMPLETED`, `ein` and `registeredAgentAssigned` set.
4. The `FILED` event once more → expect `HTTP 200`, status stays `COMPLETED` (forward-only).
5. `node post_formation_event_scratch.mjs '{"providerOrderId":"<id>","status":"FILED"}' wrong-secret` → expect `HTTP 400 {"error":"invalid_signature"}`.
6. `node post_formation_event_scratch.mjs '{"providerOrderId":"does_not_exist","status":"FILED"}'` → expect `HTTP 200`, and no row changes.

- [ ] **Step 11: Verify the Stripe redelivery guard live**

In the Stripe dashboard (test mode) or with the Stripe CLI, resend the `checkout.session.completed` event for the Step 9 session. Expected: the order's `status` and `providerOrderId` do not change (the atomic claim updated 0 rows). If neither the dashboard nor CLI is available, note this step as covered by the unit test and say so in the report.

- [ ] **Step 12: Real Stripe test-mode checkout — refund path**

Create a second checkout with `"companyName":"Fail Test LLC"` (the mock's forced-failure hook), pay it the same way as Step 9, then re-run the database script. Expected: the row ends `status: "REFUNDED"` with `failureReason: "submission_failed"`. Confirm the refund really exists in Stripe:
```bash
curl -sS "https://api.stripe.com/v1/refunds?payment_intent=<the pi_ from the row>" -u "$(railway variables --service kazii-backend --kv | grep '^STRIPE_SECRET_KEY=' | cut -d= -f2-):"
```
Expected: one refund with `"status":"succeeded"` and the full amount. Do not print the key.

- [ ] **Step 13: Verify the Company tab UI end to end**

Run the Step 6 script in its two remaining modes, with the same token, now that formation is enabled and Steps 9–12 have created orders:
```bash
node verify_company_ui.mjs "$TOKEN" form
node verify_company_ui.mjs "$TOKEN" orders
```
Expected for `form`: the form renders, the pay button starts disabled, the quote shows `$110.00` / `$118.00` / `$228.00`, and the pay button enables once every field is filled and the acknowledgement is ticked. Expected for `orders`: the list shows the EIN `12-3456789` from the completed filing and the refunded message for the second order. Both end with `ALL CHECKS PASSED`; keep the `company-form.png` and `company-orders.png` screenshots for the report, then delete the script.

- [ ] **Step 14: Clean up all test data**

From `kazii-backend/`, with a throwaway script that deletes the user (cascades to the creator profile and all `formation_orders` rows):
```js
// cleanup_formation_scratch.mjs
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const user = await prisma.user.findUnique({ where: { email: 'formation-verify@kaziiplus.com' } });
if (!user) { console.log('no test user found'); process.exit(0); }
await prisma.user.delete({ where: { id: user.id } });
console.log('deleted test user and cascaded rows:', user.id);
await prisma.$disconnect();
```
```bash
DATABASE_URL="$(railway variables --service Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)" node cleanup_formation_scratch.mjs
rm -f verify_formation_scratch.mjs cleanup_formation_scratch.mjs
git status --short
```
Expected: `git status` shows nothing to commit. Delete the scratchpad scripts too.

- [ ] **Step 15: Turn the feature back off**

Set `FORMATION_ENABLED=false` on the `kazii-backend` service and wait for the redeploy. Leave `FORMATION_PROVIDER`, `FORMATION_MARKUP_CENTS`, and `FORMATION_WEBHOOK_SECRET` in place. The tab returns to "Coming soon" until rollout gate 3 (lawyer review, seller entity decided, doola production credentials, markup finalized). Confirm with `GET /formation/quote` returning `503` for a fresh creator token.

- [ ] **Step 16: Report**

Report to the user: what passed, the Stripe test key confirmation, the refund proof, and that formation is deployed but **off**. List the remaining launch gates from spec §7 and the open items from §9 (seller entity, doola's real contract and SSN handling, markup value, Stripe acceptable-use, legal review).

---

## Self-Review Notes

- **Spec coverage:** §2 data model → Task 1. §3.1 adapter + mock → Task 3. §3.2 availability guard → Task 2 (`isFormationAvailable`, applied in every Task 4 handler). §3.3 endpoints, server-side price recompute, `FORMATION_MARKUP_CENTS` validation → Tasks 2 and 4. §3.4 Stripe branch, atomic claim, refund, provider webhook, forward-only statuses, `FAILED` rules → Task 5. §3.5 env vars → Tasks 2, 3, 7. §4 frontend tab, real/fake split, acknowledgement, status timeline, "Coming soon", Stripe return, `window.fn` rule → Task 6. §5 error handling → Tasks 4 and 5. §6 testing and live verification (test-mode key check first, real Stripe checkout, signed webhooks, cleanup) → Tasks 2–5 unit tests and Task 7. §7 rollout gates → Task 7 Steps 15–16. §8 non-goals → deliberately unbuilt. §9 open items → Task 7 Step 16.
- **Plan-level details beyond the spec (not contradictions):** the mock's forced-failure hook (`companyName` containing "FAIL") exists only so the refund path can be verified against real Stripe test payments; the refund-failed note (`; refund_failed`) records that a refund attempt itself failed rather than claiming `REFUNDED`; both webhook routes are wrapped in `asyncHandler`, which also hardens the existing `/stripe` route.
- **Known limitation, unchanged from the spec:** the provider webhook returns `200` for an unknown `providerOrderId`. If a real provider ever reports progress before `providerOrderId` has been saved (a sub-second race after submission), that single event is dropped; real formation providers report minutes later, so this is accepted for v1.
- **Type consistency:** `FormationProvider` (`name`, `getQuote`, `submitFormation`, `parseStatusWebhook`) is defined once in Task 3 and used with the same names in Tasks 4 and 5. Status names (`PENDING_PAYMENT`, `PAID`, `SUBMITTED`, `FILED`, `COMPLETED`, `FAILED`, `REFUNDED`) match between the Task 1 enum, the Task 5 transitions, and the Task 6 `FORMATION_STEPS` / message branches. `providerCostCents`, `stateFeeCents`, `markupCents`, `totalCents` are identical in the schema, the controller, and its test. The four frontend functions referenced in HTML attributes (`formationFormChanged`, `loadFormationQuote`, `startFormationCheckout`, `refreshFormationOrders`) match the four exposure steps.
