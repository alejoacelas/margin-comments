# Adversarial review log

Codex (`codex exec`, read-only instructions) reviews the repository after each
milestone. Every finding is verified by reading the code (and usually by
reproducing it) before acting. Fixed findings get a regression test; rejected
ones get a one-line reason.

## Round 1 — anchoring, threads UI, backend, email (2026-10-26)

Three focused passes over commit `9440693`: (A) anchoring and content script,
(B) backend security and correctness, (C) reliability, sync and fidelity.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 | Event shield replays `click`, so checkboxes toggle twice and forms submit twice | Fixed | Clicks are no longer replayed; they activate once and are stopped at the shadow host. `regressions.spec.ts` "checkboxes and forms … exactly once" |
| A2 / C1 | Reply editor reused across threads; text typed for thread A posts to B | Fixed | Thread views and editors keyed by thread id; editors read unconfirmed drafts. "switching threads never carries reply text over" |
| A3 | Orphan skipped during backoff gets no retry timer; late text on a quiet page never anchors | Fixed | Manager schedules the earliest orphan retry; earlier passes preempt later timers. "a thread anchors when its text appears once…" |
| A4 | Hit-test geometry not invalidated by DOM/layout changes | Fixed | Every anchoring pass and a body `ResizeObserver` invalidate geometry and re-position cards. "clicking a highlight works after the layout shifts" |
| A5 | Quotes include `<script>`/`<style>` text that the matcher excludes | Fixed | Quotes, context and verification exclude non-content elements. "selections spanning an inline script survive…" |
| B1 | Root comment chosen by `created_at, id`; same-millisecond reply could delete the whole thread | Fixed (also found by our own test) | Comments ordered by insertion (`rowid`). `api.test.ts` "only authors can edit or delete…" |
| B2 | Idempotent retries skip group access checks | Fixed | Access checked before returning existing thread/comment. `api.test.ts` "private groups…" |
| B3 | Live sockets keep receiving after session/membership ends; re-auth keeps old subscriptions | Fixed | Heartbeat re-validates sessions, re-auth clears subscriptions, delivery checks group access. `google-live.test.ts` "stops delivering when the session ends" |
| B4 | Removed group members still emailed | Fixed | Recipients filtered by current access. `api.test.ts` "private groups…" |
| B5 | Inbound sender authentication fails open | Fixed | Requires Resend's positive SPF/DKIM/DMARC verdict (`INBOUND_REQUIRE_SENDER_AUTH`, default on); message headers ignored. `email.test.ts` forgery cases |
| B6 / C5 | Query param decoded twice; keys with `,` `%20` `%2F` break | Fixed | Repeated `key=` params decoded once. `api.test.ts` "page keys with commas, escapes and unicode…" |
| B7 | `Fly-Client-IP` trusted without a proxy; rate limits bypassable | Fixed | Forwarding header only honored when `TRUST_PROXY`; otherwise socket address. `api.test.ts` "ignores spoofed client-IP headers…" |
| B8 | Comment committed before its notification jobs | Fixed | Comment and email jobs in one transaction. `email.test.ts` "a comment and its notifications commit together" |
| C2 | Stale thread fetch overwrites live updates / resurrects deletions | Fixed | Load generations, version-max merge, tombstones, keep threads that arrived live during the fetch |
| C3 | Deleting a pending thread can't cancel an in-flight create | Fixed | Also queues an idempotent server delete |
| C4 | Draft saves dropped on RPC failure; submit cancels the pending save | Fixed | Drafts stay queued until acknowledged, retried on reconnect; restored if submit fails |
| C6 | More than 10 page keys per subscribe message silently dropped | Fixed | Client batches to the server's per-message limit |
| C7 | Optimistic projection mutates server comment objects | Fixed | Projection clones comments. `store.test.ts` |
| C8 | Reply/edit drafts and failed edits hidden when their thread/comment is deleted | Fixed | Sidebar lists orphaned drafts and stranded ops. "a reply draft stays recoverable…" |
| C9 | Shell canonical merges hash-routed pages | Fixed | Canonical ignored when it drops the route. `url.test.ts` |
| C10 | Email links can't open threads on hash-routed pages | Fixed | Query-param form (`?margin-comments=<id>`) stripped from page keys. `url.test.ts` |
| C11 | Corpus anchoring tests missing | Accepted | Corpus was still being collected at review time; added in the next commit |

Also found while writing tests this round (not by Codex): the UI store missed
updates that arrived between first render and subscription (email links
sometimes didn't open the thread), and the email queue could tick after
shutdown closed the database. Both fixed with tests.

## Round 2 — full repository (2026-10-26)

Three focused passes over commit `bfbb450` (same split as round 1).

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 | Saved range/position selectors trusted for a repeated phrase; content inserted above shifts them to the wrong occurrence | Fixed | Shortcuts only when the quote is unique on the page; otherwise context matching. `anchoring/regressions.spec.ts` "a repeated phrase re-anchors…" |
| A2 | A page's capture-phase click listener can swallow clicks on our UI | Fixed | UI clicks stopped at the window before page listeners, original activation cancelled, one non-composed copy replayed in the next task. "our buttons work on a page whose capture listeners swallow clicks" |
| A3 | CSS transforms (attribute-only changes) leave stale hit-test boxes | Fixed | Clicks always re-measure; hover cache lives 250 ms. "clicks still hit highlights after a CSS transform…" |
| A4 | Fuzzy anchors only upgrade when page text length changes | Fixed | Mutation-driven dirty flag; rate-limited checks stay pending. `anchoring/regressions.spec.ts` "a fuzzy anchor upgrades…" |
| B1 | DMARC "gray" + SPF pass accepted a forged From | Fixed | Accept DMARC pass or (From-aligned) DKIM pass only; SPF alone rejected. `email.test.ts` "spf-only" case |
| B2 | Slow WebSocket readers can queue unbounded memory | Fixed | 2 MB buffered limit per socket (terminate), 30 sockets per user. `google-live.test.ts` "drops readers that stop reading" |
| B3 | Same email delivered again with a new provider id posts twice | Fixed | Comment id derived from account + Message-ID. `email.test.ts` replay case |
| B4 | Thread listing silently capped at 1,000 | Fixed | Cursor pagination (`after`/`next`); the extension fetches all pages. `api.test.ts` "lists every thread of a busy page…" |
| C1 | Unsent ops and drafts visible to the next account in the same browser | Fixed | Ops/drafts scoped to the account; local pending drafts cleared on account change. "one account's unsent work never shows up…" |
| C2 | Submitting one editor deletes another editor's draft (two editors for one thread; other tabs) | Fixed | One editor per thread per page (no floating card while the sidebar shows the thread); drafts deleted only if the stored text is what was submitted. "a thread selected in the sidebar has exactly one editor…" |
| C3 | Typing while a submit is pending loses the extra text | Fixed | Editor read-only while submitting; local draft kept if it differs from what was sent |
| C4 | Catch-up fetch can race the subscription | Fixed | Server acknowledges subscriptions; the extension fetches the snapshot after the ack. `google-live.test.ts` ack assertion |
| C5 | A failed thread fetch is never retried while the socket is online | Fixed | Per-page retry with backoff and generation checks |
| C6 | Margin cards can extend below the viewport | Fixed | Vertical clamping in both placements. `unit/place-card.test.ts` |

Found while re-running the suite this round (not by Codex): on install, the worker could inject
a second content-script copy into a tab that loaded during installation (the copy replaced the
first and closed its sidebar). The worker now skips tabs whose content script is already
connected; the e2e suite passed 3× in a row afterwards.
