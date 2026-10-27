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

## Round 9 — full repository (2026-10-26)

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 | Keyboard-activated clicks (Enter/Space on a focused button; no pointer position) were resolved to the wrong element in the closed-root shield | Fixed | Keyboard clicks resolve to the focused element; every resolved target must be inside our shadow root. e2e "keyboard activation of our buttons works" |
| A2 | "Continue" on an older draft opened the newest draft for the same selection | Fixed | The chosen draft's text is carried into the composer. e2e "Continue opens exactly the chosen draft…" |
| B1 | Email replies over 10,000 characters were truncated | Fixed | Posted in full as consecutive comments (deterministic ids, idempotent). `email.test.ts` long-reply case |
| C1 | In tabs the extension is injected into after install/update, page listeners registered before our shield can see keystrokes typed in our editors | Fixed | Late-injected instances (shield registered after `document_start`) show threads but disable editors and sign-in with "Reload the page to write comments". Not covered by e2e: Playwright can't install an extension into an already-loaded page |
| C2 | Submitting in one tab deleted another open tab's draft whose text was a prefix of the submission | Fixed | Open tabs' drafts are only consumed on an exact text match. e2e "submitting in one tab doesn't delete another open tab's shorter draft" |

## Round 10 — full repository (2026-10-26)

Reviewer B found nothing material.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 | **The closed shadow root doesn't hide typed text: with focus in our textarea, `document.execCommand('selectAll'); getSelection().toString()` in the page returned the whole draft** | Fixed | Every text field moved into an extension-origin iframe (`input.html`) relayed through the worker; the page can neither read it nor see keystrokes. This also covers round 9's C1 properly, so the "reload to write comments" block on late-injected tabs is gone. e2e "the production build … works with real mouse and keyboard input" now also has a nosy page log keys and try `selectAll`/ranges/`frames[0]` |
| A2 | The late-injection block could be bypassed by restoring a draft | Moot | The block was removed (see A1) |
| C1 | Submitting an older draft via "Continue" deleted the tab's own newer, different draft | Fixed | The tab's own draft is consumed only if the sent text contains it. e2e "submitting in one tab doesn't delete another open tab's shorter draft" and the Continue test |

Found while moving fields into frames (with tests): a field rendered where another had been
(sign-in email → code) reused the iframe with only a new `#hash`, which doesn't reload it; and a
render lagging a keystroke pushed the older value back into the field, dropping characters.

## Round 11 — full repository (2026-10-26)

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| B1 | **Login CSRF: opening someone else's unused magic link silently switched the extension to their account** | Fixed | Links are consumed automatically only for a sign-in this browser started (request id) or the account already signed in; otherwise the verify page asks, and only a trusted click confirms. `api.test.ts` "a link opened by a browser that didn't request it asks first…"; e2e "someone else's sign-in link doesn't switch accounts without asking" |
| C1 | **The page could still read sidebar text (drafts, account email) with `window.find()` + `selectAll` in the closed shadow root** | Fixed | Private text is CSS generated content (invisible to `find`, which is also a true/false oracle, and to selection); the UI is `user-select: none` except public text. e2e (production build) "the page can't find or select your email or drafts", verified to fail without the fix |
| C2 | Typing during a worker restart was dropped, and Enter then sent the stale text and deleted the draft | Fixed | The field resends its whole value when re-attached and holds Enter/Escape until then; submit uses the value the field reports. e2e "typing while the service worker restarts is kept…", verified to fail without the fix |
| A1 | An edited repeated sentence re-anchored onto the unchanged copy elsewhere | Fixed | Near matches in the original surroundings beat an exact copy in different surroundings (strict thresholds; corpus unchanged). Anchoring regressions "an edited repeat stays on its own passage…" and "an unchanged repeat with the right context still anchors exactly" |
| A2 | Clicks on blank space beside a fully highlighted short paragraph (e.g. in a linked card) opened the thread instead of following the link | Fixed | The pointer must be on a highlighted character's box (caret offset + character rects). e2e "a click on blank space beside a highlighted paragraph goes to the page…" |

Also found while fixing C1 (not reported by the reviewers): the page can read the CSS highlight
registry and highlight colors, so it can tell which highlights are yours. Kept as an accepted
limitation (see DECISIONS.md).

## Round 12 — full repository (2026-10-26)

Reviewer B found nothing material.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| C2 | **The content script crashed on plain-HTTP pages: `crypto.randomUUID()` doesn't exist in insecure contexts (the e2e fixtures were all on localhost, which counts as secure)** | Fixed | `uuid()` from `getRandomValues`. e2e "works on plain-HTTP pages" on `insecure.test`; unit test for the ids. Same cause: "Copy text" relied on `navigator.clipboard` and fell back to selecting the text in the page; it is now a button in an extension frame that copies from there. e2e "Copy text copies from the extension frame, also on plain-HTTP pages" |
| A1 / C1 | An unsent edit of a thread's first comment showed as plain (findable) text in the collapsed sidebar row | Fixed | The preview is private whenever the first comment is pending or failed. e2e "an unsent edit of a thread's first comment is private text in the sidebar preview" |
| A2 | The edited-repeat rule never fired for quotes at the start or end of the page (a missing context side counted as a perfect match) | Fixed | Only present context sides count. Anchoring regression "an edited repeat at the very start or end of the page…", verified to fail on the old rule |

Found while checking the round-11 fix visually: keys typed right after Enter (fast typing) went
into the field being sent, leaving a phantom "unsent draft" with the posted text. The field now
locks itself on Enter until the editor confirms. e2e "keys typed right after Enter never end up…",
verified to fail without the lock.

## Round 13 — full repository (2026-10-26)

Reviewers B and C found nothing material.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 | Unsent (offline or failed) comments showed the author name, i.e. your own name, as findable text, so a page could learn who you are before anything was published | Fixed | The author name of unpublished comments and threads is private text too. The production-build privacy e2e now also makes a comment offline and checks the page can't find the name or the text; verified to fail without the fix |

Found while testing environment differences (with tests): on sandboxed pages (CSP `sandbox`, like
raw.githubusercontent.com) our input frames can't run their script, so nobody could sign in or
type. Fields fall back to plain inputs there. e2e "works on sandboxed pages". The plain-HTTP
production smoke test now includes info.cern.ch.

## Round 14 — full repository (2026-10-26)

Reviewer B found nothing material.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| C1 | **A page could define our host's custom element name (`margin-comments-root`) first and keep `attachInternals()`, whose `shadowRoot` exposes the closed root** | Fixed | The host is a plain `<div>` (with `all: initial !important`). The production-build isolation e2e now pre-defines the old name and wraps `attachShadow`, and checks nothing was captured; verified to fail with the custom element |
| A1 / C2 | **Round 13's sandbox fallback put plain inputs in the page, which `sandbox allow-scripts` pages can read** (an opaque origin doesn't mean no scripts), and the 8 s timeout fallback did the same | Fixed | No in-page inputs at all: where frames can't run, each field is a button that opens it in a small extension window over the same relay. e2e on a `sandbox allow-scripts` page: sign in and comment through windows while a page script logs keys (none seen) |

## Round 15 — full repository (2026-10-26)

Reviewers B and C found nothing material.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 | A field reopened in a new extension window (sandboxed pages) started from its initial text, not what had been typed, so continuing could overwrite the saved draft | Fixed | The worker keeps each session's current text (from the field's input and our `set` commands) and starts new windows from it. The sandboxed-page e2e now closes a window mid-reply, reopens it and finishes the reply; verified to fail without the fix |

## Round 16 — full repository (2026-10-26)

Reviewers A and B found nothing material.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| C1 | After a worker restart, "Continue typing" (sandboxed pages) opened a second input window, and typing in the first was silently dropped | Fixed | The worker recovers a reconnecting window's id from the port's sender, so it focuses that window; a field has one live copy, and a superseded copy is told it's closed (and stops reconnecting). Only an explicit close is final, so in-page frames still re-attach after the back/forward cache. e2e "on sandboxed pages, an input window survives a service worker restart and stays the only one"; verified to fail without the fix |

## Round 17 — full repository (2026-10-26)

Reviewer C found nothing material.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| B1 | **Outlook replies (history included unquoted under a `From:`/`Sent:` block) were cut at the header, but the `> quote` line inside our own notification made the parser treat the rest as inline answers, so earlier comments and the thread link were posted as the user's reply** | Fixed | Only "On … wrote:" headers (Gmail, Apple Mail, Thunderbird; localized) recover inline answers; after Outlook separators, forwards and our footer everything is cut. `email.test.ts` "an Outlook reply quoting our notification unquoted posts only the new text" (real notification text, three Outlook layouts); verified to fail without the fix |
| A1 | The saved range/position shortcuts skipped the edited-repeat rule: an edited passage moved past its unchanged copy lost its thread to the copy | Fixed | Shortcut hits are checked against quote matching, which wins when it picks the thread's own edited passage; that rule now also accepts a passage with one side of its context intact (moves change the other). Corpus unchanged. Anchoring regression "an edited repeat that moved past its unchanged copy…"; verified to fail without the fix |

## Round 18 — full repository (2026-10-26)

Reviewer C found nothing material.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| B1 | HTML-only Outlook replies: dropping Outlook's header element left the quoted notification (its siblings) in the text, which was posted | Fixed | The HTML is cut at the client's history marker (Outlook web/desktop/new, Apple Mail, Yahoo, Thunderbird) before conversion. `email.test.ts` "an HTML-only Outlook reply quoting our notification…" (real notification HTML, Outlook web and desktop); verified to fail without the fix |
| A1 | Text inside web components (open shadow roots) couldn't be commented on: no Comment button, and neither describe nor anchoring saw shadow text | Fixed | The text index walks the flat tree (open shadow roots, slots) and maps offsets itself; selections come from `getComposedRanges`; shadow selections get position + quote selectors; hit-testing, mutation observing and highlight styles reach into the roots. Corpus unchanged (the harness now measures positions through the index, since MDN's edited snapshot has declarative shadow roots). e2e "comments on text inside web components" (comment, paint, click, re-render, reload, second user); anchoring regression for shadow and slotted text |

## Round 19 — full repository (2026-10-26)

Reviewer C found nothing material.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 | A click on highlighted link text inside a web component still followed the link (the event target is retargeted to the host) | Fixed | The link is looked up on `composedPath()`. The web-component e2e now comments on a link inside the component and clicks it; verified to fail without the fix |
| A2 | Quote context for text inside a component included its `<style>` text (absent from matching), so short quotes orphaned after CSS changes | Fixed | Context for shadow selections comes from rendered text, as matching sees it. Anchoring regression "a short quote in a component that starts with a <style> survives CSS changes" |
| B1 | Round 18's HTML cut at Apple Mail's `<blockquote type="cite">` dropped answers written below or between quotes in HTML-only replies | Fixed | Only Outlook's unbounded history is cut; blockquotes become `> ` lines so the text rules (inline answers) apply; nested HTML documents are unwrapped first (they made the converter lift quoted content out of the quote). `email.test.ts` "HTML-only Apple Mail / Thunderbird replies…" (bottom-posted, inline, top-posted over our notification, Thunderbird); verified to fail without the fix |

## Round 20 — full repository (2026-10-26)

Reviewer C found nothing material.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 | On pages with web components, light-DOM selections (e.g. slotted text) got light-DOM positions and context while matching uses the rendered text, so a repeated slotted quote could re-anchor in another component | Fixed | On pages with open shadow roots, position and context come from the rendered-text index for every selection (XPath kept as a hint); pages without components are unchanged (corpus unchanged). Anchoring regression "repeated slotted text in identical components…"; verified to fail without the fix |
| B1 | HTML-only Gmail replies: skipping the whole `gmail_quote` / `gmail_extra` wrapper dropped answers written inside it | Fixed | The wrappers are rendered; their blockquotes become `> ` lines and the "On … wrote:" line is handled by the text rules. `email.test.ts` "HTML-only Gmail replies keep answers…"; verified to fail without the fix |

## Round 21 — full repository (2026-10-26)

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 | On pages with web components, a quote built from the index included inline `<script>`/`<style>` text inside the selection (could orphan the thread, or publish page data) | Fixed | Quotes come from rendered text only; positions stay raw. Anchoring regression "on a page with web components, a quote never includes inline script text" |
| A2 | Text placed directly in a shadow root (no element parent) couldn't be commented on (Hypothesis's trimming needs element parents) | Fixed | Selections inside shadow roots are trimmed and described through the index. Anchoring regression "text placed directly in a shadow root…" |
| B1 | HTML-only replies dropped link destinations ("my proposal" without its URL) | Fixed | Links keep their URL unless the text is the URL. `email.test.ts` "HTML replies keep where links go" |
| C1 | Switching accounts directly (e.g. confirming another account's link in another tab) kept the previous account's open name editor and its unsaved text; Enter would save it to the new account | Fixed | The account panel is keyed by account. e2e "switching accounts drops the previous account's unsaved name edit" |

All four regressions verified to fail on the previous code.

## Round 22 — full repository (2026-10-26)

Reviewer C found nothing material.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| B1 | **email-reply-parser's regular expressions are quadratic on some inputs: an authenticated 64 KB reply of repeated digits blocked the server's event loop for ~6 s** | Fixed | The dependency is gone; reply text uses only our own rules (all linear), plus the RFC 3676 `-- ` delimiter it used to provide; input is capped at 200 KB. `email.test.ts` "parses hostile and long input in linear time" (4× the reported input, plain and HTML, under 1.5 s) |
| B2 | email-reply-parser treated any `---`/`===` line as a signature and dropped the text below it | Fixed | Same change. `email.test.ts` "keeps text below separator lines" |
| A1 | Highlights on text placed directly in a shadow root couldn't be clicked (the hit element is the host) | Fixed | Hit-testing keeps the root and accepts its host for root-level text, then checks the character under the caret. e2e "text placed directly in a web component's shadow root can be commented on and clicked"; verified to fail without the fix |

Also: the e2e "a reply that can no longer be saved…" was timing-dependent under load (the queued reply could
land before the other user's delete); the delete now goes straight to the backend while the extensions are offline.

## Round 23 — full repository (2026-10-26)

Reviewer C found nothing material.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 | **Quote context could contain an adjacent inline `<script>`'s data (e.g. JSON with a token) when only the script followed or preceded the passage; selectors are stored and returned to every user** | Fixed | Quote, context and position come from our rendered-text index for every selection; Hypothesis contributes only the XPath hint. Corpus unchanged. Anchoring regression "a thread's stored context never includes an adjacent inline script's data"; verified to fail without the fix |
| B1 | **HTML reply pre-processing (history markers, document unwrapping) used whole-document regexes that were quadratic on malformed HTML (`'<div '.repeat(16000)`: 11 s on the event loop)** | Fixed | One linear pass over the tags; markers are tested per tag (bounded). `email.test.ts` "malformed HTML is processed in linear time"; verified to fail without the fix |
| B2 | **`bareAddress` peeled nested comments one level per pass: a deeply nested From header blocked for 3 s before sender checks** | Fixed | Single-pass parsing of quoted strings and nested comments; headers over 2000 characters are refused. `email.test.ts` "handles deeply nested comments in linear time…"; verified to fail without the fix |

Found while auditing the rest of the email path for the same class of bug (not reported by the
reviewers): the final cleanup `/[ \t]+$/gm` took 38 s on 100,000 spaces followed by a letter.
Trailing whitespace is now trimmed with a loop; the linear-time test covers it.

## Round 24 — full repository (2026-10-26)

Reviewers B and C found nothing material.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 | **Hidden page text (`hidden`, `display:none`, `visibility:hidden`) inside or next to a selection was stored in the quote and context, which every user of the page receives** | Fixed | The text index treats non-rendered text like script text: counted in offsets, never matched, quoted or used as context; a saved range with no rendered text doesn't verify; orphans are retried when something is shown or hidden. Corpus unchanged (the harness now measures rendered text the same way). Anchoring regression "hidden text is never quoted, inside or next to a selection; it anchors again once shown" |

## Round 25 — full repository (2026-10-26)

Reviewers B and C found nothing material. All three findings concern round 24's visibility filter.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 | **Text slotted into a hidden `<slot>` was judged by its (visible) light-DOM parent and could enter stored context** | Fixed | Visibility is judged through the element the text renders in (its assigned slot when slotted) |
| A2 | **A `<textarea>`'s child text (its initial value, possibly cleared or edited since) could enter stored context** | Fixed | Textarea text is treated like script text (counted in offsets, never quoted) |
| A3 | Visible text under `display:contents` (no box of its own) was treated as hidden and couldn't be commented on | Fixed | `display:contents` elements defer to their rendering parent; the visible-copy check uses the same rule |

Anchoring regression "hidden slots and textarea values stay out of selectors; display:contents text can be commented on" covers all three; verified to fail on the previous code. Corpus unchanged.

## Round 26 — full repository (2026-10-26)

Reviewer B found nothing material.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 | **Text in a `display:contents` element with `visibility:hidden` was judged only by its parent and could enter stored context** | Fixed | Visibility is the computed visibility of the element the text renders in (inheritance and overrides right), separate from whether that element is rendered (`checkVisibility`, looking through `display:contents`) |
| A2 | **Text directly inside a closed `<details>` (outside `<summary>`) was judged by the `<details>`, which is visible** | Fixed | A closed `<details>` renders only its summary, also through `display:contents` children |
| C1 | "Continue" on another tab's draft, then typing, overwrote this tab's own different draft for the same selection | Fixed | Before continuing, this tab's own different draft is set aside under a slot no tab owns (still listed). e2e "continuing another tab's draft keeps this tab's own draft…" |

Anchoring regression "hidden display:contents text and closed <details> bodies stay out of selectors" (also checks a visible override and an open `<details>`). All verified to fail on the previous code; corpus unchanged.

## Round 27 — full repository (2026-10-26)

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 | Text inside an element with `content-visibility:hidden` (its box shows, its contents don't) could enter stored context | Fixed | Such contents count as hidden, also through `display:contents`. Added to the hidden-text anchoring regression |
| B1 | A Resend response whose body failed mid-read escaped as a non-retryable error, and the webhook acknowledged it: the reply was lost without redelivery | Fixed | Body reads are inside the retryable network wrapper; the webhook acknowledges only `PermanentEmailError` and answers 503 otherwise. `email.test.ts` (body failing mid-stream; unexpected vs permanent fetch errors) |
| C1 | Unsent drafts older than 60 days were deleted on the next save | Fixed | No age limit; only the newest 2000 are kept (storage safety). e2e "unsent drafts never expire" |
| C2 | Drafts were compared with whitespace collapsed, so drafts differing only in indentation or line breaks were merged, and Continue could overwrite one | Fixed | Exact-text comparison (line endings and ends normalized). e2e "drafts that differ only in whitespace are different drafts" |

All verified to fail on the previous code.

## Round 28 — full repository (2026-10-26)

Reviewers B and C found nothing material.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 | **Text placed directly in a host with a closed shadow root (slotted into a hidden slot, or not slotted at all) was judged by the visible host and could enter stored context** | Fixed | The content script finds closed roots via `chrome.dom.openOrClosedShadowRoot` and judges such children through the slot that shows them (none: not rendered). Anchoring regression "a closed web component's hidden or unslotted children stay out of selectors" |
| A2 | A thread whose passage got collapsed stayed "anchored" (no highlight, no "Text not found") | Fixed | If the hidden passage has no rendered match left, the thread becomes an orphan and retries when something is shown. Anchoring regression "a thread on a passage that gets collapsed is orphaned, and comes back when it opens" |

Both verified to fail on the previous code; corpus unchanged.

## Round 29 — full repository (2026-10-26)

Reviewer A found nothing material.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| B1 | **Deeply nested blockquotes in an HTML-only reply made the converter's output (and memory) explode: 105 KB took 4.7 s and 551 MiB, above the machine's 512 MB** | Fixed | Quote nesting beyond 8 levels is dropped before conversion (text kept), and the converter runs with depth/child limits. `email.test.ts` "deeply nested HTML quotes are converted with bounded time and output"; verified to fail without the fix |
| C1 | **Private text drawn in the page could be probed through page-controlled fonts: a face added under one of our font names, limited to one character, loads when that character is shown** | Fixed | Private text (and your own avatar initial) uses only generic font keywords, which page fonts can't take over. The production-build privacy e2e now runs this probe for "@" (email) and "§" (draft) across all our font names; verified to fail without the fix |

## Round 30 — full repository (2026-10-26)

Reviewers A and C found nothing material. Reviewer B's run was cut off by the model provider's
content filter while it was measuring a denial-of-service lead; its last probe was verified
here and treated as a finding:

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| B1 | **One account could store 200 threads with ~100 KB quotes on a page; listing that page then built a ~79 MB response and ~600 MB of memory (the machine has 512 MB)** | Fixed | Quotes capped at 50,000 characters, selectors at 120 KB, threads at 100 comments; thread lists also paged by size (~2 MB) before serializing; the extension loads at most 20 pages. `api.test.ts` "thread pages are bounded by size, and every thread is still reachable" and "a thread holds at most 100 comments"; both verified to fail on the previous code |

## Round 31 — full repository (2026-10-26)

Reviewer A found nothing material.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| B1 | A long email reply hitting the new 100-comment cap was posted partly (its tail silently dropped) and the webhook reported success | Fixed | Capacity is checked for all parts before posting (all or nothing); a verified sender whose reply can't be posted gets an email with the reason and their full text. `email.test.ts` "an email reply that does not fit a thread posts nothing and goes back to its (verified) sender" |
| C1 | A success response whose body was cut off came back as `null`, so the queued write failed permanently instead of being retried | Fixed | Body read failures and unreadable success bodies are transient (the write is idempotent and retried). `tests/unit/api.test.ts` |

Both verified to fail on the previous code.

## Round 32 — full repository (2026-10-26)

Reviewer C found nothing material.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 | Show/hide through custom attributes (`data-tab`, ARIA) wasn't observed, so a highlight stayed on a hidden tab panel indefinitely | Fixed | All attribute changes are observed (passes are throttled). Anchoring regression "a highlight follows a tab switch made with a custom attribute" |
| B1 | **NUL characters defeated round 30's size accounting (SQLite `LENGTH` stops at NUL): a 72 MB thread page was possible again** | Fixed | Control characters are stripped from stored text; sizes are counted in bytes and doubled for JSON escaping. `email.test.ts` "control characters never reach stored text…" |
| B2 | Email replies over 200,000 characters were silently cut and reported as posted | Fixed | Replies are read up to 2 MB (all parsing is linear); longer ones are refused as a whole and returned to the verified sender. `email.test.ts` "an email too long to read in full is refused…" |

All verified to fail on the previous code.

## Round 33 — full repository (2026-10-26)

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 | **Text in a `contenteditable` editor next to a selection (an unsent rich-text draft) could enter stored context** | Fixed | Editable text is excluded like hidden text. Anchoring regression "text in an editor next to a selection…" |
| B1 | **Received emails were downloaded whole before any check; a burst of large ones could exhaust the 512 MB server** | Fixed | Responses are read with a 12 MB streaming cap (cancelled beyond it) and at most three inbound fetches run at once (503 beyond, Resend redelivers). `email.test.ts` "ResendProvider size cap" and "only a few inbound emails are fetched at once…" |
| B2 | HTML replies the converter had to clip (too many children / too deep) were posted in part | Fixed | The converter's skip marker is detected; such replies are refused whole and returned to the verified sender. `email.test.ts` "an HTML reply the converter has to clip is refused whole…" |
| C1 | Drafts and queued changes could exceed the 10 MB extension storage quota; saves then failed silently | Fixed | `unlimitedStorage` permission; repeated draft-save failures are shown on the page. e2e "a draft that can't be saved on this computer is flagged, not lost silently" |

All verified to fail on the previous code. Corpus: "unchanged" is now 476/476 (two corpus quotes were in editable regions).

## Round 34 — full repository (2026-10-27)

Reviewer C found nothing material.

| # | Finding | Verdict | Fix / test |
|---|---------|---------|------------|
| A1 | **A stored selector with a one-letter quote and 400-character context froze every visitor's tab (each occurrence's context was fuzzy-scored; 8.6 s on a modest page, over a minute on a big one, repeated by orphan retries)** | Fixed | Matching uses at most 64 characters of context and scores at most 2000 occurrences (nearest the old position); the server refuses context over 64 characters. Anchoring regression "a stored selector built to be expensive… anchors or orphans quickly" (112 s before, under 1.5 s after); `api.test.ts` "quote context longer than 64 characters is refused" |
| B1 | **The HTML converter builds the whole tree before its depth limits apply: 800 KB of nested `<div>`s blocked the server 4.4 s (quadratic)** | Fixed | A linear pre-pass flattens nesting beyond 32 levels (text kept) and refuses mails with over 50,000 tags. `email.test.ts` "deeply nested ordinary tags are flattened before conversion"; verified to fail without the fix |

