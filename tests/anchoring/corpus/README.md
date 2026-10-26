# Anchoring corpus

Real web pages saved with an **edited version** of each, used by
`tests/anchoring/corpus.spec.ts` (`npm run test:anchoring`) to prove that
anchoring finds text on the same page and re-anchors after the page changes.

- `original.html` / `edited.html`: sanitized snapshots (no scripts, iframes,
  event handlers, external stylesheets or `meta http-equiv`; inline `<style>`
  kept). Tests load them offline (all other requests are aborted).
- `meta.json`: source URLs, fetch time, `editKind`, and for synthetic edits the
  list of `edits` (ground truth).
- **real-revision**: the edited version is a real later (or earlier) version of
  the page: Wikipedia `oldid`s, GitHub blobs at two commits, Python docs 3.12 vs
  3.14, W3C CR vs REC, arXiv v1 vs v7, and Wayback Machine captures.
- **synthetic**: no usable revision existed, so `make-synthetic-edits.mjs`
  applied deterministic, realistic edits (inserted note, deleted paragraph,
  word replacements, whitespace reflow, punctuation, new inline elements, a
  moved paragraph) and recorded them.

Regenerate synthetic edits with `node tests/anchoring/corpus/make-synthetic-edits.mjs`.
Pages were fetched politely with curl or rendered in a sandboxed headless
Chromium (for SPAs), then sanitized with parse5; the fetch scripts are not part
of the repo.

| Page | Category | Edit | Size | Notes |
|---|---|---|---|---|
| `arxiv-attention` | arxiv | real-revision | 78 KB | arXiv abstract page, "Attention Is All You Need", v1 vs v7 (submission history, comments and metadata differ; abstract nearly identical).. |
| `github-awesome-nested-lists` | nested-lists | real-revision | 457 KB | sindresorhus/awesome README (deeply nested lists of links), rendered GitHub blob view at two commits 30 README changes apart (items added/removed/renamed). |
| `github-readme-ollama` | github-readme | real-revision | 703 KB | github.com repo README, blob view (React app; DOM captured with Playwright after JS ran, then sanitized). |
| `govuk-minimum-wage` | government | real-revision | 175 KB | GOV.UK guidance with rate tables: June 2023 Wayback capture vs live page (rates, dates and headings updated yearly).. |
| `hn-chatgpt-thread` | hacker-news | real-revision | 526 KB | Hacker News comment thread "ChatGPT: Optimizing language models for dialogue". |
| `lesswrong-cheerful-price` | lesswrong-heavy-js | synthetic | 639 KB | LessWrong post (React/Apollo SPA): DOM captured with Playwright after JS ran and the page was scrolled; <style>/<svg> dropped to fit the size budget. |
| `mdn-range` | docs-mdn | real-revision | 179 KB | MDN reference page for Range: 2021 Wayback capture vs live (site redesign, reworded descriptions, new members, different markup).. |
| `news-bbc-queen` | news | real-revision | 314 KB | BBC News live-updated article (death of Queen Elizabeth II). |
| `paulgraham-read` | blog-essay | synthetic | 13 KB | Paul Graham essay: old-school table layout, <font> tags and <br><br> paragraph breaks (no <p>). |
| `python-docs-asyncio-task` | docs | real-revision | 320 KB | Python documentation (Sphinx), asyncio "Coroutines and Tasks". |
| `react-docs-thinking` | docs-heavy-js | synthetic | 278 KB | react.dev (Next.js) page rendered with Playwright after hydration; <style>/<svg> dropped. |
| `stackoverflow-sorted-array` | stackoverflow | real-revision | 780 KB | Stack Overflow question with long answers and code blocks: 2016 vs 2024 Wayback captures (answers edited, votes/comments changed, site chrome redesigned).. |
| `substack-acx` | substack | synthetic | 104 KB | Substack post (Astral Codex Ten, custom domain). |
| `w3c-annotation-model` | spec-long | real-revision | 547 KB | W3C Web Annotation Data Model: Candidate Recommendation (2016-07-05) vs Recommendation (2017-02-23). |
| `wikipedia-he-internet` | rtl-non-english | real-revision | 629 KB | Hebrew (RTL, dir="rtl") Wikipedia article "Internet" (אינטרנט). |
| `wikipedia-ja-annotation` | cjk-non-english | real-revision | 333 KB | Japanese Wikipedia article 注釈 (annotation): CJK text without spaces between words. |
| `wikipedia-marginalia` | wikipedia | real-revision | 339 KB | English Wikipedia article. |
| `wikipedia-population-table` | data-tables | real-revision | 2627 KB | Big sortable data table (~240 rows) on English Wikipedia. |

## What the test checks

For each page, 40 seeded, word-aligned selections (from a few words to several
paragraphs, crossing element boundaries) plus selections aimed at every known
synthetic edit:

1. Same page, all selectors: exact text at the exact offset (must be 100%).
2. Same page, quote selector only: exact text at the best-matching occurrence.
3. Edited page: text that still exists must be found (100%); text changed by a
   known edit must be found in its new form; text inside a deleted paragraph
   must be orphaned rather than mis-anchored; other changes are reported.
