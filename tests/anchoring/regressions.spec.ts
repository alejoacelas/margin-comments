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

test('a highlight moves to the visible copy when a responsive layout swaps copies', async ({ page }) => {
  await load(
    page,
    `<style>.mobile{display:none} body.narrow .desktop{display:none} body.narrow .mobile{display:block}</style>
     <div class="desktop"><p id="d">Shared passage that both layouts render for their readers.</p></div>
     <div class="mobile"><p id="m">Shared passage that both layouts render for their readers.</p></div>`,
  );
  await page.evaluate(() => {
    const mc = (window as any).__mc;
    const r = document.createRange();
    r.selectNodeContents(document.getElementById('d')!);
    const { selectors } = mc.describeRange(document.body, r);
    const m = new mc.AnchorManager(() => document.body, () => false, () => {});
    m.start();
    m.setThreads([{ id: 't', selectors }]);
    (window as any).__m = m;
  });
  const where = () => page.evaluate(() => ((window as any).__m.get('t').range?.startContainer.parentElement as HTMLElement | undefined)?.id);
  expect(await where()).toBe('d');
  // A class change alone (no resize, no explicit schedule) must be noticed.
  await page.evaluate(() => document.body.classList.add('narrow'));
  await expect.poll(where, { timeout: 10_000 }).toBe('m');
  // Swapping straight back must not be lost to rate limiting.
  await page.evaluate(() => document.body.classList.remove('narrow'));
  await expect.poll(where, { timeout: 10_000 }).toBe('d');
});

test('text hidden with visibility:hidden does not count as visible', async ({ page }) => {
  await load(
    page,
    `<div id="one"><p id="a">A sentence that appears twice on this page for layout reasons.</p></div>
     <div id="two" style="visibility:hidden"><p id="b">A sentence that appears twice on this page for layout reasons.</p></div>`,
  );
  const where = await page.evaluate(() => {
    const mc = (window as any).__mc;
    const r = document.createRange();
    r.selectNodeContents(document.getElementById('a')!);
    const { selectors } = mc.describeRange(document.body, r);
    document.getElementById('one')!.style.visibility = 'hidden';
    document.getElementById('two')!.style.visibility = 'visible';
    const res = mc.anchorSelectors(document.body, selectors);
    return (res?.range.startContainer.parentElement as HTMLElement | undefined)?.id;
  });
  expect(where).toBe('b');
});

test('real viewport resizes move the highlight between responsive copies, both ways', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await load(
    page,
    `<style>.mobile{display:none} @media (max-width: 800px) { .desktop{display:none} .mobile{display:block} }</style>
     <div class="desktop"><p id="d">Responsive passage rendered once per layout for every reader.</p></div>
     <div class="mobile"><p id="m">Responsive passage rendered once per layout for every reader.</p></div>`,
  );
  await page.evaluate(() => {
    const mc = (window as any).__mc;
    const r = document.createRange();
    r.selectNodeContents(document.getElementById('d')!);
    const { selectors } = mc.describeRange(document.body, r);
    const m = new mc.AnchorManager(() => document.body, () => false, () => {});
    m.start();
    m.setThreads([{ id: 't', selectors }]);
    // What the content script does on resize.
    window.addEventListener('resize', () => m.layoutChanged());
    (window as any).__m = m;
  });
  const where = () => page.evaluate(() => ((window as any).__m.get('t').range?.startContainer.parentElement as HTMLElement | undefined)?.id);
  await page.setViewportSize({ width: 700, height: 800 });
  await expect.poll(where, { timeout: 10_000 }).toBe('m');
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect.poll(where, { timeout: 10_000 }).toBe('d');
});

test('an edited repeat stays on its own passage instead of jumping to the unchanged copy', async ({ page }) => {
  await load(
    page,
    `<main><h2>Section A</h2><p id="a">Opening for the first part. The quick brown fox jumps over the lazy dog. First part closes here.</p>
     <h2>Section B</h2><p id="b">Another start in part two. The quick brown fox jumps over the lazy dog. Part two ends with this.</p></main>`,
  );
  const where = await page.evaluate(() => {
    const mc = (window as any).__mc;
    const t = document.getElementById('b')!.firstChild as Text;
    const q = 'The quick brown fox jumps over the lazy dog.';
    const i = t.data.indexOf(q);
    const r = document.createRange();
    r.setStart(t, i);
    r.setEnd(t, i + q.length);
    const { selectors } = mc.describeRange(document.body, r);
    // B's copy is edited; A's stays identical.
    t.data = t.data.replace('quick', 'swift');
    const res = mc.anchorSelectors(document.body, selectors);
    return res ? { id: (res.range.startContainer.parentElement as HTMLElement).id, text: res.range.toString() } : null;
  });
  expect(where).toEqual({ id: 'b', text: 'The swift brown fox jumps over the lazy dog.' });
});

test('an unchanged repeat with the right context still anchors exactly', async ({ page }) => {
  await load(
    page,
    `<main><p id="a">Opening for the first part. The quick brown fox jumps over the lazy dog. First part closes here.</p>
     <p id="b">Another start in part two. The quick brown fox jumps over the lazy dog. Part two ends with this.</p></main>`,
  );
  const res = await page.evaluate(() => {
    const mc = (window as any).__mc;
    const t = document.getElementById('a')!.firstChild as Text;
    const q = 'The quick brown fox jumps over the lazy dog.';
    const i = t.data.indexOf(q);
    const r = document.createRange();
    r.setStart(t, i);
    r.setEnd(t, i + q.length);
    const { selectors } = mc.describeRange(document.body, r);
    // B's copy is edited; the thread on A must stay on A, exactly.
    const b = document.getElementById('b')!.firstChild as Text;
    b.data = b.data.replace('quick', 'swift');
    const out = mc.anchorSelectors(document.body, selectors);
    return out ? { id: (out.range.startContainer.parentElement as HTMLElement).id, method: out.method } : null;
  });
  expect(res?.id).toBe('a');
});

test('an edited repeat at the very start or end of the page stays on its own passage', async ({ page }) => {
  for (const which of ['end', 'start'] as const) {
    const q = 'The quick brown fox jumps over the lazy dog.';
    await load(
      page,
      which === 'end'
        ? `<p id="a">Opening for the first part. ${q} First part closes here.</p><p id="b">Another start in part two. ${q}</p>`
        : `<p id="b">${q} Part one continues afterwards.</p><p id="a">Opening for the second part. ${q} Second part closes here.</p>`,
    );
    const where = await page.evaluate(q => {
      const mc = (window as any).__mc;
      const t = document.getElementById('b')!.firstChild as Text;
      const i = t.data.indexOf(q);
      const r = document.createRange();
      r.setStart(t, i);
      r.setEnd(t, i + q.length);
      const { selectors } = mc.describeRange(document.body, r);
      t.data = t.data.replace('quick', 'swift');
      const res = mc.anchorSelectors(document.body, selectors);
      return res ? (res.range.startContainer.parentElement as HTMLElement).id : null;
    }, q);
    expect(where, which).toBe('b');
  }
});

test('an edited repeat that moved past its unchanged copy keeps its thread (saved path points at the copy)', async ({ page }) => {
  const q = 'The quick brown fox jumps over the lazy dog.';
  await load(
    page,
    `<main><p id="a">Opening for the first part. <span>${q}</span> First part closes here.</p><p id="b">Another start in part two. <span>${q}</span> Part two ends with this.</p></main>`,
  );
  const res = await page.evaluate(q => {
    const mc = (window as any).__mc;
    const r = document.createRange();
    r.selectNodeContents(document.querySelector('#b span')!);
    const { selectors } = mc.describeRange(document.body, r);
    // Edit B and move it first: its saved XPath (/main/p[2]/span) now points at A's unchanged copy.
    const b = document.getElementById('b')!;
    b.querySelector('span')!.textContent = q.replace('quick', 'swift');
    b.parentElement!.prepend(b);
    const out = mc.anchorSelectors(document.body, selectors);
    return out ? { id: (out.range.startContainer.parentElement!.closest('p') as HTMLElement).id, method: out.method } : null;
  }, q);
  expect(res).toEqual({ id: 'b', method: 'fuzzy' });
});

