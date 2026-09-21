# AI-Assisted Product Design Generation — Design

**Status:** Approved, ready for implementation plan
**Scope:** Let a creator generate artwork from a text prompt in the Builder,
as an alternative to uploading their own image, backed by Replicate.
**Not covered:** Any change to how a design becomes a print file (the
existing "first uploaded/generated image layer wins" pipeline is untouched),
content moderation beyond what Replicate's own models provide, and any
provider other than Replicate.

## 0. Why this exists

The Builder today only accepts artwork a creator already has (upload a
file). Most creators don't have print-ready artwork sitting around —
generating it from a text prompt removes that barrier and is a real
differentiator: no competitor bundled into this same flow offers in-app
generation feeding directly into fulfillment.

Because the Builder's existing artwork-upload layer already feeds the real
print-file pipeline built for Printful (`Product.printFileData`, served at
`GET /products/:id/print-file.png`), a generated image only needs to become
an image layer identical in shape to an uploaded one — the rest of the
pipeline (print-file storage, Printful order creation) requires zero
changes.

## 1. Data model

```prisma
model AiGeneration {
  id        String   @id @default(cuid())
  creatorId String
  creator   CreatorProfile @relation(fields: [creatorId], references: [id], onDelete: Cascade)
  prompt    String
  createdAt DateTime @default(now())

  @@map("ai_generations")
}
```

Add `aiGenerations AiGeneration[]` to `CreatorProfile`. One row per
**successful** generation only (see §4, fairness rule) — this table is
simultaneously the monthly-cap counter (`COUNT(*) WHERE creatorId = ? AND
createdAt >= start_of_current_calendar_month`) and a prompt audit log, in
case moderation is ever needed later. No separate counter column, no
scheduled reset job — the calendar-month filter in the query makes the cap
self-resetting.

## 2. Backend

### 2.1 Replicate adapter — `src/adapters/replicate.adapter.ts`

Mirrors the shape of `printful.adapter.ts`: one small module wrapping the
external API, no framework-specific code inside it.

```ts
export async function generateImage(prompt: string): Promise<Buffer>
```

- Model: `black-forest-labs/flux-schnell` — fast (2-4s), cheap
  (~$0.003/image), well-suited to illustration-style prompts. The
  background-removal call below adds a second, smaller per-generation
  cost on top of this — exact figure to confirm against Replicate's
  current pricing when the token is set up, not committed to a specific
  number here.
- Uses Replicate's synchronous mode (`Prefer: wait` header) so the call
  resolves with a direct result instead of requiring polling or a
  webhook/job queue. If Replicate ever returns a still-processing state
  despite this header, that's treated as a failure for this pass (retry is
  the creator clicking Generate again) — no polling loop is built.
- **Background removal, always, no creator control.** A base text-to-image
  model doesn't produce real alpha transparency from a prompt alone — it
  paints something wherever the prompt implies a background, it doesn't
  understand "transparent." A design without a transparent background
  looks wrong on any product color other than whatever the model happened
  to paint, so `generateImage` chains a second Replicate call (a
  background-removal model, e.g. `851-labs/background-remover` — cheap,
  ~1-2s) on the first call's output before returning. This isn't exposed
  as a creator-facing choice: transparent is correct for a print file
  essentially always, and a toggle would mostly just be a way to
  accidentally break one's own artwork. A future pass could revisit this
  if creators actually ask for baked-in colored backgrounds, but that's a
  prompt-writing concern ("...with a sunset gradient background"), not a
  transparency toggle.
- Downloads the resulting (post-background-removal) image and resolves
  with the raw PNG bytes (matching what `printFileBase64` already expects
  on the frontend/backend boundary — see §2.3).
- Throws on any non-success response from either Replicate call; the route
  handler is responsible for turning that into a user-facing error, not
  this module.

### 2.2 Env var

`REPLICATE_API_TOKEN` — set on Railway the same way `STRIPE_SECRET_KEY`
and the Printful-adjacent keys were: never committed, generated/obtained
at deploy time.

### 2.3 Endpoint — `POST /ai/generate-design`

Creator-authed (`requireAuth` + `requireAccountType('CREATOR')`).

Request: `{ prompt: string }` (Zod: non-empty, max 500 characters — bounds
cost/abuse without being restrictive for a real design prompt).

Handler flow:
1. Look up the creator's `AiGeneration` count for the current calendar
   month. If `>= 10`, return `429 { error: 'generation_limit_reached' }`
   without calling Replicate.
2. Call `generateImage(prompt)`. On failure (thrown error), return
   `500 { error: 'generation_failed' }` — **do not** create an
   `AiGeneration` row (fairness rule: a Replicate outage never burns a
   creator's quota).
3. On success: create the `AiGeneration` row (increments the count for
   future requests), and return
   `200 { imageBase64: '<base64, no data: prefix>' }`.

This response shape deliberately matches what the frontend already knows
how to do with an uploaded file's data URL — see §3.

## 3. Frontend

### 3.1 New Builder tab: "AI Design"

Added to the existing rail alongside Product/Color/Artwork/Text/Printful/
etc. (`builderSetTab('ai')`). Panel contents (rendered in the existing
`renderPanel()` dispatch, same pattern as the other tabs):

- A prompt `<textarea>`.
- A "Generate" button, disabled while a request is in flight (shows
  "Generating…").
- A small usage counter: "X of 10 free this month" — comes from the same
  response that answers the generate call; no separate status endpoint
  needed for this (the count is only interesting right after a call, and
  worst case a creator finds out they're capped when they try — that's an
  acceptable, honest UX, not a bug to design around).
- Once a generation succeeds: a preview of the result plus an "Add to
  design" button.

### 3.2 Wiring

```js
async function generateAiDesign(prompt){
  const token = localStorage.getItem('kaziiToken');
  if(!token){ toast('Sign up to use AI design generation'); goTo('auth'); authSetMode('signup'); return; }
  // POST prompt, handle 429 (show cap message) / error (toast) / success
  // (store the returned base64 as a pending preview, do NOT call
  // addImageLayer yet)
}

function addGeneratedDesignToLayers(){
  // wraps the pending base64 result in a data URL and calls the existing
  // addImageLayer(dataUrl) -- same function an upload already uses.
}
```

"Add to design" is a separate, explicit click rather than auto-adding the
layer the moment generation succeeds — a creator should be able to look at
the result and decide, the same way they'd look at a mockup before
committing to it. Regenerating (a new prompt, or retrying) before clicking
"Add to design" simply discards the previous unattached preview; nothing
about this is persisted until "Add to design" is clicked.

### 3.3 Not logged in

Same pattern as `saveBuilderProduct`: no `kaziiToken` → toast prompting
signup, redirect to the signup screen, no API call attempted. The
"preview without account" marketing flow never hits the real Replicate
endpoint.

## 4. Error handling conventions (carried over from existing patterns)

- Zod `safeParse` on the prompt → `400 { error: 'validation_failed' }`.
- Cap reached → `429 { error: 'generation_limit_reached' }`, not a 4xx that
  implies the request itself was malformed.
- Replicate failure → `500 { error: 'generation_failed' }`, and — per the
  fairness rule — no `AiGeneration` row is written, so the creator's quota
  isn't consumed by a provider-side problem.
- No content-moderation layer is built in this pass; reliance is on
  whatever safety filtering the `flux-schnell` model itself applies.
  Revisit if abuse becomes a real, observed problem — not speculatively.

## 5. Testing / verification plan

- Backend: Vitest unit tests for the endpoint with the Replicate adapter
  mocked (matching the existing pattern for `printful.adapter.ts` in
  `webhooks.routes.test.ts`) — cap-reached path, success path (verifies the
  `AiGeneration` row is created and the count logic), and failure path
  (verifies no row is created).
- Live verification: once `REPLICATE_API_TOKEN` is set, a real end-to-end
  call (sign up, generate with a real prompt, confirm a real image comes
  back, add it to a product, confirm the print-file endpoint serves it) —
  same verification style used for Stripe and Printful throughout this
  project. Test data cleaned up afterward.

## 6. Open items for a future pass (not blocking this one)

- Per-generation cost tracking/reporting (currently the cap bounds worst-
  case spend, but nothing surfaces actual dollars spent anywhere).
- Letting a creator choose a different Replicate model/style — this spec
  hardcodes `flux-schnell` as the only option.
- Regenerating from the same prompt with variations ("give me 4 options")
  — this spec is one prompt in, one image out, one at a time.
- Any explicit content-moderation layer beyond the model's own filtering.
