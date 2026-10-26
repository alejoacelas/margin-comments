# Decisions

Choices made while building this without supervision, with the reasoning.

## Stack

- **Backend: Node + Fastify + SQLite (`node:sqlite`) on one Fly machine with a volume.** The
  simplest thing that can be deployed and tested end to end unattended: one process, no external
  database, built-in SQLite (no native modules), in-memory DB for tests. Live updates are an
  in-process WebSocket hub, which is correct only with a single machine; scaling out later means
  moving to Postgres + LISTEN/NOTIFY or similar. Fly volume snapshots are the backup (daily, 5
  days).
- **Extension: MV3, Preact, esbuild.** Preact keeps the content script small (~140 KB unminified)
  and esbuild builds in under a second. No framework in the background worker.
- **Pinned dependencies** at exact versions published at least ~2 weeks before the build (except
  where a newer patch fixed an advisory, e.g. Fastify 5.12.7).

## Anchoring

- **Hypothesis's anchoring code, vendored** (BSD-2) rather than Apache Annotator, because it has
  fuzzy quote matching (approx-string-match scored by prefix/suffix/position), which Apache
  Annotator lacks. Local changes are marked `margin-comments:` in the files.
- **Selectors stored:** TextQuoteSelector (exact, prefix, suffix) + TextPositionSelector, plus
  Hypothesis's RangeSelector as an extra hint.
- **Matching on whitespace-free text** (with a map back to DOM offsets), excluding
  `<script>/<style>/<noscript>/<template>`, so re-indentation, minification and `<br>`/block
  changes never break an anchor.
- **Prefer orphaning to mis-anchoring:** fuzzy matches need ≥ 75% quote similarity plus
  context; short exact strings need context unless they're unique on the page; matches are only
  trusted after the page has stopped changing for 1.5 s (or 6 s passed), and a fuzzy anchor is
  upgraded if the exact text appears later. Orphans always stay listed in the sidebar.
- **Very long quotes** (> 1000 chars without an exact match) are matched by head and tail to
  bound the cost.
- **Exact text elsewhere vs. the edited passage:** Hypothesis takes any exact occurrence over a
  near match. When the only exact copy sits in mostly different surroundings (context < 50%) and
  a near match (≥ 85% of the quote, ≥ 20 chars) sits in the original surroundings (≥ 95% both
  sides), the thread stays on its own, lightly edited passage instead of jumping to the copy.
  The bar is high on purpose: a renamed item in a list of similar items (`setEndAfter` →
  `setEndBefore`) is a different item, and there the exact text wins (corpus unchanged).

## Highlights and UI isolation

- **CSS Custom Highlight API** instead of wrapping text in elements. Nothing is inserted into the
  page, so React/Vue pages never see foreign nodes, page text offsets don't change and nothing
  breaks. Trade-offs: highlights can't receive events (we hit-test the ranges' rects on click and
  hover) and there's no pointer cursor over them. Requires Chrome 105+ (we require 120).
- **Colors:** yellow for threads you started or replied in, a pastel per thread author (Curius's
  name hash bucketed into 12 hues, skipping yellow) otherwise; darker variants on dark pages.
  Resolved threads are not highlighted (Google Docs behavior).
- **Shadow DOM, closed mode in production**, attached to `<html>` (outside `<body>`) as a
  custom element, with `:host { all: initial }`. Closed, because with an open root any page
  script could read the account email, drafts and comments in the UI and drive its controls with
  synthetic events (post as the user). With a closed root the event shield can't see targets
  through `composedPath()`, so the content script gives it a resolver (shadow-root
  `elementFromPoint` / `activeElement`); test builds use the same path. Test builds
  (`--test-open-shadow`) use an open root only so Playwright can find elements; two e2e tests run
  the production build: one checks the page can't get in, the other drives the UI with real
  mouse and keyboard input. The session token never leaves the background worker.
- **Text fields in extension-origin frames** (`input.html`, a web-accessible page): every
  place you type (composer, replies, edits, sign-in email and code, display name) is an iframe
  whose field talks only to the background worker, which relays to the content script that opened
  it (matched by an unguessable session id). A closed shadow root isn't enough for typed text: a
  focused `<textarea>` inside it is still the page's selection, so `execCommand('selectAll')` +
  `getSelection().toString()` read the draft, and page key listeners registered before our shield
  (tabs we were injected into late) saw keystrokes. In a cross-origin frame the page gets neither.
  The parent never pushes back a value the frame itself reported (renders can lag a keystroke);
  a frame that loads twice (the page navigated it) is replaced with a fresh session. Page CSPs
  don't apply to extension frames (tested under `frame-src 'none'`).
- **Private text is drawn as CSS generated content**: your email and name, drafts, unsaved
  comments, and labels only your own comments have (edit/delete). A closed shadow root doesn't
  hide text from the page's `window.find()`, which also works as an oracle (true/false) that can
  rebuild text a character at a time, nor from `find` + `execCommand('selectAll')`; generated
  content (`content: attr(data-t)`) is invisible to both. The rest of the UI is
  `user-select: none`, except public text (comments, quotes). Test builds render plain text so
  Playwright can read it; production-build e2e tests check that the page finds nothing.
- **Accepted limitation: your threads' highlight color.** The CSS Custom Highlight registry and
  highlight colors (`getComputedStyle(el, '::highlight(x)')`) are readable by the page, so a page
  can tell which passages are highlighted as yours (yellow, Curius's look) and, by signing up
  itself, narrow down who you are among those threads' participants. Hiding it means giving up
  the yellow; we kept it.
- **Popover top layer** for the adder, cards, sidebar and launcher, so no page z-index or
  transform can cover or displace them.
- **Event shield** (`early.ts`, at `document_start`): key, pointer, focus, clipboard and input
  events from our UI are stopped at the window before page listeners and replayed (non-composed)
  inside the shadow root. Clicks are not replayed (that would activate twice); they are stopped
  at the shadow host instead.
- **Styles via constructable stylesheets** and fonts loaded as bytes with the FontFace API, so
  strict page CSPs can't block them.

## Look (Curius)

- Blue `#409FFF` "Comment" chip next to the selection, white margin cards with the Google-Docs
  shadow docked right of the text column (or below the highlight when there's no room), Source
  Sans 3 UI text, verdana comment bodies, Lora for quotes, Curius's sidebar row style.
- Comment bodies use 12 px verdana instead of Curius's 11 px for readability; cards are 248 px
  wide (Curius: 200 px) to fit the reply and resolve controls.
- **Enter submits, Shift+Enter adds a line** (Curius behavior), with IME composition respected.
- A small avatars bubble at the top right (Curius's presence bar) opens the sidebar when the
  page has open threads; the toolbar icon always toggles it and shows the open-thread count.

## Pages and URLs

- Page key = host + path (+ query, + hash route) without scheme, trailing slash, tracking params
  (`utm_*`, `fbclid`, `gclid`, `mc_*`, … plus a few host-specific ones like Substack's `r`) or
  fragments. `www.` is kept (sites usually redirect consistently and canonical links cover it).
- **Two keys per page:** the canonical link (if it's sane) and the page's own URL. Threads are
  stored under the first and found by either, so a canonical tag that loads late or disagrees
  with the address bar can't hide threads. Canonicals that point every page at the site root, or
  drop a hash route, are ignored.
- Email links open threads with `#margin-comments=<id>` (never sent to the site); for
  hash-routed apps a `?margin-comments=<id>` query parameter that is stripped from page keys.
- Top frame only in v1 (no iframes).

## Sign-in

- **Email code + magic link** in one email. The code works on any device; the link signs in the
  Chrome where the extension is installed (our content script picks the one-time token out of the
  verify page's fragment, so the server page has no scripts). Codes: 6 digits, 5 attempts, 20
  minutes, HMAC-hashed; link tokens SHA-256 hashed, single use. A link signs in automatically
  only in the browser that asked for it (the worker remembers its sign-in request ids, and the
  server consumes the token only for a matching id) or for the account already signed in;
  otherwise the page asks "Sign in as …?" and needs a real click, so someone can't send you their
  link and have your comments go to their account (login CSRF). Sessions: random bearer tokens
  stored hashed, 180-day sliding expiry.
- **Google sign-in only for addresses Google is authoritative for**: Gmail, or a Workspace
  account whose `hd` claim matches the domain. For other addresses Google's `email_verified` only
  means the address was verified at some point, so a previous owner of a reassigned mailbox could
  pre-create or take over the new owner's account; those users are asked to use the email code.
  A Google identity is its stable subject; it follows an email change only to a free address
  Google is authoritative for, and otherwise the old address is unbound from the account (so the
  mailbox's next owner can't sign in to it or receive its notifications). Accounts are never
  merged and an existing Google identity is never replaced (an earlier merge-on-collision design
  broke reply addresses and stranded queued work).
- **Google sign-in is built but off**: it needs an OAuth client registered in Google Cloud,
  which can't be done unattended. Flow: `chrome.identity.launchWebAuthFlow` → server-side
  authorization code + PKCE → session token returned to the extension's `chromiumapp.org`
  redirect, only for configured extension ids. Tested against a fake Google.
- **Until real email is configured, the server stores emails in an "outbox"** viewable at
  `/admin/outbox` with the admin password, so Alejo can sign in and test now without anyone else
  being able to. A stable extension id (public `key` in the manifest) makes allow-listing work.

## Email

- **Provider interface** with Resend (HTTP API) and the outbox. Switching is automatic when
  `RESEND_API_KEY` and `EMAIL_DOMAIN` are set.
- **Durable queue** in SQLite, written in the same transaction as the comment, retried with
  backoff, and sent with an `Idempotency-Key`, so a crash can neither lose nor duplicate a
  notification.
- **Who is notified:** everyone who started or replied in the thread (live comments), except the
  author of the new comment, people who turned notifications off, and (later) people without
  access to the thread's group. One email per reply, threaded per thread with `References`.
  One-click unsubscribe (`List-Unsubscribe`).
- **Reply-to address** `r-<thread>-<user>-<sig>@REPLY_DOMAIN`: thread UUID and user id in
  lowercase base32 plus an 80-bit HMAC (58-character local part, case-insensitive, no `+`).
- **Inbound:** Svix signature verified on the raw body; the email is then fetched from Resend
  (the webhook has no body). Accepted only if the address verifies, the `From` matches the
  account, and Resend's own SPF/DKIM/DMARC verdict is positive (the message's
  Authentication-Results header is sender-controlled and ignored). Auto-replies are ignored.
  Comment ids derive from the email id, so redeliveries never double-post.
- **Reply text:** our own cut rules (Gmail/Apple/Outlook/localized "On … wrote:" headers, `>`
  quotes, our reply address) then crisp-oss/email-reply-parser, then signature and sign-off
  stripping ("Thanks,\nBob").
- **Testing without Resend:** a fake Resend server implements `POST /emails`,
  `GET /emails/receiving/:id` and delivers Svix-signed `email.received` webhooks, so the e2e
  tests run the real provider, webhook and parsing code.

## Reliability

- **All network from the background worker** (one WebSocket, all fetches), so page CSPs never
  apply and host pages see no failed requests in their console.
- **Outbox in `chrome.storage.local`**: changes are persisted before the UI is told they're
  queued; client-generated UUIDs make every create idempotent; failed changes stay visible with
  Retry / Copy text / Discard.
- **Drafts** saved as you type (debounced), kept until the worker confirms, flushed on
  `pagehide`. Drafts belong to an account and to the tab that wrote them (one slot per tab), so
  tabs never overwrite each other; an editor restores its own tab's draft, else the newest one,
  and the others are listed under "Unsent drafts". Cancel/Discard delete by the text the user was
  looking at, never a different text, and never the draft of another tab that is still open. A
  change is only ever queued under the account it was typed in.
- **Worker lifecycle:** a 20 s ping keeps the worker alive while pages are open; content scripts
  reconnect and re-introduce themselves when it restarts; fetched thread lists are reconciled with
  live updates (version numbers, tombstones).
- **Re-injection on update:** on install/update the worker injects the content scripts into open
  tabs, and an orphaned old instance removes itself. (Not covered by e2e: Playwright can't reload
  a command-line-loaded extension.)

## Groups

- One shared space in v1 (`group_id = 'public'` on every thread), with `groups` and
  `group_members` tables and access checks (`canAccessGroup`) on every read, write, live
  subscription and notification, so private groups only need UI and membership management.
