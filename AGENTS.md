# AGENTS.md

Guide for agents (and humans) working on this repo.

## Layout

```
src/shared/            URL normalization (page keys), API types and limits
src/server/            Fastify + node:sqlite backend
  app.ts               routes; config.ts env; db.ts schema/migrations
  users.ts threads.ts  data access; live.ts WebSocket hub; google.ts OAuth
  email/               provider.ts (Resend + outbox), queue.ts (durable jobs),
                       templates.ts, reply-token.ts (signed reply-to),
                       reply-parse.ts (strip quotes/signatures), inbound.ts (webhook)
src/extension/
  background/          MV3 service worker: session, outbox, drafts, live socket
  content/             early.ts (event shield, document_start), index.tsx (controller),
                       anchoring/ (Hypothesis code + our anchor.ts/manager.ts),
                       highlights.ts (CSS Custom Highlight API), ui/ (Preact, Shadow DOM)
  extension-key.json   public key -> stable extension id igipapgffolpgikiojpjbpdngefekkbg
scripts/               build-extension.mjs, build-server.mjs, render-icons.mjs
tests/unit, tests/server   vitest
tests/e2e              Playwright with the unpacked extension (two users, fake Resend)
tests/anchoring        corpus test + saved pages (see corpus/README.md)
tests/smoke            production smoke test (not in `npm test`)
tests/support/servers.mjs  fake Resend, offline proxy, fixture pages (started by Playwright)
```

## Commands

```sh
npm ci                     # install (Node >= 22.13; dev uses Node 26, the image Node 24)
npm run build:ext          # dist/ + margin-comments-extension.zip (API https://margin-comments.fly.dev)
node scripts/build-extension.mjs --api http://localhost:8787 --out build/ext-local --no-zip
npm run build:server       # build/server/index.js
npm run dev:server         # backend on :8787, SQLite in ./data, email -> outbox
npm run typecheck
npm run test:unit          # vitest: tests/unit + tests/server (~1 s)
npm run test:e2e           # Playwright e2e (~1 min); builds build/ext-test itself
npm run test:anchoring     # corpus (~10 s)
npm test                   # all of the above
npm run test:smoke         # against production (own build with an open shadow root); needs ADMIN_TOKEN (source .env)
```

The e2e build (`build/ext-test`) uses an open shadow root so Playwright can drive the UI;
production builds use a closed one (`build/ext-test-closed` is the same build closed, for the
isolation test).

Playwright starts everything it needs (`playwright.config.ts`): the backend on 18787 with an
in-memory DB, a proxy on 18788 (the extension's API; `/_test/network` cuts it to simulate
offline), the fake Resend API on 18901 and fixture pages on 18902. Run `HEADED=1` to watch.

## Deploy

Backend: Fly.io app `margin-comments` (personal org), region `lhr`, one machine, SQLite on the
`data` volume (daily snapshots, 5 days).

```sh
set -a; . ./.env; set +a          # FLY_API_TOKEN (personal identity)
npm run deploy                    # fly deploy --remote-only --app margin-comments
fly logs --app margin-comments
fly secrets set --app margin-comments KEY=value   # redeploys
```

Extension: `npm run build:ext`, then attach `margin-comments-extension.zip` to a GitHub release
(`gh release create vX.Y.Z margin-comments-extension.zip`). Bump `version` in `package.json`
first; it becomes the manifest version.

## Secrets

Never commit secrets. Local copies live in the ignored `.env` (quote values: the Fly token
contains a space). Production values are Fly secrets. Source of truth is 1Password, vault
`mac-agents`:

| Variable | Where | 1Password item |
|---|---|---|
| `FLY_API_TOKEN` | `.env` (local deploys) | `FLY_PERSONAL_TOKEN — personal account` (field `credential`) |
| `APP_SECRET` | Fly secret, `.env` | `APP_SECRET — margin-comments` (HMAC key: reply addresses, unsubscribe links, login codes) |
| `ADMIN_TOKEN` | Fly secret, `.env` | `ADMIN_TOKEN — margin-comments` (password for `/admin/outbox`, user `admin`) |
| `RESEND_API_KEY` | Fly secret (not set yet) | `RESEND_API_KEY — margin-comments` (create when turning on email; full access) |
| `RESEND_WEBHOOK_SECRET` | Fly secret (not set yet) | `RESEND_WEBHOOK_SECRET — margin-comments` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Fly secret (optional, not set) | `GOOGLE_OAUTH_CLIENT_SECRET — margin-comments` (create if enabling Google) |

Non-secret config is in `fly.toml` `[env]`: `PUBLIC_URL`, `DATABASE_PATH`, `TRUST_PROXY`,
`EXTENSION_IDS`. `EMAIL_DOMAIN`, `REPLY_DOMAIN`, `EMAIL_FROM` are set with the Resend secrets.
Other knobs (see `src/server/config.ts`): `SESSION_DAYS`, `LOGIN_IP_LIMIT`,
`INBOUND_REQUIRE_SENDER_AUTH`, `EMAIL_WORKER_INTERVAL_MS`.

The extension private key is in the ignored `keys/extension-key.pem`; only the public key
(`src/extension/extension-key.json`) is needed to load the unpacked extension with a stable id.

## Conventions

- Every bug fix gets a regression test. Adversarial review findings go in `REVIEW.md`.
- Decisions with trade-offs go in `DECISIONS.md`.
- Commit early and often; push after every commit.
- Don't add DOM nodes to host pages; UI goes in the shadow root, highlights in CSS highlights.
