# Kazii+ Backend — Phase 1

Registration and login for all three account types (Creator / Supplier /
Manufacturer), backed by a real PostgreSQL database. This is the foundation
everything else (products, suppliers, fulfillment) gets built on top of.

## What's actually verified vs. what still needs testing

**Verified:** every file here type-checks as valid TypeScript — I ran `tsc`
against all of it. The only errors it produced were "cannot find module"
errors, which is expected since this sandbox has no network access to run
`npm install`. Once real packages are installed, those resolve.

**Not yet verified:** I have not run this against a real database or made a
real HTTP request to it, because I have no network access here. The first
real test needs to happen after deployment — see the checklist at the
bottom of this file.

## Stack

Same as Vespermark's backend, on purpose — you already know how to operate
this: Node.js, Express, TypeScript, Prisma, PostgreSQL, deployed on Railway.

## Deploying this (step by step)

### 1. Create the GitHub repo

Same pattern as your other repos — create a new one, e.g.
`DDSPLUSMJ40/kazii-backend`, and upload every file in this folder through
GitHub's web UI (drag the whole folder onto the "Add file → Upload files"
screen, keeping the folder structure intact — `src/`, `prisma/`, etc. need
to stay as real subfolders, not flattened).

### 2. Create the Railway project

New Railway project (don't reuse Vespermark's) → add a PostgreSQL database
service → add a second service from your new GitHub repo.

### 3. Set environment variables on the backend service

In Railway's service settings, add:

- `DATABASE_URL` — Railway auto-populates this when you link the Postgres
  service, you shouldn't need to type it by hand
- `JWT_SECRET` — generate a real one, don't ship the placeholder. Easiest
  way: in Railway's own shell/CLI or your terminal, run
  `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
  and paste the output in
- `NODE_ENV` — set to `production`

### 4. Run the first migration

This creates the actual tables in the database from `prisma/schema.prisma`.
From your machine (Windows CMD), using `DATABASE_PUBLIC_URL` the same way
you did for Vespermark:

```
set DATABASE_URL=<paste the DATABASE_PUBLIC_URL from Railway's Postgres service>
npx prisma migrate dev --name init
```

### 5. Deploy

Railway should auto-deploy on push once it's connected to the repo. Confirm
the build command is `npm run build` and the start command is `npm start`.

## Testing it's actually alive

Once deployed, hit the health check first:

```
curl https://<your-railway-url>/health
```

Should return `{"status":"ok"}`. If that works, try a real signup:

```
curl -X POST https://<your-railway-url>/auth/signup ^
  -H "Content-Type: application/json" ^
  -d "{\"email\":\"test@example.com\",\"password\":\"password123\",\"accountType\":\"CREATOR\",\"firstName\":\"Jade\"}"
```

(Windows CMD caret line-continuation shown — same pattern as your Vespermark
curl testing.) A successful response returns a `user` object and a `token`.

## What's next (not built yet)

- **Product endpoints** — the Builder currently only holds product data in
  browser state; nothing persists. Phase 2.
- **Supplier directory + Match Score, server-side** — currently hardcoded
  demo data in the frontend. Phase 3.
- **Fulfillment provider connections** (Printful/Gelato/CJ) — per
  `docs/kazii-fulfillment-integration-spec.md` already written. Phase 4.
  This is a different kind of registration than what's built here — see
  that doc for why.
- **Frontend wiring** — the existing signup forms in the frontend repo's
  `kazii-full-demo.html` (the `screen-auth` panel) currently simulate
  success with a toast and a redirect. They need to actually call
  `POST /auth/signup` and store the returned token. Not done yet — flag if
  you want that wired up next.
