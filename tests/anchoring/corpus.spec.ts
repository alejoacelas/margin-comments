/**
 * Anchoring against a saved corpus of real pages (tests/anchoring/corpus):
 * for every page, 40 seeded, word-aligned selections (a word to several
 * paragraphs, crossing element boundaries) are described on the original and
 * then anchored:
 *   1. on the same page (all selectors)             -> must be exact
 *   2. on the same page, quote selector only        -> exact text, right place
 *   3. on the edited version (real revision or synthetic edits):
 *      - text still present        -> must anchor to it (right occurrence)
 *      - text changed by a known edit (synthetic) -> must anchor to the new text
 *      - text deleted (synthetic)  -> must be orphaned, not mis-anchored
 *      - other changes (real revisions) -> reported (fuzzy anchor or orphan)
 */
import { expect, type Page, test } from '@playwright/test';
import { build } from 'esbuild';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CORPUS = resolve('tests/anchoring/corpus');
const PER_PAGE = 40;
const slugs = readdirSync(CORPUS).filter(s => existsSync(join(CORPUS, s, 'meta.json')) && existsSync(join(CORPUS, s, 'edited.html')));

type Edit = { type: string; from?: string; to?: string; before?: string; after?: string };
type Sel = { selectors: unknown[]; quote: string; rawStart: number; length: number };
type Res = { anchored: boolean; method?: string; quoteScore?: number; text?: string; rawStart?: number; sStart?: number; sEnd?: number; ms: number };

let bundle = '';
test.beforeAll(async () => {
  const out = await build({ entryPoints: ['tests/anchoring/harness.ts'], bundle: true, write: false, format: 'iife', target: 'chrome120', logLevel: 'error' });
  bundle = out.outputFiles[0].text;
});

async function load(page: Page, html: string) {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route('**/*', route =>
    route.request().url() === 'http://corpus.test/page' ? route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' }) : route.abort(),
  );
  await page.goto('http://corpus.test/page', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: bundle });
}

const strip = (s: string) => s.replace(/\s+/g, '');

function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/** How well the text around position `at` matches the selection's stored context. */
function contextScore(hay: string, at: number, len: number, prefix: string, suffix: string): number {
  let score = 0;
  for (let k = 1; k <= prefix.length && at - k >= 0 && hay[at - k] === prefix[prefix.length - k]; k++) score++;
  for (let k = 0; k < suffix.length && at + len + k < hay.length && hay[at + len + k] === suffix[k]; k++) score++;
  return score;
}

const totals = { self: [0, 0], quoteOnly: [0, 0], unchanged: [0, 0], modified: [0, 0], deleted: [0, 0], otherAnchored: 0, otherOrphan: 0 };
const rows: string[] = [];

for (const slug of slugs) {
  test(`corpus: ${slug}`, async ({ page }) => {
    const meta = JSON.parse(readFileSync(join(CORPUS, slug, 'meta.json'), 'utf8')) as { editKind: string; edits?: Edit[] };
    const original = readFileSync(join(CORPUS, slug, 'original.html'), 'utf8');
    const edited = readFileSync(join(CORPUS, slug, 'edited.html'), 'utf8');

    await load(page, original);
    const random: Sel[] = await page.evaluate(([s, n]) => (window as any).__mc.makeSelections(s, n), [slug, PER_PAGE] as const);
    expect(random.length).toBeGreaterThanOrEqual(PER_PAGE * 0.75);
    // Plus selections aimed at each known (synthetic) edit: the sentence around
    // a changed word, and a chunk inside the deleted paragraph.
    const targets: string[] = [];
    for (const e of meta.edits ?? []) {
      if (e.type === 'replace-word' && e.before) targets.push(e.before.trim());
      if (e.type === 'delete' && e.before) {
        const t = e.before.replace(/\s+/g, ' ').trim();
        targets.push(t.slice(Math.floor(t.length / 3), Math.floor(t.length / 3) + 60).trim());
      }
    }
    const aimed: Sel[] = targets.length ? await page.evaluate(list => (window as any).__mc.selectionsFor(list), targets) : [];
    const sels = [...random, ...aimed];

    // 1 + 2: same page.
    const self = await page.evaluate(list => (window as any).__mc.anchorAll(list), sels);
    const quoteOnly = await page.evaluate(list => (window as any).__mc.anchorAll(list, { quoteOnly: true }), sels);
    const page1: string = self.text;
    let selfOk = 0;
    let qoOk = 0;
    const failures: string[] = [];
    sels.forEach((s, i) => {
      const r: Res = self.results[i];
      if (r.anchored && strip(r.text!) === strip(s.quote) && r.rawStart === s.rawStart) selfOk++;
      else failures.push(`self #${i} "${s.quote.slice(0, 60)}" -> ${r.anchored ? `"${r.text!.slice(0, 60)}" @${r.rawStart} vs ${s.rawStart}` : 'orphan'}`);
      const q: Res = quoteOnly.results[i];
      // Right text, and the right occurrence (or an equally good one).
      if (q.anchored && strip(q.text!) === strip(s.quote)) {
        const sq = s.selectors.find((x: any) => x.type === 'TextQuoteSelector') as any;
        const occ = occurrences(page1, strip(s.quote));
        const best = Math.max(...occ.map(o => contextScore(page1, o, strip(s.quote).length, strip(sq.prefix ?? ''), strip(sq.suffix ?? ''))));
        if (q.rawStart === s.rawStart || contextScore(page1, q.sStart!, strip(s.quote).length, strip(sq.prefix ?? ''), strip(sq.suffix ?? '')) >= best) qoOk++;
        else failures.push(`quote-only #${i} wrong occurrence "${s.quote.slice(0, 60)}"`);
      } else failures.push(`quote-only #${i} "${s.quote.slice(0, 60)}" -> ${q.anchored ? q.text!.slice(0, 60) : 'orphan'}`);
    });

    // 3: edited version.
    await load(page, edited);
    const ed = await page.evaluate(list => (window as any).__mc.anchorAll(list), sels);
    const text2: string = ed.text;
    const edits = meta.edits ?? [];
    const c = { unchanged: [0, 0], modified: [0, 0], deleted: [0, 0], otherAnchored: 0, otherOrphan: 0 };
    let maxMs = 0;
    sels.forEach((s, i) => {
      const r: Res = ed.results[i];
      maxMs = Math.max(maxMs, r.ms);
      const q = strip(s.quote);
      const sq = s.selectors.find((x: any) => x.type === 'TextQuoteSelector') as any;
      const pre = strip(sq.prefix ?? '');
      const suf = strip(sq.suffix ?? '');
      const occ = occurrences(text2, q);
      if (occ.length) {
        c.unchanged[1]++;
        const best = Math.max(...occ.map(o => contextScore(text2, o, q.length, pre, suf)));
        const ok = r.anchored && strip(r.text!) === q && contextScore(text2, r.sStart!, q.length, pre, suf) >= best;
        if (ok) c.unchanged[0]++;
        else failures.push(`edited/unchanged #${i} "${s.quote.slice(0, 70)}" -> ${r.anchored ? `"${r.text!.slice(0, 70)}" (${r.method})` : 'orphan'}`);
        return;
      }
      // Synthetic ground truth.
      const deleted = edits.find(e => e.type === 'delete' && strip(e.before ?? '').includes(q));
      if (deleted) {
        c.deleted[1]++;
        if (!r.anchored) c.deleted[0]++;
        else failures.push(`edited/deleted #${i} "${s.quote.slice(0, 60)}" anchored to "${r.text!.slice(0, 60)}"`);
        return;
      }
      let expected: number | null = null;
      let expectedLen = 0;
      for (const e of edits.filter(x => x.type === 'replace-word')) {
        const from = strip(e.from!);
        const to = strip(e.to!);
        for (const at of occurrences(q, from)) {
          const candidate = q.slice(0, at) + to + q.slice(at + from.length);
          const found = occurrences(text2, candidate);
          if (found.length === 1) {
            expected = found[0];
            expectedLen = candidate.length;
          }
        }
      }
      if (expected !== null) {
        c.modified[1]++;
        const overlap = r.anchored ? Math.max(0, Math.min(r.sEnd!, expected + expectedLen) - Math.max(r.sStart!, expected)) : 0;
        if (overlap >= 0.8 * expectedLen) c.modified[0]++;
        else failures.push(`edited/modified #${i} "${s.quote.slice(0, 60)}" -> ${r.anchored ? `"${r.text!.slice(0, 60)}"` : 'orphan'}`);
        return;
      }
      if (r.anchored) {
        c.otherAnchored++;
        if (process.env.SHOW_FUZZY) failures.push(`fuzzy #${i} (${r.quoteScore?.toFixed(2)})\n     was: "${s.quote.slice(0, 150)}"\n     now: "${r.text!.replace(/\s+/g, ' ').slice(0, 150)}"`);
      } else c.otherOrphan++;
    });

    const pct = (a: number[]) => (a[1] ? `${a[0]}/${a[1]}` : '-');
    rows.push(
      `${slug.padEnd(30)} self ${pct([selfOk, sels.length]).padEnd(6)} quote-only ${pct([qoOk, sels.length]).padEnd(6)} unchanged ${pct(c.unchanged).padEnd(6)} modified ${pct(c.modified).padEnd(5)} deleted ${pct(c.deleted).padEnd(5)} other: ${c.otherAnchored} fuzzy / ${c.otherOrphan} orphan  max ${maxMs.toFixed(0)}ms`,
    );
    totals.self[0] += selfOk;
    totals.self[1] += sels.length;
    totals.quoteOnly[0] += qoOk;
    totals.quoteOnly[1] += sels.length;
    for (const k of ['unchanged', 'modified', 'deleted'] as const) {
      totals[k][0] += c[k][0];
      totals[k][1] += c[k][1];
    }
    totals.otherAnchored += c.otherAnchored;
    totals.otherOrphan += c.otherOrphan;
    if (failures.length) console.log(`${slug} failures:\n  ${failures.join('\n  ')}`);

    // Per page: same-page anchoring must be perfect; text that survived the edit must be found.
    expect(selfOk, 'same-page anchoring').toBe(sels.length);
    expect(c.unchanged[0], 'unchanged text re-anchored').toBe(c.unchanged[1]);
    expect(maxMs, 'slowest single anchor (ms)').toBeLessThan(5000);
  });
}

test.afterAll(() => {
  console.log(`\nAnchoring corpus results (${slugs.length} pages):\n${rows.join('\n')}`);
  const r = (a: number[]) => (a[1] ? a[0] / a[1] : 1);
  console.log(
    `TOTAL self ${totals.self.join('/')}  quote-only ${totals.quoteOnly.join('/')}  unchanged ${totals.unchanged.join('/')}  modified ${totals.modified.join('/')}  deleted ${totals.deleted.join('/')}  other ${totals.otherAnchored} fuzzy / ${totals.otherOrphan} orphan`,
  );
  expect(slugs.length).toBeGreaterThanOrEqual(15);
  expect(r(totals.quoteOnly)).toBeGreaterThanOrEqual(0.98);
  expect(r(totals.modified)).toBeGreaterThanOrEqual(0.85);
  expect(r(totals.deleted)).toBeGreaterThanOrEqual(0.9);
});
