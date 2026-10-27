# Margin Comments

Google Docs-style comment threads on any web page, as a Chrome extension. Select text, click
**Comment**, and talk about it in the margin. Threads are shared live with everyone signed in
who visits the same page, and replies arrive (and can be answered) by email.

**Retired on 2026-10-27.** The hosted backend at margin-comments.fly.dev has been shut down, so the steps below work only against a backend you deploy yourself (see `AGENTS.md`).

## Try it

1. Download `margin-comments-extension.zip` from the
   [latest release](https://github.com/alejoacelas/margin-comments/releases/latest) and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the
   unzipped folder.
3. On any web page, click the Margin Comments toolbar icon (pin it from Chrome's puzzle-piece menu)
   and sign in with your email. Until real
   email is turned on (below), your 6-digit code is at
   <https://margin-comments.fly.dev/admin/outbox> (user `admin`, password in 1Password:
   `ADMIN_TOKEN — margin-comments`, vault `mac-agents`).
4. Select some text and click **Comment**.
5. Open the same page in a second Chrome profile (signed in as another email) to watch threads,
   replies and resolutions arrive live.

## Turn on real email

The backend sends through [Resend](https://resend.com) as soon as `RESEND_API_KEY` and
`EMAIL_DOMAIN` are set; until then every email is kept in the password-protected outbox above.
Reply-by-email needs Resend's inbound webhooks too. Steps (about 20 minutes, most of it DNS):

1. **Create a Resend account** at <https://resend.com/signup>.
2. **Add a domain**: Resend → *Domains* → *Add domain*. Use a subdomain you control, for example
   `mail.example.com` (a subdomain keeps it clear of any existing email on the root domain).
3. **Add the DNS records Resend shows** for that domain (copy the exact values from the
   *Records* tab), then click *Verify DNS Records*:
   - DKIM: `TXT resend._domainkey.mail.example.com` → the `p=...` key shown.
   - SPF: `MX send.mail.example.com` → `feedback-smtp.<region>.amazonses.com` (priority 10) and
     `TXT send.mail.example.com` → `v=spf1 include:amazonses.com ~all`. (Newer domains may show
     two CNAMEs instead; use whatever the Records tab lists.)
   - Optional DMARC: `TXT _dmarc.mail.example.com` → `v=DMARC1; p=none;`
4. **Turn on receiving** for the same domain: open the domain → *Receiving* toggle. Add the MX
   record it shows on `mail.example.com` itself (value like `receive.forge.rmta.net` or
   `inbound-smtp.<region>.amazonaws.com`, priority 10; it must be the lowest priority MX on that
   name). Click *I've added the record*.
5. **Create an API key** with **Full access** (Resend → *API Keys*). Full access is required:
   reading the body of a received reply (`GET /emails/receiving/{id}`) fails with a
   sending-only key.
6. **Create a webhook**: Resend → *Webhooks* → *Add endpoint*, URL
   `https://margin-comments.fly.dev/webhooks/resend`, event `email.received`. Copy its signing
   secret (`whsec_...`).
7. **Save both secrets in 1Password** (vault `mac-agents`) as `RESEND_API_KEY — margin-comments`
   and `RESEND_WEBHOOK_SECRET — margin-comments`.
8. **Set them on Fly** (this redeploys automatically):

   ```sh
   fly secrets set --app margin-comments \
     RESEND_API_KEY=re_... \
     RESEND_WEBHOOK_SECRET=whsec_... \
     EMAIL_DOMAIN=mail.example.com
   ```

   Optional: `EMAIL_FROM="Margin Comments <notifications@mail.example.com>"` (the default) and
   `REPLY_DOMAIN` if replies should go to a different receiving domain than `EMAIL_DOMAIN`.
9. **Check**: `curl https://margin-comments.fly.dev/api/config` should say `"emailMode":"resend"`.
   Sign out and back in with your real address; have someone reply in a thread you started and
   answer the notification email. Your reply appears in the thread.

If replies are refused, `fly logs --app margin-comments` shows the reason (`inbound email … rejected`).
Replies must come from the address the notification went to, and Resend must report SPF/DKIM/DMARC
passing for it. If your provider has no SPF/DKIM at all, you can set
`INBOUND_REQUIRE_SENDER_AUTH=false` (the signed reply address still blocks forgeries).

### Optional: Google sign-in

1. In Google Cloud Console create an OAuth client of type *Web application* with authorized
   redirect URI `https://margin-comments.fly.dev/api/auth/google/callback`.
2. `fly secrets set --app margin-comments GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...`
   (and save both in 1Password). The sign-in panel then shows *Continue with Google*.

## What it does

- **Comment on any text.** Select text, click **Comment**, write. The text stays highlighted
  (yellow for threads you're in, a pastel per author otherwise, like Curius). Click a highlight
  to open its thread in the margin.
- **Threads like Google Docs.** Reply, edit and delete your own comments, resolve and reopen.
  Deleting the first comment deletes the thread; replying to a resolved thread reopens it.
- **Sidebar.** The toolbar icon (or the avatars bubble at the top right) opens a sidebar listing
  every thread on the page in document order, with Open/Resolved filters, threads whose text
  can't be found anymore ("Not found on this page"), unsent drafts and anything that couldn't be
  saved.
- **Shared and live.** Everyone signed in sees the same threads on the same page, updated over a
  WebSocket. Pages are matched by `<link rel=canonical>` and by their own URL with tracking
  parameters (`utm_*`, `fbclid`, `gclid`, …) and fragments removed.
- **Email.** When someone replies in a thread you started or replied in, you get an email with
  the highlighted quote, the new reply and a link that opens the page with the thread. Reply to
  the email to post into the thread: quoted history and signatures are stripped, the sender must
  match the account, and each reply-to address is signed per user and per thread.
- **Sign-in** with an emailed code or link, or Google (when configured).

## Reliability

Reliability was the main goal. Highlights:

- **Anchoring** uses Hypothesis's anchoring code (BSD-2) with W3C TextQuote + TextPosition (+
  Range) selectors, matching on a whitespace-insensitive projection of the page so reformatting
  never breaks an anchor. Fuzzy matches must pass a threshold, so a thread is shown as orphaned
  rather than on the wrong sentence. Threads re-anchor on DOM changes (throttled), on late
  renders, infinite scroll, SPA navigation and text inside web components (open shadow roots). On an 18-page corpus of real pages and edited
  versions, same-page anchoring is 743/743 and text that survives an edit is re-found 476/476
  (`tests/anchoring/corpus/README.md`).
- **No page breakage**: highlights use the CSS Custom Highlight API (no elements are inserted
  into the page), all UI lives in a closed Shadow DOM in the browser's top layer, keyboard and
  mouse events from the UI never reach page handlers, and strict-CSP pages work.
- **Pages can't read you**: page scripts can't see into the UI, and everything you type goes
  into extension-origin frames, so a page can't read your drafts or log your keystrokes.
- **Nothing you type is lost**: drafts are saved as you type and survive closing the tab;
  changes go to a persistent outbox in the extension and are retried until the server accepts
  them (offline, server down, service worker restarted); anything that can't be saved stays
  visible with *Copy text*.
- **Tests**: 63 end-to-end Playwright tests with the real extension (two users, live sync,
  email notify and reply through a fake Resend, offline, service worker restart, SPAs, CSP,
  hostile pages, account switching, the closed production build, plain-HTTP and sandboxed pages), 106 server/unit tests, the anchoring corpus plus anchoring
  regression and large-page performance tests, and a production smoke test on real sites
  (Wikipedia, GitHub, Hacker News, MDN). Every adversarial review round is logged in
  [`REVIEW.md`](REVIEW.md); the 51st full Codex round found nothing material.

## Development

```sh
npm ci
npm run build          # dist/ (extension, production API) + build/server
npm test               # typecheck + unit/server tests + e2e + anchoring corpus
npm run dev:server     # local backend on :8787 (email goes to the outbox)
node scripts/build-extension.mjs --api http://localhost:8787 --out build/ext-local --no-zip
```

More in [`AGENTS.md`](AGENTS.md) (commands, deploy, secrets) and
[`DECISIONS.md`](DECISIONS.md) (why things are the way they are). Review history:
[`REVIEW.md`](REVIEW.md).

## Credits

Anchoring code adapted from [Hypothesis](https://github.com/hypothesis/client) (BSD-2-Clause,
`src/extension/content/anchoring/hypothesis/`). Fonts: Source Sans 3 and Lora (SIL OFL).
Look and feel modeled on [Curius](https://curius.app).
