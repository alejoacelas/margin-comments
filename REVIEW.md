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

## Round 3 — full repository (2026-10-26)

Three focused passes over commit `8cf798b`.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 / C2 | A comment id could be reused by a different submission (cancel while pending, or edit after an interrupted submit); the server treated it as a retry and silently kept the old text | Fixed | Client: a new id whenever the text differs from the previous attempt (replies and new threads). Server: same id with different text is a 409 conflict; *Retry* on a conflict re-sends with fresh ids. `api.test.ts` "a reused id with different text…", e2e "two quick replies are two comments" |
| A2 | Highlights stay on a hidden copy when a responsive layout swaps copies | Fixed | Invisible anchors are re-checked (rate-limited, also on resize); visible copies preferred, with a wider context margin for long quotes. `anchoring/regressions.spec.ts` "…responsive layout swaps copies" |
| A3 | A `<label>` click's follow-up click on its checkbox escaped the shield (untrusted, composed) | Fixed | Untrusted events from our host are hidden from the page but keep their default action. e2e "labels, links and middle clicks…" |
| A4 | Middle-clicking comment links did nothing | Fixed | `auxclick`/`dblclick` only stopped, never replayed. Same e2e |
| B1 | `"<alice@…>" <mallory@…>` parsed as Alice | Fixed | RFC-aware single-mailbox parsing (quoted strings and comments removed; multiple mailboxes rejected). `email.test.ts` `bareAddress` + "display-name spoof" |
| B2 | Google email change broke sign-in (unique `google_sub`) | Fixed | Google identities resolved by subject first; email updated or merged. `google-live.test.ts` "keeps its user when its email changes" |
| B3 / C4 | Subscriptions refused at capacity were acknowledged as installed | Fixed | Server acks installed keys and lists rejected ones; client removes before adding, confirms only acked keys and retries rejected ones. `google-live.test.ts` "acknowledges only subscriptions it installed" |
| B4 | Queued notifications sent after the recipient unsubscribed or lost access | Fixed | Jobs carry user/thread ids; eligibility rechecked right before sending. `email.test.ts` "re-checked at send time" |
| C1 | `updateMe` response could be applied to another account's session | Fixed | Applied only if the session (token and user) is unchanged |
| C3 | Switching accounts dropped drafts still waiting to be saved | Fixed | Drafts carry their author; pending ones are saved under that account before the UI resets |

## Round 4 — full repository (2026-10-26)

Three focused passes over commit `4ff358a`.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 | A comment made right after SPA navigation was saved under the previous page | Fixed | Identity refreshed when the comment starts and kept with the composer. e2e "a comment made right after SPA navigation…" |
| A2 | Class/style toggles that swap responsive copies weren't noticed | Fixed | Observer watches `class`/`style`/`hidden`/`open` attributes and triggers visibility re-checks. `anchoring/regressions.spec.ts` (no explicit `schedule()` any more) |
| A3 | A quick swap back within the rate limit was dropped | Fixed | Due visibility checks are rescheduled, never dropped. Same test (swap back) |
| A4 | `visibility:hidden` text counted as visible | Fixed | Shared `isVisible` (boxes + `checkVisibility`). "text hidden with visibility:hidden…"; corpus harness now selects only visible text |
| B1 | A queued notification could go to an address the account no longer uses | Fixed | Send-time check that the job's address is the account's current one. `email.test.ts` |
| B2 | Google email change onto an existing email account stranded the original account's work | Fixed | Transactional merge into the Google account (comments, threads, memberships, sessions). `google-live.test.ts` "…merges the two, keeping all work" |
| B3 | Daily-quota waits used up the retry budget | Fixed | Quota waits don't count as attempts; jobs give up after 3 days instead. `email.test.ts` "daily-quota waits…" |
| C1 | A previous account's unsaved draft could show in the next account's editor | Fixed | Pending drafts keyed per account; lookups filtered by the current user |
| C2 | Late mutation responses could sign out or feed data to a different (newer) session | Fixed | Deliveries and 401 handling only for the session that made the request |

## Round 5 — full repository (2026-10-26)

Three focused passes over commit after round 4.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 | Resizing back within 10 s left the highlight on a hidden copy | Fixed | Resize (window and body `ResizeObserver`) marks visibility checks due. `anchoring/regressions.spec.ts` "real viewport resizes…both ways" |
| B1 | Google sign-in could take over an account through a reassigned non-Google email address | Fixed | Linking by email only when Google is authoritative (Gmail or matching `hd`); otherwise `email_in_use`; identities never replaced. `google-live.test.ts` "can't take over an email account…", "links…when authoritative…" |
| B2 | Account merges broke earlier reply addresses and unsubscribe links | Fixed (by design change) | Merging removed entirely (see B1) |
| C1 | A stale submission could be queued under a newly signed-in account | Fixed | Mutations carry the account they were typed under; the worker rejects mismatches and the text stays a draft |
| C2 | Drafts typed in two tabs overwrote (or cancel-deleted) each other | Fixed | Drafts carry their tab instance; diverging text from another tab is kept aside; deletes are instance-scoped. e2e "reply drafts typed in two tabs both survive" |
| C3 | Account merges stranded locally queued work | Fixed (by design change) | No merges (B1) |

## Round 6 — full repository (2026-10-26)

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 / C2 | Restored drafts couldn't be discarded after a reload (instance check) | Fixed | Per-tab draft slots; Cancel/Discard delete by the text that was shown. e2e "restored drafts can be discarded…" |
| C1 | Another tab appending to a draft then cancelling erased the original | Fixed | Tabs only write their own slot; deleting by text skips drafts of tabs that are still open. Same e2e |
| A2 | Clicking highlighted link text navigated away | Fixed | Plain clicks on highlighted links open the thread (capture phase, before SPA routers); modified clicks still navigate. e2e "clicking highlighted link text…" |
| A3 | Clipped or covered text still captured clicks | Fixed | Hits must intersect the element actually under the pointer. e2e "clicking where clipped highlighted text would be…" |
| A4 | A new thread was invisible with the sidebar on Resolved | Fixed | Creating a thread switches the filter to Open. e2e "a new thread shows up even if…" |
| B1 | Non-authoritative Google sign-up could pre-hijack an address's future account | Fixed | Google sign-up/link only when Google is authoritative (Gmail, matching `hd`). `google-live.test.ts` "Google can't sign up, link or take over…" |
| B2 | After a Google email change that can't be applied, the old address still logged in to the account | Fixed | The old address is unbound (placeholder, no notifications). `google-live.test.ts` "…the old address stops working…" |

## Round 7 — full repository (2026-10-26)

The first attempt at this round was cut short when the disk filled up (other processes); it
was re-run. A partial finding from the aborted run (discarding an "Unsent drafts" row also
deleted this tab's own draft for the same thread) was verified and fixed first, with a test.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 / C1 | **Open shadow root: page scripts could read the account email, drafts and comments, and drive the UI with synthetic events (post as the user)** | Fixed | Closed shadow root in production builds; test builds opt into an open root. e2e "page scripts can't read or drive our UI in the production build" |
| A2 | Clipped text inside a clickable card captured clicks on the card's blank area and cancelled its navigation | Fixed | Hits must have a caret in the range's text under the pointer and no clipping ancestor cutting that point off. e2e "a click on a card's blank area…" |
| B1 | Bottom-posted and inline email replies were discarded as empty | Fixed | Text after `>`-quoted history is kept when nothing was written above it; unquoted forwards still yield nothing. `email.test.ts` "keeps bottom-posted and inline replies" |
| C2 | Following a thread link on the already-open page did nothing | Fixed | The thread marker is handled even when the page identity is unchanged. e2e "following a thread link on the page that is already open…" |

Also fixed: two send-time notification tests relied on a 1 ms retry racing the queue's own tick
(occasionally flaky); they now set the retry time explicitly.

## Round 8 — full repository (2026-10-26)

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 / C1 | **Regression from round 7: with the closed shadow root, the event shield couldn't see targets inside the UI (`composedPath()` stops at the host), so every click and keystroke in the production UI was swallowed and drafts weren't saved** | Fixed | The content script, which holds the closed root, gives the shield a resolver (shadow-root `elementFromPoint` for pointer events, `activeElement` otherwise); test builds use the same path. New e2e drives the production build with real mouse and keyboard: chip click → typing → draft saved → submit → on the server. "the production build (closed shadow root) works with real mouse and keyboard input" |
| B1 | Inline answers below an introduction were dropped | Fixed | Unquoted lines among `>`-quoted history are kept alongside the text above the header. `email.test.ts` "keeps inline answers below an introduction" |

Lesson recorded in DECISIONS.md: the round-7 isolation test only checked that the page couldn't
get in, not that the user still could; production-mode tests now exercise real input.
