# Kazii+ Fulfillment Provider Integration — Technical Spec

**Status:** Draft for engineering scoping
**Scope:** Printful, Gelato, CJ Dropshipping, Alibaba
**Not covered:** Payments, tax/customs, creator payout logic — separate specs

---

## 1. Why this needs a backend

None of these providers can be called directly from the browser. Every one of them authenticates with a long-lived secret (API token, API key, or access token) that must never be visible in client-side code — anyone who opens dev tools could read it, use it against the connected account, or drain API quota. Kazii+ needs a thin backend service that:

- Holds every creator's provider credentials, encrypted at rest
- Makes the actual API calls on the creator's behalf
- Exposes Kazii's own internal endpoints to the frontend (e.g. `GET /api/catalog?provider=printful`), which the frontend already expects to call — the frontend never talks to Printful/Gelato/CJ/Alibaba directly

This is the single biggest scope item in this doc. Everything below assumes that service exists.

---

## 2. Provider-by-provider

### 2.1 Printful — the strongest fit

| | |
|---|---|
| **Auth** | Bearer token in `Authorization` header. Either a Private Token (scoped to one store) or full OAuth 2.0 for a multi-merchant app. Legacy API keys were fully deprecated March 2023 — token auth only. |
| **Base URL** | `https://api.printful.com` (v1, stable) / `https://api.printful.com/v2` (v2, beta — extended catalog data, better pagination) |
| **Catalog** | `GET /products` → blank product list. `GET /products/{id}` → variants (size/color combos), each with a unique `variant_id` you must reference when creating orders. |
| **Pricing** | `GET /v2/catalog-variants/{id}/prices` — pricing depends on which print placement is selected, so this has to be re-queried per design, not cached once. |
| **Mockups** | Dedicated Mockup Generator endpoint — given a print file + variant, returns a rendered product photo. This is what would power a real (not simulated) product preview in the Builder. |
| **Orders** | `POST /orders` to create, `GET /orders/{id}` for status. |
| **Webhooks** | Configurable per store — order status changes, catalog updates. Use these instead of polling. |
| **Rate limit** | 30 req/60s unauthenticated; authenticated limits are higher but plan-dependent — confirm actual ceiling during onboarding, don't assume. |
| **Notable constraint** | Jewelry products are explicitly excluded from the API. The Products API is for your own store/design workflow — it is not designed to re-list on Shopify/WooCommerce/etc., which is irrelevant to Kazii but worth knowing if scope ever expands. |

**Verdict:** Best documentation in the category, most complete feature set (catalog + mockups + orders + webhooks in one coherent API). Good pilot candidate.

### 2.2 Gelato — strong for print-heavy goods

| | |
|---|---|
| **Auth** | API key in `X-API-KEY` header. No OAuth — flat key per account. |
| **Base URLs** | Split across subdomains: `order.gelatoapis.com` (orders), `product.gelatoapis.com` (catalog/pricing/stock), `shipment.gelatoapis.com` (shipping methods), `ecommerce.gelatoapis.com` (store products/templates). Four integration points, not one. |
| **Catalog** | `GET /v3/catalogs` → list of catalogs (posters, apparel, cards, etc.). `GET /v3/catalogs/{catalogUid}` → attributes (size, paper type, orientation) needed to build a valid `productUid` string. Product identity here is a structured string, not a numeric ID — e.g. `apparel_product_gca_t-shirt_gsc_crewneck_...`. Parsing/generating these correctly is the main integration complexity. |
| **Orders** | `POST /v4/orders` — supports up to 100 line items per request. Requires `orderReferenceId`, `customerReferenceId`, `itemReferenceId` — Kazii's own internal IDs, which Gelato expects you to generate and track. |
| **Webhooks** | Configurable in dashboard for order/production events. |
| **Rate limit** | 100 req/sec per key on the Order Flow API — high enough that this isn't a practical constraint. Returns 429 on excess; exponential backoff with jitter is Gelato's own documented recommendation. |
| **Notable constraint** | Shipping prices are real-time and not listed statically — don't cache a shipping price table, query it per-order. |

**Verdict:** Strong for print/paper goods specifically (posters, canvas, cards) — narrower catalog than Printful but deep in that lane, and local production in 30+ countries is a real differentiator if international creators matter.

### 2.3 CJ Dropshipping — broadest catalog, tightest rate limit

| | |
|---|---|
| **Auth** | Token-based. `POST` an email + API key to get an `accessToken` (180-day validity) and `refreshToken` (also 180-day). Pass as `CJ-Access-Token` header on every subsequent call. |
| **Base URL** | `https://developers.cjdropshipping.com/api2.0/v1/` |
| **Catalog** | Much broader than Printful/Gelato — general dropshipping goods (electronics, home goods, gadgets), not just print-on-demand blanks. Product search/sourcing via `/product/sourcing/query`. |
| **Product connection** | CJ's model requires explicitly binding a CJ product/variant to your platform's product/variant before orders can route automatically — this is a real data-modeling step, not just a display concern. |
| **Orders & tracking** | Order creation and sync endpoints, plus webhook subscriptions for order and tracking-number updates. |
| **Rate limit** | **1 request per second.** This is the tightest limit in the group by a wide margin, and it's a real constraint: syncing a catalog of ~1,850 products one-by-one would take over 30 minutes minimum if there's no bulk endpoint in the path you use. **Confirm whether a batch/bulk catalog endpoint exists before committing to a per-product sync design** — this spec doesn't assume one either way. |
| **Token lifecycle** | Both tokens expire at 180 days. Needs a scheduled refresh job well before expiry, with alerting if a refresh fails (a creator's fulfillment silently going dark is a bad failure mode). |

**Verdict:** Valuable for non-apparel product categories the other two don't cover, but the 1 QPS ceiling needs to be designed around from day one — this is the provider most likely to cause a bad surprise if treated as an afterthought.

### 2.4 Alibaba — different category of integration, not a fourth version of the same thing

This is the one worth being direct about: **Alibaba's Open Platform (GGS / Global Golden Supplier) is built for large suppliers to connect their own ERP systems to Alibaba.com** — inventory sync, order sync, their listings. It is not built for a third-party platform like Kazii to browse a live catalog and place small custom-batch orders on behalf of individual creators. A few concrete differences from the three above:

- **Registration is a review process**, not a self-serve key generation — you register an app in a category, Alibaba's GGS admins approve it, then you get an App Key/App Secret.
- **Auth is OAuth-style** (authorization code → access token) but scoped to *supplier* data access, not buyer-side catalog browsing at the scale Kazii would need.
- There is no equivalent of "pull 340 products with live pricing and MOQ" the way Printful's or Gelato's catalog endpoints work.

**Recommendation:** Don't scope Alibaba as an engineering integration in the same phase as the other three. Realistic paths, in order of effort:

1. **Manual relationship** (what Kazii's current "Suppliers" directory already models) — an ops person maintains the relationship, MOQ/lead-time data is entered and updated by hand or via a periodic manual export.
2. **RFQ-based sourcing tooling** — Alibaba supports Request-for-Quotation workflows; a lightweight internal tool that generates RFQs on a creator's behalf is possible, but is closer to a sourcing-ops feature than an API integration.
3. **Formal Alibaba partnership** — if volume ever justifies it, Alibaba does work with platform partners directly, but that's a business-development conversation, not something to route through the public Open Platform docs.

Don't let Alibaba block shipping the other three — it's genuinely a separate workstream.

---

## 3. Backend architecture sketch

```
┌─────────────┐      ┌──────────────────────┐      ┌─────────────────┐
│   Kazii     │─────▶│  Kazii backend        │─────▶│ Printful API     │
│   frontend  │      │  (fulfillment service)│─────▶│ Gelato API       │
└─────────────┘      │                       │─────▶│ CJ Dropship API  │
                      │  - credential vault   │      └─────────────────┘
                      │  - provider adapters  │
                      │  - sync queue         │
                      │  - webhook receivers  │
                      └──────────┬────────────┘
                                 │
                          ┌──────▼──────┐
                          │  Database    │
                          └─────────────┘
```

**Provider adapter pattern** — one module per provider implementing a shared interface, so the rest of the app doesn't need to know which provider it's talking to:

```ts
interface FulfillmentAdapter {
  listCatalog(): Promise<CatalogProduct[]>;
  getProduct(id: string): Promise<CatalogProduct>;
  createOrder(order: KaziiOrder): Promise<ProviderOrderRef>;
  getOrderStatus(providerOrderId: string): Promise<OrderStatus>;
  verifyWebhook(req: Request): boolean;
}
```

**Suggested tables:**

- `supplier_connections` — `creator_id`, `provider`, `encrypted_access_token`, `encrypted_refresh_token`, `expires_at`, `connected_at`, `status`
- `synced_products` — `provider`, `external_product_id`, `kazii_product_id`, `cached_catalog_json`, `last_synced_at`
- `fulfillment_orders` — `kazii_order_id`, `provider`, `provider_order_id`, `status`, `last_webhook_at`

**Secrets:** encrypted at rest (KMS-backed column encryption or a dedicated secrets manager — AWS Secrets Manager / HashiCorp Vault), never logged, never returned in any API response the frontend can read.

**Sync strategy:** event-driven where possible (webhooks), scheduled polling as fallback where a provider's webhook coverage is incomplete. CJ Dropshipping's sync job specifically needs a rate-limited queue (1 req/sec, serialized) rather than a naive loop — this is the one place a bad implementation would visibly break.

**Token refresh:** CJ's 180-day tokens need a scheduled refresh job with alerting on failure. Printful/Gelato don't have this problem the same way (Printful tokens are typically long-lived or non-expiring by default; Gelato's API key doesn't expire on a fixed cycle) but confirm current behavior during implementation, since provider auth models do change.

---

## 4. Suggested phasing

1. **Printful only** — best docs, full feature coverage, good pilot. Wire up catalog, mockup generation, order creation, and webhooks end-to-end for one provider before touching the others.
2. **Gelato** — similar shape to Printful, mainly new work is handling the four-subdomain structure and the structured `productUid` format.
3. **CJ Dropshipping** — same adapter pattern, but budget real time for the rate-limited sync queue and token refresh job. Don't reuse Printful/Gelato's sync approach unmodified.
4. **Alibaba** — treat as an ops/business workstream, not a phase-4 engineering sprint. Revisit once 1–3 are live and volume data suggests it's worth pursuing a formal partnership conversation.

---

## 5. Open questions to resolve before implementation

- Does CJ Dropshipping expose a bulk/batch catalog endpoint anywhere in the docs beyond what's summarized here? This materially changes the sync design.
- What's Printful's actual authenticated rate limit on Kazii's plan tier? The 30 req/60s figure is the *unauthenticated* ceiling.
- Which provider fulfills a given product when a creator has multiple connected? (Needs a routing rule — e.g. explicit per-product provider assignment, not automatic selection.)
- Webhook signature verification specifics per provider — confirm each one's method (shared secret, HMAC, etc.) before building the receiver.
