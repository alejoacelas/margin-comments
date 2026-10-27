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
  Hypothesis's RangeSelector as an extra hint. Quote and context are taken from the rendered
  text our matching uses (script/style excluded): selectors are stored and shown to everyone,
  and Hypothesis's own context could include an adjacent inline `<script>`'s data.
- **Matching on whitespace-free text** (with a map back to DOM offsets), excluding
  `<script>/<style>/<noscript>/<template>/<textarea>` (a textarea's children are its initial
  value, not what it shows), fallback content the browser doesn't render (`<canvas>`, `<video>`,
  `<audio>`, `<iframe>`, `<object>`), text in editors (anything under a `contenteditable` editing host,
  including its `contenteditable="false"` chips: someone's unsent writing; the Comment button
  ignores editable text too) and text that isn't rendered (`hidden`, `display:none`,
  `visibility:hidden`, `content-visibility:hidden`, closed `<details>`, hidden slots; judged through the element the text
  renders in, i.e. its slot when slotted (for closed web components found through
  `chrome.dom.openOrClosedShadowRoot`; a child no slot shows isn't rendered), looking through
  `display:contents`). The line is the
  browser's own notion of "rendered", as `innerText` uses it: text that is rendered but
  concealed (transparent, clipped, off-screen, visually hidden for screen readers, same color as
  the background) still counts as page text; excluding it would make anchors flicker during
  fade-ins and differ from what the browser itself reports as the page's text, so re-indentation, minification and `<br>`/block
  changes never break an anchor, and hidden text never ends up in a stored (shared) quote or
  context. Hidden text still counts in offsets. A thread on text the page later hides (a
  collapsed section) is listed as orphaned until it's shown again; show/hide changes trigger a
  retry. That includes a passage whose middle gets hidden while its ends stay visible: after
  show/hide changes or elements being added or removed (at most every 2 s; pure text edits
  such as a ticking counter can't hide anything) each anchor's rendered characters (count plus
  a hash) are compared with what they were.
- **Web components:** the text index walks the page as rendered: open shadow roots in place of
  their host's children, slots showing what's assigned to them (closed roots can't be read, by
  design). Selections inside a component come from `getComposedRanges`, their selectors are
  position + quote (no XPath across shadow boundaries), clicks are hit-tested through the roots,
  their mutations are observed, and our `::highlight` rules are adopted into the component's
  shadow root (page styles don't reach in; a stylesheet, not a DOM node). For pages without
  shadow roots offsets are exactly `textContent` offsets, as before (corpus unchanged). A quote
  that crosses a shadow boundary can't be one Range and isn't supported.
- **Bounded matching cost:** stored selectors come from any user, so matching uses at most 64
  characters of context (the server refuses longer; we store 32) and scores at most 2000
  occurrences of a quote (the nearest to its old position). A selector built to be expensive
  can't freeze the page: only the simple element paths we generate are evaluated as XPath
  (never `document.evaluate`; the server refuses others), and an anchoring pass yields after 50 ms and continues on the next
  one where it stopped, so many threads (a page flooded with them) are anchored in slices and
  none is starved.
- **Repeated quotes are re-checked when the page text changes:** an anchored thread whose quote
  occurs more than once is matched again by context, so it follows its row when a table is
  re-sorted in place (frameworks reuse the row nodes and rewrite their cells), and becomes an
  orphan when its surroundings are gone. A pass cut short by its time budget continues with
  only the entries it didn't reach.
- **Prefer orphaning to mis-anchoring:** fuzzy matches need ≥ 75% quote similarity plus
  context; short exact strings need context unless they're unique on the page and at least 8
  characters (shorter ones, like "Paid" in a table, need context even when unique: the saved
  range and position aren't trusted for them, and they're re-checked when the page text
  changes, so a reused row showing another record orphans them); matches are only
  trusted after the page has stopped changing for 1.5 s (or 6 s passed), and a fuzzy anchor is
  upgraded if the exact text appears later. Orphans always stay listed in the sidebar.
- **Very long quotes** (> 1000 chars without an exact match) are matched by head and tail to
  bound the cost, and the span between is compared in 256-character chunks (each a bounded
  edit distance near its expected place; a chunk not found there is looked for, near-exactly,
  within 2,048 characters, so an inserted or removed paragraph costs only its own length), so a
  50,000-character quote costs milliseconds.
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
- **Shadow DOM, closed mode in production**, attached to `<html>` (outside `<body>`) on a plain
  `<div data-margin-comments>`, with `:host { all: initial !important }` so page rules for `div`
  can't touch it. Not a custom element: a page can define that name first and keep
  `attachInternals()`, whose `shadowRoot` exposes even a closed root. Closed, because with an open root any page
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
  comments (and their author name, which is yours), and labels only your own comments have
  (edit/delete). A closed shadow root doesn't
  hide text from the page's `window.find()`, which also works as an oracle (true/false) that can
  rebuild text a character at a time, nor from `find` + `execCommand('selectAll')`; generated
  content (`content: attr(data-t)`) is invisible to both. The rest of the UI is
  `user-select: none`, except public text (comments, quotes). Test builds render plain text so
  Playwright can read it; production-build e2e tests check that the page finds nothing.
  Private text is drawn only with generic font keywords (`system-ui, sans-serif`): the page
  controls the document's font set and could add a face under one of our font names, limited
  to one character, and watch it load; generic keywords can't be taken over. Since
  private text can't be selected, its "Copy text" button is itself an extension frame that
  copies from inside the frame: the text is never selected in the page, and it works on
  plain-HTTP pages, where content scripts have no clipboard API.
- **Sandboxed pages** (CSP `sandbox`, e.g. raw file hosts) pass the sandbox on to our frames,
  which then can't reach the extension. There (origin `"null"`), or if a frame hasn't started
  after 8 s, each field becomes a button that opens it in a small extension window (same relay,
  closed when the field goes away). Never a plain input in the page: with `sandbox
  allow-scripts` the page still runs scripts that could read it.
- **Plain-HTTP pages are insecure contexts**: content scripts there lack `crypto.randomUUID()`
  and `navigator.clipboard`, so ids come from `getRandomValues` (`src/shared/id.ts`). An e2e
  test runs on `http://insecure.test` (mapped to localhost, which itself counts as secure).
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
  Comment ids derive from the email id, so redeliveries never double-post. A long reply is
  posted as consecutive comments, all or none (checked against the thread's comment cap first);
  a verified sender whose reply can't be posted (thread full or gone) gets an email with the
  reason and their text.
- **Reply text:** our own rules only, each linear in the input: history headers (Gmail/Apple/
  Thunderbird/localized "On … wrote:", after which `>`-quoted history is dropped but answers
  between quotes are kept; Outlook separators and `From:/Sent:` blocks, after which everything
  is dropped), our reply address, the RFC 3676 `-- ` signature delimiter, mobile signatures and
  sign-offs ("Thanks,\nBob"). HTML-only replies are cut at Outlook's history marker and
  converted with blockquotes as `> ` lines and link URLs kept. (email-reply-parser was dropped:
  quadratic regexes on some inputs, and it discarded text below any `---` line.)
- **Testing without Resend:** a fake Resend server implements `POST /emails`,
  `GET /emails/receiving/:id` and delivers Svix-signed `email.received` webhooks, so the e2e
  tests run the real provider, webhook and parsing code.

## Reliability

- **All network from the background worker** (one WebSocket, all fetches), so page CSPs never
  apply and host pages see no failed requests in their console.
- **Outbox in `chrome.storage.local`**: changes are persisted before the UI is told they're
  queued; client-generated UUIDs make every create idempotent (so a response lost or cut off
  mid-body is simply retried); failed changes stay visible with
  Retry / Copy text / Discard.
- **Drafts** saved as you type (debounced), kept until the worker confirms, flushed on
  `pagehide`. Drafts belong to an account and to the tab that wrote them (one slot per tab), so
  tabs never overwrite each other; an editor restores its own tab's draft, else the newest one,
  and the others are listed under "Unsent drafts". "Continue" on another draft first sets this
  tab's own different draft for that key aside (a slot no tab owns), so editing never
  overwrites it. Drafts never expire (only a runaway count is capped at the newest 2000), and
  drafts are compared by exact text (line endings and ends normalized): inner whitespace
  such as indentation is meaningful. Cancel/Discard delete by the text the user was
  looking at, never a different text, and never the draft of another tab that is still open. A
  change is only ever queued under the account it was typed in.
- **Edits carry the text they started from** (captured when the edit begins and kept with its
  draft, not read at submit time: a live update can change the comment meanwhile): the server
  applies an edit only if the comment still has that text (or already has the new text: an idempotent retry); otherwise it's a
  conflict, and the edit stays visible as unsaved with Copy text. A late retry of an old edit
  can't overwrite a newer one made elsewhere.
- **Worker lifecycle:** a 20 s ping keeps the worker alive while pages are open; content scripts
  reconnect and re-introduce themselves when it restarts; fetched thread lists are reconciled with
  live updates (version numbers, tombstones).
- **Re-injection on update:** on install/update the worker injects the content scripts into open
  tabs, and an orphaned old instance removes itself. (Not covered by e2e: Playwright can't reload
  a command-line-loaded extension.)

## Size limits

- **Bounded responses:** a quote is at most 50,000 characters (about 8,000 words), selectors
  120 KB, a thread at most 100 comments of 10,000 characters, so one thread stays near 1 MB
  (each change is sent whole to everyone on the page, and must fit the live connection's
  buffer). Thread lists are paged by count (200) and by size (about 2 MB, at least one
  thread); the extension loads at most 20 pages / 2000 threads per page. Without these, one
  account could fill a page with huge threads and make every visit build tens of megabytes
  (the 512 MB server ran out of memory in review). Sizes are measured in bytes, and stored text
  never contains control characters (other than tab/newline), which would defeat the
  accounting. Email replies are read up to 2 MB of plain text (HTML-only ones up to 200 KB:
  mail clients send a plain-text part too, and the HTML converter's work grows with crafted
  markup); a longer one is refused as a whole
  (the verified sender gets it back), never posted in part; the same when the HTML converter
  has to skip content (too deep or too many children). Before conversion, one linear pass
  flattens element nesting beyond 32 levels (text kept; counted over matched elements only,
  unmatched closing tags are dropped; comments and raw-text elements are skipped as the parser
  does; quoting is kept to one level, all the text rules need); lists and tables convert as
  plain blocks (numbering,
  indentation and cell padding repeat per line and could multiply a crafted email) and refuses mails with over 50,000 tags:
  the converter builds the whole tree first and is quadratic on very deep ones. Received emails over 12 MB aren't
  downloaded, and at most three are fetched at once (Resend redelivers the rest). A returned
  reply carries at most 100,000 characters of the text, and the email worker loads one queued
  message at a time.
- **Extension storage:** `unlimitedStorage`, so drafts and queued changes never hit the 10 MB
  quota; if saving a draft keeps failing anyway, the page says so (the text stays in the editor).

## Groups

- One shared space in v1 (`group_id = 'public'` on every thread), with `groups` and
  `group_members` tables and access checks (`canAccessGroup`) on every read, write, live
  subscription and notification, so private groups only need UI and membership management.
