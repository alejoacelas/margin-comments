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
