# Build: margin-comments

Build a Chrome extension that brings Google Docs-style comment threads to any web
page. Alejo will not supervise this build: make reasonable decisions yourself,
record them in `DECISIONS.md`, and keep going until the finish criteria below are
met. Do not stop to ask questions.

Repository: https://github.com/alejoacelas/margin-comments (public, already
created, empty). Clone it to `~/best/projects/2026-10-26-margin-comments`. This
brief is saved there as `BRIEF.md`; commit it. Commit early and
often, and push after every commit. Never commit secrets.

## What it does

1. Select text on any web page, click a small button that appears by the
   selection, and start a comment thread anchored to that text.
2. The anchored text stays highlighted. Clicking a highlight opens its thread;
   threads also appear in a sidebar listing every thread on the page.
3. Threads support replies, editing and deleting your own comments, and
   resolving/reopening, like Google Docs.
4. Threads are shared: every signed-in user who visits the same page sees the
   same threads, live. Normalize URLs (prefer `<link rel=canonical>`, strip
   tracking parameters like `utm_*`, `fbclid`, fragments).
5. Email notifications: when someone replies in a thread you started or replied
   in, you get an email with the anchored quote, the new reply, and a link back
   to the page that opens the thread. Replying to that email posts your reply
   into the thread (strip quoted history and signatures; verify the sender
   matches the account; use a per-user, per-thread signed reply-to address so
   replies cannot be forged).
6. Sign-in with an email magic link or Google. Keep the data model ready for
   private groups later, but v1 is one shared space.

## Inspiration and look

[Curius](https://curius.app) is the model, both for behavior and aesthetic. Study
its site, Chrome Web Store listing and screenshots, and imitate its look as
closely as you can: its typography, highlight colors, quiet minimal popovers and
sidebar. Inject all UI inside a Shadow DOM so host pages cannot break it and it
cannot break them.

## Anchoring

Use proven open-source anchoring rather than writing your own. Good options:
Hypothesis's anchoring code (BSD-2, `hypothesis/client`, `src/annotator/anchoring`)
or Apache Annotator (`@apache-annotator/dom`), storing W3C Web Annotation
selectors: TextQuoteSelector (exact + prefix + suffix) plus TextPositionSelector,
with fuzzy re-anchoring when the page has changed. Threads whose text can no
longer be found must still appear in the sidebar as "orphaned", never vanish.
Handle pages that render late or change after load (SPAs, infinite scroll) by
re-anchoring on DOM mutations, throttled.

## Backend

Pick the simplest stack you can deploy and test end to end unattended. Fly.io is
available: load `FLY_PERSONAL_TOKEN` with
`~/.local/bin/op-agent` (vault `mac-agents`, item
"FLY_PERSONAL_TOKEN — personal account") into an ignored `.env`, and record in
`AGENTS.md` where each variable lives in 1Password. Use the personal identity for
every cloud write.

For email, use Resend for sending and inbound replies (inbound webhooks). There
is no Resend key or sending domain available yet. Build the email path fully,
behind a provider interface, test it end to end against a local fake (for
example Mailpit or a test double that exercises the real inbound webhook
parsing), and make the deployed backend switch to Resend as soon as
`RESEND_API_KEY` and `EMAIL_DOMAIN` are set. Write the exact steps Alejo must
take to turn real email on (Resend account, domain DNS records, secrets to set)
in the README.

## Reliability target: as reliable as Curius

Treat reliability as the main goal. At minimum:

1. Automated end-to-end tests with Playwright loading the unpacked extension in
   Chromium, covering: create thread, reply, edit, delete, resolve, reload page
   and see threads re-anchored, second user sees threads live, email
   notification sent, email reply posted to the thread.
2. Anchoring tests against a saved corpus of at least 15 real, varied pages
   (Wikipedia, a Substack post, a news article, GitHub README, Hacker News,
   LessWrong, a docs site, a page with heavy JS) including edited versions of
   those pages, to prove re-anchoring survives text changes.
3. Selections that cross element boundaries, overlapping highlights, very long
   selections, selections inside tables and lists, and pages with strict CSP.
4. No visible breakage of host pages; no errors in the host page console.
5. Offline or failed requests never lose a comment the user typed.

## Adversarial review with Codex

Use Codex as an adversarial reviewer to find errors, deficiencies and bugs. After
each major milestone (anchoring, threads UI, backend, email) and again at the end,
run Codex non-interactively over the repository, for example
`codex exec --dangerously-bypass-approvals-and-sandbox "<prompt>"` (or
`codex review` if available), asking it to find correctness bugs, security holes
(auth, XSS from comment content, forged email replies), reliability gaps against
the target above, and places where the build falls short of Curius. Verify each
finding yourself before acting; fix the real ones, add a test for each fixed bug,
and note rejected findings with a one-line reason in `REVIEW.md`. Repeat review
rounds until a full Codex round finds nothing material.

## Finish criteria

- All tests pass; Codex's last round finds nothing material.
- Backend deployed and reachable; extension builds into a loadable `dist/`
  folder and a zip.
- `README.md` opens with "Try it" in at most five short steps (load the unpacked
  extension, sign in, select text, comment), then how to turn on real email.
- `AGENTS.md` (build, test, deploy commands, where secrets live) and
  `DECISIONS.md` are current. Everything is committed and pushed.
