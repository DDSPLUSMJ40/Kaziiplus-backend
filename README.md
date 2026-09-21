# Kazii+ Backend

Node.js + Express + TypeScript + Prisma + PostgreSQL, deployed on Railway
(project `kaziiplus`, service `kazii-backend`, live at
`https://api.kaziiplus.com`). Paired with the `kazii-frontend` repo — a
single-file static app (`kazii-full-demo.html`) that calls this API
directly. There is no local dev database convention documented here yet;
every migration in this project has been run directly against the live
Railway Postgres instance using its `DATABASE_PUBLIC_URL`.

## What's real

Everything below is live in production, verified end-to-end against
`https://api.kaziiplus.com` with real HTTP requests, not simulated:

- **Auth** (`/auth`) — signup/login for three account types (Creator /
  Supplier / Manufacturer), JWT-based, backed by a real Postgres
  `users` table.
- **Products** (`/products`) — creators create, update, publish, and
  delete real products. A product can carry an uploaded or
  AI-generated artwork layer as `printFileData`, served publicly (no
  auth — external fulfillment providers need to fetch it) at
  `GET /products/:id/print-file.png`.
- **Checkout & payments** (`/`, `/webhooks`) — a creator's real
  storefront (`GET /store/:slug`) runs a real Stripe Checkout session
  (`POST /store/:slug/checkout`) with shipping address collection; the
  Stripe webhook marks orders PAID/FAILED and is what triggers
  fulfillment below.
- **Printful fulfillment** (`/fulfillment`) — a creator connects a real
  Printful account (API token, encrypted at rest with AES-256-GCM),
  binds a product to a real Printful catalog variant, and a PAID order
  automatically creates a real Printful order (draft, then confirmed).
- **AI design generation** (`/ai`) — `POST /ai/generate-design` lets a
  creator generate print-ready artwork from a text prompt via
  Replicate (`black-forest-labs/flux-schnell`, then background removal
  via `lucataco/remove-bg`), capped at 10 free generations/creator/month.
  Polls past Replicate's own ~60s response window (up to 3 minutes) for
  slow/cold predictions instead of failing outright. A failed
  generation never consumes the creator's monthly quota (only
  successful generations are counted).
- **Creator stats** — real endpoints back the frontend workspace's
  Overview/Products/Orders/Analytics tabs for a logged-in creator (no
  separate "analytics" table; these are derived from real orders/products
  at request time).

## Not yet real

- **Supplier directory / "Match Score" matching system** — no supplier
  directory or matching algorithm exists yet, backend or otherwise.
  This is separate, larger scope, not a quick wiring job like
  everything above.
- **Gelato, CJ Dropshipping fulfillment** — only Printful is wired up;
  the other two providers shown in the frontend's Builder rail have no
  backend behind them yet.
- **Social media connection** (populating real follower counts) — not
  built.

## Stack & structure

```
src/
  controllers/    one file per resource (auth, products, checkout/storefront, fulfillment, ai)
  adapters/       thin wrappers around external APIs (printful.adapter.ts, replicate.adapter.ts) —
                  no framework code inside them, just the HTTP calls
  routes/         Express routers, each mounted in index.ts
  schemas/        Zod validation schemas, one per resource
  middleware/      auth (requireAuth/requireAccountType), asyncHandler, error handler
  lib/            prisma client singleton, crypto.ts (AES-256-GCM for stored API tokens)
prisma/
  schema.prisma   the data model
  migrations/     applied directly against the live Railway Postgres instance
```

New work in this repo follows the `superpowers` skill workflow
(`docs/superpowers/specs/` → `docs/superpowers/plans/`) — see those
folders for the design history behind what's built.

## Testing

```
npm test        # Vitest — 17 files / 99 tests as of this writing, all against mocked
                 # Prisma/adapters, no network calls
npm run build    # tsc
```

Beyond the unit suite, every feature above has been verified with a real
end-to-end pass against production (real signup, real Stripe test-mode
checkout, a real — and in one case, deliberately risk-flagged — Printful
order, a real Replicate generation) with test data cleaned up
afterward via `prisma db execute` / a throwaway script against the live
database.

## Environment variables (set on Railway, never committed)

`DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY` (Printful token
encryption), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`REPLICATE_API_TOKEN`, `NODE_ENV`, `FRONTEND_URL`.
