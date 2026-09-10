# Phase 2 + Printful Connect — Design

**Status:** Approved, ready for implementation plan
**Scope:** Product CRUD, public storefront + Stripe checkout (full Phase 2 per
the backend README), plus the first slice of the Printful integration from
`kazii-fulfillment-integration-spec.md` — connect flow and catalog browsing
only.
**Not covered:** Printful order creation/webhooks (next slice), any other
fulfillment provider, Supplier/Manufacturer-side product listing, the
Match Score / supplier-directory work (Phase 3).

## 0. Why this grouping

Phase 2 (product endpoints) and the storefront route were originally listed
as separate phases in the backend README, but a storefront is meaningless
without persisted products to show on it, and a "storefront link" isn't real
until it resolves to a live page — so this spec treats product CRUD, the
public storefront route, and checkout as one unit of work. Printful
connect+catalog is included in the same pass at the user's request, but is
architecturally independent of the storefront work — it could ship before,
after, or in parallel.

## 1. Data model changes

All additive to the existing `prisma/schema.prisma`; nothing here removes or
renames an existing field except where noted.

```prisma
enum PaymentStatus {
  PENDING
  PAID
  FAILED
  REFUNDED
}

enum FulfillmentProvider {
  PRINTFUL
}

enum ConnectionStatus {
  ACTIVE
  REVOKED
  ERROR
}

model CreatorProfile {
  // ...existing fields unchanged...
  storefrontLive Boolean @default(true)
}

model Order {
  // ...existing fields unchanged...
  paymentStatus  PaymentStatus @default(PENDING)
  stripeSessionId String?      @unique
  quantity        Int          @default(1)
  customerEmail   String?
}

model FulfillmentConnection {
  id                   String             @id @default(cuid())
  creatorId            String
  creator              CreatorProfile     @relation(fields: [creatorId], references: [id], onDelete: Cascade)
  provider             FulfillmentProvider
  encryptedAccessToken String
  status               ConnectionStatus   @default(ACTIVE)
  connectedAt          DateTime           @default(now())
  lastSyncedAt         DateTime?

  @@unique([creatorId, provider])
  @@map("fulfillment_connections")
}
```

**Naming deviation from the fulfillment spec:** §3 of
`kazii-fulfillment-integration-spec.md` suggests a table called
`supplier_connections`. That name collides with the existing `SupplierProfile`
account type, which models a *raw-material/ingredient supplier* — an
unrelated concept from a creator's Printful/Gelato connection. This spec uses
`fulfillment_connections` / `FulfillmentConnection` instead. Anywhere else
this codebase talks about "suppliers" going forward should keep meaning the
`SUPPLIER` account type, not a fulfillment provider.

**Deliberately deferred:** a `synced_products` cache table (also from the
fulfillment spec) is not part of this pass. Catalog browsing proxies
Printful's API live. Caching only earns its complexity once product-binding
(attaching a Kazii product to a specific Printful variant) exists, which is
a later slice.

## 2. Product endpoints

Creator-authed (`requireAuth` + `requireAccountType('CREATOR')`), under
`/products`:

| Method | Path | Behavior |
|---|---|---|
| POST | `/products` | Create a product, `status` defaults to `DRAFT`. Body: `name`, `productType`, `color?`, `price?`, `designJson?`. |
| GET | `/products` | List the authenticated creator's own products. |
| GET | `/products/:id` | Get one product; 404 if it doesn't belong to the caller (not 403 — don't confirm existence of another creator's product ID). |
| PATCH | `/products/:id` | Update any of the create fields, including `status` (DRAFT↔LIVE — this is how "publish" works, no separate publish endpoint). |
| DELETE | `/products/:id` | Delete; 404 under the same rule as GET. |

Validation mirrors the existing `auth.schemas.ts` pattern: a Zod schema per
operation in `src/schemas/products.schemas.ts`.

## 3. Public storefront

No auth. Under `/store`:

| Method | Path | Behavior |
|---|---|---|
| GET | `/store/:slug` | Look up `CreatorProfile` by `storefrontSlug`. 404 if no such slug. If found but `storefrontLive=false`, return `{ live: false, brandName }` (enough for the frontend to render the existing "storefront is currently offline" state) rather than 404 — the link itself is still real. If live, return creator display info + `status=LIVE` products only, with price. |

Creator-authed, under `/creators/me`:

| Method | Path | Behavior |
|---|---|---|
| PATCH | `/creators/me/storefront` | Update `storefrontSlug` (validated: lowercase, `[a-z0-9-]+`, uniqueness checked) and/or `storefrontLive`. |
| GET | `/creators/me/orders` | List orders against the caller's products, for the dashboard Orders tab. |

**Slug assignment:** generated at signup time in `auth.controller.ts`'s
`signup()`, from `brandName` (if present) or `firstName`, slugified
(lowercase, spaces→hyphens, strip non-`[a-z0-9-]`), with a short random
suffix appended on collision. Every creator has a resolvable storefront link
immediately after signup, not only after manually setting one — this is what
makes `copyLink()` in `kazii-full-demo.html` (currently hardcoded to
`https://kaziiplus.com/elenacruz`) able to use a real per-creator value.

## 4. Checkout (Stripe, test-mode)

Stripe Checkout Sessions (hosted redirect), not embedded Elements — the
frontend is static HTML with no build step, and a redirect flow needs no
frontend JS beyond following the returned URL and reading `?session_id=` back
on return.

| Method | Path | Behavior |
|---|---|---|
| POST | `/store/:slug/checkout` | Public. Body: `productId`, `quantity`, `customerEmail`. Validates the product belongs to the creator at `:slug` and is `LIVE`. Creates a Stripe Checkout Session (one line item, `price * quantity`, `success_url`/`cancel_url` built from `FRONTEND_URL` back to the storefront page). Creates an `Order` row: `paymentStatus=PENDING`, `stripeSessionId`, `quantity`, `amount`, `customerEmail`. Returns `{ checkoutUrl }`. |
| POST | `/webhooks/stripe` | Public. Verifies the Stripe signature against `STRIPE_WEBHOOK_SECRET`. On `checkout.session.completed`, looks up the `Order` by `stripeSessionId` and sets `paymentStatus=PAID`. |

**Implementation detail that affects `index.ts`:** the webhook route needs
Stripe's raw request body to verify the signature, which must be mounted
*before* the global `express.json()` middleware currently applied to every
route in `index.ts`. This means `/webhooks/stripe` gets its own
`express.raw({type: 'application/json'})` middleware registered ahead of the
general JSON parser, not just a normal route added to the existing router
stack.

**Explicitly out of scope:** actually sending a paid order to Printful for
fulfillment. A `PAID` order is recorded and visible in
`GET /creators/me/orders`, ready for the next slice (Printful order
creation) to pick up — this spec doesn't wire that handoff.

## 5. Printful adapter — connect + catalog only

Per `kazii-fulfillment-integration-spec.md` §2.1 and §3's
`FulfillmentAdapter` interface, but only the catalog-reading surface — no
`createOrder`, no `verifyWebhook` in this pass. Adding unused interface
methods now would be speculative; the interface grows when order creation is
actually built.

- `src/lib/crypto.ts` — `encrypt(plaintext: string): string` /
  `decrypt(ciphertext: string): string` using AES-256-GCM, keyed by a new
  `ENCRYPTION_KEY` env var (32 random bytes, generated the same way
  `JWT_SECRET` already is: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
  IV and auth tag are packed into the stored string alongside the
  ciphertext so decryption is self-contained.
- `src/adapters/printful.adapter.ts` — `listCatalog(token)`,
  `getProduct(token, id)`, calling `https://api.printful.com/products` and
  `/products/{id}` with `Authorization: Bearer <token>`.

Creator-authed, under `/fulfillment/printful`:

| Method | Path | Behavior |
|---|---|---|
| POST | `/fulfillment/printful/connect` | Body: `apiToken`. Validates the token with a real Printful call (`GET /products`) before persisting anything — a bad token never gets saved. Encrypts and upserts a `FulfillmentConnection` row (`@@unique([creatorId, provider])` makes this idempotent per creator/provider pair). |
| DELETE | `/fulfillment/printful/connect` | Disconnect — deletes the row (simpler than a soft `REVOKED` state for a first pass; `ConnectionStatus` still exists for the `ERROR` case, e.g. if a later health-check call starts failing). |
| GET | `/fulfillment/printful/catalog` | Requires an `ACTIVE` connection for the caller; decrypts the stored token, proxies Printful's catalog list. |
| GET | `/fulfillment/printful/catalog/:id` | Same, for one product's variants/pricing. |

## 6. Env vars added

Documented in `.env.example` alongside the existing three:

- `ENCRYPTION_KEY` — AES key for `FulfillmentConnection.encryptedAccessToken`.
- `STRIPE_SECRET_KEY` — test-mode secret key.
- `STRIPE_WEBHOOK_SECRET` — for verifying `/webhooks/stripe` signatures.
- `FRONTEND_URL` — base URL used to build Stripe `success_url`/`cancel_url`.

All four ship as placeholders in `.env.example`, the same pattern already
used for `JWT_SECRET` — real values are generated/obtained at deploy time,
never committed.

## 7. Error handling conventions (carried over from `auth.controller.ts`)

- Zod `safeParse` → `400 { error: 'validation_failed', details }` on every
  endpoint that takes a body.
- Ownership checks (product/order belongs to caller) return `404`, not `403`
  — consistent with not letting a caller distinguish "doesn't exist" from
  "exists but isn't yours."
- Printful token validation failure on connect → `400 { error:
  'invalid_printful_token' }`, not a 500 — this is a user-correctable input
  error, not a server fault.
- Stripe webhook signature failure → `400`, logged, no retry-inducing 500.

## 8. Testing / verification plan

This session has real network access (confirmed: `npm ping` reached the npm
registry, and `origin` already points at
`github.com/DDSPLUSMJ40/Kaziiplus-backend`), which the Phase 1 session did
not have. Per the user's choice, verification stops at:

- `npm install` for real (not just `tsc` against uninstalled types).
- `tsc` build clean.
- `npx prisma validate` on the updated schema.

**Not done in this pass:** running `prisma migrate` against the real Railway
Postgres, any live call to Stripe or Printful's actual APIs, committing, or
pushing. Changes are left as uncommitted working-tree edits for the user to
review and push/deploy themselves — same posture as Phase 1's README being
explicit about verified-vs-not.

## 9. Open items for a future pass (not blocking this one)

- Printful order creation + webhook receiver (deferred per user's explicit
  scope choice).
- Payout split between Kazii and creators on a paid order — not addressed;
  today the order just records `amount` paid via Stripe with no split logic.
- `synced_products` catalog caching, once product-to-Printful-variant
  binding exists.
- Reconciling the two frontend clusters (`kazii-full-demo.html` vs the
  `kazii-redesign.html`/`creators.html`/`suppliers.html` set) noted as a
  known follow-up in the frontend README — this spec only changes the
  backend API surface, not which frontend page calls it.
