// In-browser regression tests for anchoring bugs found by review (REVIEW.md).
import { expect, type Page, test } from '@playwright/test';
import { build } from 'esbuild';

let bundle = '';
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: ['tests/anchoring/harness.ts'], bundle: true, write: false, format: 'iife', target: 'chrome120', logLevel: 'error' })).outputFiles[0].text;
});

async function load(page: Page, body: string) {
  await page.route('**/*', r => (r.request().url() === 'http://reg.test/' ? r.fulfill({ body: `<!doctype html><html><body>${body}</body></html>`, contentType: 'text/html' }) : r.abort()));
  await page.goto('http://reg.test/');
  await page.addScriptTag({ content: bundle });
}

test('a repeated phrase re-anchors to the right occurrence after content is inserted above', async ({ page }) => {
  await load(
    page,
    `<main><p id="a">Alpha intro. Read more about this topic here in the first section.</p>
     <p id="b">Beta intro. Read more about this topic here in the second section.</p></main>`,
  );
  const where = await page.evaluate(() => {
    const mc = (window as any).__mc;
    const t = document.getElementById('b')!.firstChild as Text;
    const i = t.data.indexOf('Read more');
    const r = document.createRange();
    r.setStart(t, i);
    r.setEnd(t, i + 'Read more about this topic here'.length);
    const { selectors } = mc.describeRange(document.body, r);
    const p = document.createElement('p');
    p.textContent = 'A new paragraph at the top.';
    document.querySelector('main')!.prepend(p);
    const res = mc.anchorSelectors(document.body, selectors);
    return res ? (res.range.startContainer.parentElement as HTMLElement).id : null;
  });
  expect(where).toBe('b');
});

test('a fuzzy anchor upgrades when the exact text appears, even if the page length is unchanged', async ({ page }) => {
  await load(page, `<main><p id="near">The quick brown fox jumps over the lazy dog near the river bank today.</p><p id="slot">-</p></main>`);
  const quote = 'The quick brown fox jumps over the lazy dog near the river bank today.';
  await page.evaluate(q => {
    const mc = (window as any).__mc;
    const near = document.getElementById('near')!;
    const r = document.createRange();
    r.selectNodeContents(near);
    const { selectors } = mc.describeRange(document.body, r);
    // The anchored passage changes slightly (fuzzy), and the slot holds same-length filler.
    near.textContent = q.replace('quick', 'quack');
    document.getElementById('slot')!.textContent = 'x'.repeat(q.length);
    const m = new mc.AnchorManager(() => document.body, () => false, () => {});
    m.start();
    m.setThreads([{ id: 't', selectors }]);
    (window as any).__m = m;
  }, quote);
  await expect
    .poll(() => page.evaluate(() => (window as any).__m.get('t').status), { timeout: 10_000 })
    .toBe('anchored');
  expect(await page.evaluate(() => ((window as any).__m.get('t').range.startContainer.parentElement as HTMLElement).id)).toBe('near');
  // Same total length: replace the filler with the exact quote.
  await page.evaluate(q => {
    document.getElementById('slot')!.textContent = q;
  }, quote);
  await expect
    .poll(() => page.evaluate(() => ((window as any).__m.get('t').range?.startContainer.parentElement as HTMLElement | undefined)?.id), { timeout: 10_000 })
    .toBe('slot');
});
