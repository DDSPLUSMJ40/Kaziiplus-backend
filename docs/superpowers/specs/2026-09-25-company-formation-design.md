# Company Formation for Creators — Design

**Status:** Approved in conversation, awaiting written-spec review
**Scope:** Let a logged-in creator form a US LLC (with EIN and registered
agent) from inside Kazii+, paying Kazii+ through Stripe, with Kazii+ as the
seller of record and a third-party formation provider doing the filing.
**Not covered:** C-Corps, non-US founders, S-corp election or any other
tax/entity-choice guidance, annual compliance renewals, multi-provider
routing, tying the EIN into Stripe payouts or Printful, and the
affiliate-link "Form your company" card (a separate, optional, tiny item).

## 0. Why this exists

Kazii+'s pitch is "turn your following into a company you actually own."
Today a creator has no path from "I sell products here" to "I have a legal
entity." Formation services (doola, ZenBusiness, LegalZoom and others) exist,
but sending creators off-platform loses the relationship and the revenue.
Embedding formation gives creators a one-stop path and gives Kazii+ a new
revenue line (a flat service fee on top of the provider's cost).

Research (September 2026) found doola is the best-fit provider: it launched a
Formation API in June 2026 with an iFrame tier (no monthly minimum) and a
white-label API tier (wholesale rates, sandbox, status webhooks), and Whop —
a creator-commerce platform — already embeds it. LegalZoom offers affiliate
links only; ZenBusiness offers an enterprise embedded tier with undisclosed
terms. doola access is **not self-serve**: it requires a partnership call and
agreement before the real API contract is visible. That constraint drives
the build sequencing below.

## 1. Decisions made

| Decision | Choice | Why |
|---|---|---|
| Entity types | **LLC only** | What nearly every creator needs; avoids LLC-vs-S-corp-vs-C-corp advice, the highest legal-risk area for a seller |
| Who can apply | **US-resident founders only** | doola does no KYC or sanctions screening, so Kazii+ would own that risk; US residents also get fast SSN-based EINs |
| Build sequencing | **Adapter + built-in mock provider now** | Same pattern as `printful.adapter.ts` / `replicate.adapter.ts`; the whole flow is buildable and testable before the doola agreement; only the adapter file changes when doola access lands |
| Architecture | **Own checkout + status webhooks** (not iFrame-first) | Lets Kazii+ own pricing, payment, and status in the creator's workspace; iFrame remains a fallback if doola is slow to grant API access |
| Fee model | **Flat markup**, configurable | One setting; existing orders keep their quoted price; value chosen after doola's wholesale price is known (starting recommendation: $79) |

## 2. Data model

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
  id                    String          @id @default(cuid())
  creatorId             String
  creator               CreatorProfile  @relation(fields: [creatorId], references: [id], onDelete: Cascade)
  provider              String          // 'MOCK' | 'DOOLA'
  providerOrderId       String?         @unique
  companyName           String
  state                 String          // 2-letter USPS code
  founderName           String
  founderEmail          String
  mailingAddress        Json            // { line1, line2?, city, state, zip }
  providerCostCents     Int             // all-in wholesale incl. state filing fee, frozen at quote time
  stateFeeCents         Int             // the state-filing-fee portion, for the price breakdown
  markupCents           Int             // frozen at quote time
  totalCents            Int             // providerCostCents + markupCents, what Stripe charges
  stripeSessionId       String?         @unique
  stripePaymentIntentId String?         // recorded on payment, used for refunds
  status                FormationStatus @default(PENDING_PAYMENT)
  ein                   String?
  registeredAgentAssigned Boolean       @default(false)
  failureReason         String?
  createdAt             DateTime        @default(now())
  updatedAt             DateTime        @updatedAt

  @@map("formation_orders")
}
```

Add `formationOrders FormationOrder[]` to `CreatorProfile`.

**Deliberately absent:** SSN and date of birth. There are no columns for
them. If a provider needs a Social Security number to obtain an EIN, it must
pass straight through to the provider or be collected in a provider-hosted
step; Kazii+ never stores or logs it (open item 9.2 confirms how doola
collects it).

## 3. Backend

### 3.1 Provider adapter — `src/adapters/formation.adapter.ts`

```ts
export interface FormationQuote { providerCostCents: number; stateFeeCents: number; }
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
  // Throws on an invalid signature; returns null for an event type we ignore.
  parseStatusWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): FormationStatusEvent | null;
}
export function getFormationProvider(): FormationProvider;
```

- `getFormationProvider()` reads `FORMATION_PROVIDER` (default `mock`). `doola`
  throws "not implemented" until `doola.adapter.ts` exists (gate 2 of the
  rollout).
- **Mock provider** (`src/adapters/formation.mock.ts`): deterministic quotes
  (`providerCostCents = stateFeeCents + 3900`, with a small state-fee table
  and a default), `submitFormation` returns a fake `providerOrderId`, and
  `parseStatusWebhook` verifies an HMAC-SHA256 signature header against
  `FORMATION_WEBHOOK_SECRET` so verification scripts can advance statuses
  the same way real provider events will.

### 3.2 Availability guard

`assertFormationAvailable()` runs before every creator-facing formation
endpoint and returns `503 { error: 'formation_unavailable' }` unless:

1. `FORMATION_ENABLED === 'true'`, **and**
2. if the provider is `mock`, `STRIPE_SECRET_KEY` starts with `sk_test_`.

Rule 2 exists so the mock provider can never take a real card payment for a
filing that will never happen.

### 3.3 Endpoints (`src/routes/formation.routes.ts`, mounted at `/formation`)

All creator-authed: `requireAuth, requireAccountType('CREATOR')`, handlers
wrapped in `asyncHandler`, Zod `.safeParse()` validation returning
`400 { error: 'validation_failed', details }`.

- `GET /formation/quote?state=DE` → `{ stateFeeCents, serviceFeeCents,
  totalCents }` where `serviceFeeCents = providerCostCents - stateFeeCents +
  markupCents`. `state` must be a valid USPS state code.
- `POST /formation/checkout` — body: `companyName` (must end in "LLC",
  case-insensitive, ≤ 120 chars), `state`, `founderName`, `founderEmail`,
  `mailingAddress` (US), `acknowledged: true` (literal). The server
  **recomputes the quote itself** (never trusts a client price), creates a
  `FormationOrder` in `PENDING_PAYMENT` with the frozen amounts, creates a
  Stripe Checkout Session (`mode: 'payment'`, one line item for `totalCents`,
  `customer_email`, `metadata: { kind: 'formation', formationOrderId }`,
  `success_url: {FRONTEND_URL}/?formation=success`, `cancel_url:
  {FRONTEND_URL}/?formation=cancelled`), stores `stripeSessionId`, and
  returns `{ url }`.
- `GET /formation/orders` → the creator's orders excluding
  `PENDING_PAYMENT`, newest first. (Unpaid attempts are hidden; there is no
  cleanup job in v1.)

`markupCents` comes from `FORMATION_MARKUP_CENTS` (a non-negative integer;
missing or invalid → `503 formation_unavailable`, so a misconfigured deploy
cannot sell at zero margin by accident).

### 3.4 Webhooks

**Stripe** (`src/routes/webhooks.routes.ts`, existing `checkout.session.completed`
handler): if `session.metadata?.kind === 'formation'`, route to a new
`handleFormationPaid(session)` instead of the storefront-order path.

`handleFormationPaid`:
1. `updateMany` where `id = formationOrderId AND status = PENDING_PAYMENT`
   setting `status = PAID` and `stripePaymentIntentId`. If it updated 0 rows,
   this is a Stripe redelivery — do nothing.
2. Call `provider.submitFormation(...)`.
3. On success: store `providerOrderId`, set `SUBMITTED`.
4. On failure: set `FAILED` with `failureReason`, call
   `stripe.refunds.create({ payment_intent })`, then set `REFUNDED`. The
   Stripe webhook response is unaffected either way (the payment itself
   succeeded), matching how Printful failures are handled.

**Provider** (`POST /webhooks/formation`, public, raw body — the existing
`/webhooks` mount already applies `express.raw`): `provider.parseStatusWebhook`
verifies the signature (bad signature → `400 invalid_signature`) and returns
an event. Then:
- Look up the order by `providerOrderId`; unknown → `200` no-op.
- Status only moves **forward** (`SUBMITTED → FILED → COMPLETED`); a late or
  duplicate event never regresses it.
- `ein` and `registeredAgentAssigned` are stored whenever present.
- A `FAILED` event applies only while the order is `SUBMITTED` or `FILED`; it
  is ignored once the order is `COMPLETED`, `FAILED`, or `REFUNDED`. It sets
  `FAILED` with **no auto-refund** — it needs human judgment, so it is logged
  and the creator's tab says we will contact them.

### 3.5 Environment variables

`FORMATION_ENABLED`, `FORMATION_PROVIDER`, `FORMATION_MARKUP_CENTS`,
`FORMATION_WEBHOOK_SECRET`; later, doola credentials. All set via Railway,
never committed.

## 4. Frontend — "Company" workspace tab (`kazii-frontend/kazii-full-demo.html`)

Follows the existing real/fake split: `!localStorage.getItem('kaziiToken')`
shows an explainer with a sign-up prompt (no fake filing data); a logged-in
creator sees the real flow.

- **Form → quote → acknowledgement → pay.** Fields as in 3.3; the quote
  shows "State filing fee $X" and "Kazii+ service fee $Y" and the total; the
  pay button is disabled until the acknowledgement box is ticked ("Kazii+ is
  not a law firm; this is not legal or tax advice").
- **Status timeline** per order (Paid → Submitted → Filed → Completed) with
  the EIN and registered-agent status when present, and the "we'll contact
  you" message for `FAILED`/`REFUNDED`.
- **Feature off** (`503 formation_unavailable`): the tab shows "Coming soon."
- Returning from Stripe with `/?formation=success` reopens the workspace on
  the Company tab and refreshes orders.
- **Standing rule (from this project's own history):** every new function
  called from an inline `onclick`/`oninput` attribute must be added to the
  `window.fn = fn` exposure block at the end of its IIFE. The implementation
  plan lists this as its own checklist item per function.

## 5. Error handling

`400 validation_failed` (Zod), `404 not_found` (an order not owned by the
caller), `503 formation_unavailable` (flag off, live-key guard, missing
markup config, or provider unavailable at quote time), `400 invalid_signature`
(provider webhook). Provider errors never leak provider internals to the
creator; they surface as `formation_unavailable` or a `FAILED` order with a
generic message.

## 6. Testing and verification

- **Vitest** in the repo's mocked style (`vi.hoisted`, mocked prisma / stripe /
  adapter): server-side price recompute; validation (LLC suffix, state,
  acknowledgement); atomic `PENDING_PAYMENT → PAID` and Stripe redelivery
  being a no-op; refund + `REFUNDED` on submission failure; forward-only
  provider statuses and unknown-order no-op; bad-signature rejection;
  availability guard (flag off; mock with a non-test Stripe key; missing
  markup); ownership checks on `/formation/orders`.
- **Live verification**, per this project's standing practice: first confirm
  the production Stripe key really is test mode; then a full Stripe test-mode
  checkout against production with the mock provider, advancing statuses with
  signed webhook calls, confirming the tab renders each state; test rows
  cleaned up afterward via a throwaway Prisma script.

## 7. Rollout gates

1. **Mock end to end**, `FORMATION_ENABLED` off in production except during
   verification.
2. **doola sandbox:** write `doola.adapter.ts` once the agreement and sandbox
   docs arrive. Only that file and environment settings change.
3. **Public launch** only after: lawyer review of the terms and disclaimers,
   a decision on the seller entity, doola production credentials, and
   `FORMATION_MARKUP_CENTS` set.

## 8. Non-goals (v1)

C-Corp formation, non-US founders, S-corp election or entity-choice guidance,
annual compliance and renewals, multiple providers behind routing logic,
feeding the EIN into Stripe payouts or Printful, a cleanup job for abandoned
checkouts, limits on companies per creator, and tier-based fee discounts.

## 9. Open items (not blocking the mock-first build)

1. **Seller entity:** which legal entity appears as the seller of record on
   receipts (Amethyst Holdings?) — a question for the lawyer review.
2. **doola's real contract:** field names, how EINs are requested (and
   therefore how an SSN is collected without Kazii+ handling it), status
   event names, refund and failure semantics, wholesale pricing. Unknown
   until the partnership call.
3. **Markup value:** starting recommendation $79 flat; revisit once wholesale
   pricing is known. It must clear roughly $60–125 net of Stripe fees to beat
   the affiliate route.
4. **Stripe acceptable-use:** confirm selling formation services through
   Kazii+'s Stripe account is permitted for the account's business category.
5. **Legal review** of the terms, the "not legal or tax advice" language, and
   any state-specific rules on non-lawyer formation services, before public
   launch.
