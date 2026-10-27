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

test('text inside web components (open shadow roots, slots) is described and anchored', async ({ page }) => {
  await load(page, `<main><p id="before">Light text before the component.</p><x-card><span slot="s">Slotted light words.</span></x-card><p id="after">Light text after the component.</p></main>`);
  const res = await page.evaluate(() => {
    const mc = (window as any).__mc;
    const host = document.querySelector('x-card')!;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<p id="in">Words rendered inside the shadow root here.</p><slot name="s"></slot>';
    const t = root.getElementById('in')!.firstChild as Text;
    const r = document.createRange();
    r.setStart(t, 6);
    r.setEnd(t, 30);
    const desc = mc.describeRange(document.body, r);
    const inShadow = mc.anchorSelectors(document.body, desc.selectors);
    // A light-DOM thread after the component still anchors via its position.
    const after = document.getElementById('after')!.firstChild as Text;
    const r2 = document.createRange();
    r2.setStart(after, 0);
    r2.setEnd(after, 10);
    const light = mc.anchorSelectors(document.body, mc.describeRange(document.body, r2).selectors);
    // Slotted light text is part of the page text where it renders.
    const index = new mc.TextIndex(document.body);
    return {
      quote: desc.quote,
      types: desc.selectors.map((s: any) => s.type).sort(),
      anchored: inShadow && inShadow.range.toString(),
      inShadowRoot: inShadow && inShadow.range.startContainer.getRootNode() === root,
      light: light && light.range.toString(),
      order: index.text.indexOf('Wordsrendered') < index.text.indexOf('Slottedlight') && index.text.indexOf('Slottedlight') < index.text.indexOf('Lighttextafter'),
    };
  });
  expect(res).toEqual({
    quote: 'rendered inside the shad',
    types: ['TextPositionSelector', 'TextQuoteSelector'],
    anchored: 'rendered inside the shad',
    inShadowRoot: true,
    light: 'Light text',
    order: true,
  });
});

test("a short quote in a component that starts with a <style> survives CSS changes", async ({ page }) => {
  await load(page, `<main><p>Words before the widget.</p><x-w></x-w><p>Words after the widget.</p></main>`);
  const res = await page.evaluate(() => {
    const mc = (window as any).__mc;
    const root = document.querySelector('x-w')!.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>p { color: rgb(10, 20, 30); font-size: 16px; }</style><p>Hello there</p>';
    const t = root.querySelector('p')!.firstChild as Text;
    const r = document.createRange();
    r.selectNodeContents(t);
    const { selectors } = mc.describeRange(document.body, r);
    // The component ships more CSS (positions shift); the text is unchanged.
    root.querySelector('style')!.textContent += ' h1 { margin: 0; } .x { padding: 4px 8px; }';
    const out = mc.anchorSelectors(document.body, selectors);
    return { prefix: selectors.find((s: any) => s.type === 'TextQuoteSelector').prefix, anchored: out && out.range.toString() };
  });
  expect(res.prefix).not.toContain('color');
  expect(res.anchored).toBe('Hello there');
});

test('repeated slotted text in identical components re-anchors to its own component', async ({ page }) => {
  await load(page, `<main><x-card id="c1"><span>Read more</span></x-card><x-card id="c2"><span>Read more</span></x-card></main>`);
  const res = await page.evaluate(() => {
    const mc = (window as any).__mc;
    for (const host of document.querySelectorAll('x-card')) {
      host.attachShadow({ mode: 'open' }).innerHTML =
        '<p>A component header that is repeated in every card.</p><slot></slot><p>The same footer in each component.</p>';
    }
    const t = document.querySelector('#c2 span')!.firstChild as Text;
    const r = document.createRange();
    r.selectNodeContents(t);
    const { selectors } = mc.describeRange(document.body, r);
    // (Quote alone is ambiguous here: both copies have the same 32 characters
    // of context. The position, now in rendered-text terms, decides.)
    const out = mc.anchorSelectors(document.body, selectors);
    return out && (out.range.startContainer.parentElement!.closest('x-card') as HTMLElement).id;
  });
  expect(res).toBe('c2');
});

test('on a page with web components, a quote never includes inline script text', async ({ page }) => {
  await load(page, `<main><p id="p1">First paragraph of the article text.</p><script>window.adConfiguration = "sidebar-ad-slot";</script><p id="p2">Second paragraph continues the article.</p><x-w></x-w></main>`);
  const res = await page.evaluate(() => {
    const mc = (window as any).__mc;
    document.querySelector('x-w')!.attachShadow({ mode: 'open' }).innerHTML = '<p>Unrelated widget</p>';
    const r = document.createRange();
    r.setStart(document.getElementById('p1')!.firstChild!, 6);
    r.setEnd(document.getElementById('p2')!.firstChild!, 17);
    const desc = mc.describeRange(document.body, r);
    const out = mc.anchorSelectors(document.body, desc.selectors);
    const q = desc.selectors.find((s: any) => s.type === 'TextQuoteSelector');
    return { exact: q.exact, quote: desc.quote, anchored: !!out };
  });
  expect(res.exact).not.toContain('adConfiguration');
  expect(res.quote).toBe('paragraph of the article text.Second paragraph');
  expect(res.anchored).toBe(true);
});

test('text placed directly in a shadow root (no element around it) can be commented on', async ({ page }) => {
  await load(page, `<main><p>Before.</p><x-label></x-label></main>`);
  const res = await page.evaluate(() => {
    const mc = (window as any).__mc;
    const root = document.querySelector('x-label')!.attachShadow({ mode: 'open' });
    root.textContent = 'This is the visible web component label.';
    const t = root.firstChild as Text;
    const r = document.createRange();
    r.setStart(t, 0);
    r.setEnd(t, 'This is the visible '.length); // trailing space trimmed
    const desc = mc.describeRange(document.body, r);
    const out = desc && mc.anchorSelectors(document.body, desc.selectors);
    return { quote: desc && desc.quote, anchored: out && out.range.toString() };
  });
  expect(res).toEqual({ quote: 'This is the visible', anchored: 'This is the visible' });
});

test("a thread's stored context never includes an adjacent inline script's data", async ({ page }) => {
  for (const body of [
    // Nothing but the script within 32 characters after (or before) the passage.
    `<main><p id="p">Passage to comment on.</p><script type="application/json">{"token":"0123456789abcdef"}</script></main>`,
    `<main><script type="application/json">{"before":"secret-aaaa1111"}</script><p id="p">Passage to comment on.</p></main>`,
  ]) {
    await load(page, body);
    const res = await page.evaluate(() => {
      const mc = (window as any).__mc;
      const p = document.getElementById('p')!;
      const t = p.firstChild as Text;
      const ranges = [
        (() => { const r = document.createRange(); r.selectNodeContents(p); return r; })(),
        (() => { const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, t.length); return r; })(),
        (() => { const r = document.createRange(); r.setStart(t, 8); r.setEnd(t, t.length); return r; })(),
      ];
      return ranges.map(r => {
        const { selectors } = mc.describeRange(document.body, r);
        return { json: JSON.stringify(selectors), anchored: !!mc.anchorSelectors(document.body, selectors) };
      });
    });
    for (const r of res) {
      expect(r.json).not.toContain('0123456789abcdef');
      expect(r.json).not.toContain('secret-aaaa1111');
      expect(r.anchored).toBe(true);
    }
  }
});

test('hidden text is never quoted, inside or next to a selection; it anchors again once shown', async ({ page }) => {
  await load(
    page,
    `<main><p id="p">Visible beginning <span hidden>private patient diagnosis</span> visible ending.</p><div id="h" style="display:none">secret sibling text here</div><details id="d"><summary>More</summary><p id="in">Text inside a collapsed section of the page.</p></details></main>`,
  );
  const res = await page.evaluate(() => {
    const mc = (window as any).__mc;
    const r = document.createRange();
    r.selectNodeContents(document.getElementById('p')!);
    const desc = mc.describeRange(document.body, r);
    const anchored = mc.anchorSelectors(document.body, desc.selectors);
    return { json: JSON.stringify(desc.selectors), quote: desc.quote, anchored: !!anchored };
  });
  expect(res.json).not.toContain('diagnosis');
  expect(res.json).not.toContain('secret sibling');
  expect(res.quote).toBe('Visible beginning visible ending.');
  expect(res.anchored).toBe(true);
  // A thread on text in a <details> that gets collapsed is an orphan while
  // collapsed and comes back when it's opened (the manager retries on layout changes).
  await page.evaluate(() => {
    const mc = (window as any).__mc;
    const d = document.getElementById('d') as HTMLDetailsElement;
    d.open = true;
    const r = document.createRange();
    r.selectNodeContents(document.getElementById('in')!);
    const { selectors } = mc.describeRange(document.body, r);
    d.open = false;
    const m = new mc.AnchorManager(() => document.body, () => false, () => {});
    m.start();
    m.setThreads([{ id: 't', selectors }]);
    (window as any).__m = m;
  });
  await expect.poll(() => page.evaluate(() => (window as any).__m.get('t').status), { timeout: 15_000 }).toBe('orphan');
  await page.evaluate(() => ((document.getElementById('d') as HTMLDetailsElement).open = true));
  await expect.poll(() => page.evaluate(() => (window as any).__m.get('t').status), { timeout: 15_000 }).toBe('anchored');
});

test('hidden slots and textarea values stay out of selectors; display:contents text can be commented on', async ({ page }) => {
  await load(
    page,
    `<main><x-tabs>private account info</x-tabs><p id="a">Public article text.</p><textarea id="ta">private diagnosis 1234</textarea><div id="c" style="display:contents">Visible article text to annotate.</div></main>`,
  );
  const res = await page.evaluate(() => {
    const mc = (window as any).__mc;
    document.querySelector('x-tabs')!.attachShadow({ mode: 'open' }).innerHTML = '<p>Tab header text.</p><slot style="display:none"></slot>';
    (document.getElementById('ta') as HTMLTextAreaElement).value = '';
    const describe = (el: Element) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return mc.describeRange(document.body, r);
    };
    const a = describe(document.getElementById('a')!);
    const c = describe(document.getElementById('c')!);
    return {
      a: JSON.stringify(a.selectors),
      c: c && c.quote,
      cAnchored: c && mc.anchorSelectors(document.body, c.selectors)?.range.toString(),
    };
  });
  expect(res.a).not.toContain('private account');
  expect(res.a).not.toContain('private diagnosis');
  expect(res.c).toBe('Visible article text to annotate.');
  expect(res.cAnchored).toBe('Visible article text to annotate.');
});

test('hidden display:contents text and closed <details> bodies stay out of selectors', async ({ page }) => {
  for (const after of [
    '<span style="display:contents;visibility:hidden">private diagnosis 1234</span>',
    '<details><summary>More</summary>private diagnosis 1234</details>',
    '<details><summary>More</summary><span style="display:contents">private diagnosis 1234</span></details>',
    '<div style="content-visibility:hidden">private diagnosis 1234</div>',
    '<div style="content-visibility:hidden"><span style="display:contents">private diagnosis 1234</span></div>',
  ]) {
    await load(page, `<main><p id="p">Public article text.</p>${after}</main>`);
    const json = await page.evaluate(() => {
      const mc = (window as any).__mc;
      const r = document.createRange();
      r.selectNodeContents(document.getElementById('p')!);
      return JSON.stringify(mc.describeRange(document.body, r).selectors);
    });
    expect(json, after).not.toContain('diagnosis');
  }
  // Still page text: a visible override inside hidden visibility, and an open <details> body.
  await load(
    page,
    `<main><div style="visibility:hidden"><span id="v" style="display:contents;visibility:visible">Shown despite a hidden parent.</span></div><details open><summary>More</summary>Body of an open details element.</details></main>`,
  );
  const quotes = await page.evaluate(() => {
    const mc = (window as any).__mc;
    const describe = (n: Node) => {
      const r = document.createRange();
      r.selectNodeContents(n);
      return mc.describeRange(document.body, r)?.quote ?? null;
    };
    return [describe(document.getElementById('v')!), describe(document.querySelector('details')!.lastChild!)];
  });
  expect(quotes).toEqual(['Shown despite a hidden parent.', 'Body of an open details element.']);
});

test("a closed web component's hidden or unslotted children stay out of selectors", async ({ page }) => {
  // Text directly in the hosts: no element of its own for checkVisibility to judge.
  await load(page, `<main><x-tabs>private account info</x-tabs><p id="p">Public article text.</p><x-card>unslotted secret text</x-card></main>`);
  const json = await page.evaluate(() => {
    const mc = (window as any).__mc;
    // Content scripts reach closed roots through chrome.dom; stand in for it here.
    const w = window as any;
    w.chrome = w.chrome ?? {};
    w.chrome.dom = { openOrClosedShadowRoot: (el: any) => el.__closedRoot ?? null };
    const tabs = document.querySelector('x-tabs') as any;
    tabs.__closedRoot = tabs.attachShadow({ mode: 'closed' });
    tabs.__closedRoot.innerHTML = '<p>Tab header.</p><slot style="display:none"></slot>';
    const card = document.querySelector('x-card') as any;
    card.__closedRoot = card.attachShadow({ mode: 'closed' });
    card.__closedRoot.innerHTML = '<p>Card without a slot.</p>';
    const r = document.createRange();
    r.selectNodeContents(document.getElementById('p')!);
    return JSON.stringify(mc.describeRange(document.body, r).selectors);
  });
  expect(json).not.toContain('private account');
  expect(json).not.toContain('unslotted secret');
});

test('a thread on a passage that gets collapsed is orphaned, and comes back when it opens', async ({ page }) => {
  await load(page, `<main><p>Intro paragraph here.</p><details id="d" open><summary>More</summary><p id="in">Text inside a section that will collapse.</p></details></main>`);
  await page.evaluate(() => {
    const mc = (window as any).__mc;
    const r = document.createRange();
    r.selectNodeContents(document.getElementById('in')!);
    const { selectors } = mc.describeRange(document.body, r);
    const m = new mc.AnchorManager(() => document.body, () => false, () => {});
    m.start();
    m.setThreads([{ id: 't', selectors }]);
    (window as any).__m = m;
  });
  const status = () => page.evaluate(() => (window as any).__m.get('t').status);
  await expect.poll(status, { timeout: 15_000 }).toBe('anchored');
  await page.evaluate(() => ((document.getElementById('d') as HTMLDetailsElement).open = false));
  await expect.poll(status, { timeout: 15_000 }).toBe('orphan');
  await page.evaluate(() => ((document.getElementById('d') as HTMLDetailsElement).open = true));
  await expect.poll(status, { timeout: 15_000 }).toBe('anchored');
});

test('a highlight follows a tab switch made with a custom attribute (no size change)', async ({ page }) => {
  await load(
    page,
    `<style>[data-tab="a"] #pb { display: none } [data-tab="b"] #pa { display: none }</style>
     <main id="tabs" data-tab="a"><p id="pa">Shared tab passage text for both panels here.</p><p id="pb">Shared tab passage text for both panels here.</p></main>`,
  );
  await page.evaluate(() => {
    const mc = (window as any).__mc;
    const r = document.createRange();
    r.selectNodeContents(document.getElementById('pa')!);
    const { selectors } = mc.describeRange(document.body, r);
    const m = new mc.AnchorManager(() => document.body, () => false, () => {});
    m.start();
    m.setThreads([{ id: 't', selectors }]);
    (window as any).__m = m;
  });
  const where = () => page.evaluate(() => ((window as any).__m.get('t').range?.startContainer.parentElement as HTMLElement | undefined)?.id ?? null);
  await expect.poll(where, { timeout: 10_000 }).toBe('pa');
  await page.evaluate(() => document.getElementById('tabs')!.setAttribute('data-tab', 'b'));
  await expect.poll(where, { timeout: 10_000 }).toBe('pb');
});

test("text in an editor next to a selection (someone's unsent draft) stays out of selectors", async ({ page }) => {
  for (const editor of [
    '<div contenteditable="true">UNSENT: my medical diagnosis</div>',
    '<div contenteditable="plaintext-only">UNSENT: my medical diagnosis</div>',
    '<div contenteditable><p>UNSENT: my <b>medical diagnosis</b></p></div>',
    '<div contenteditable="true">Unsent message <span contenteditable="false">@diagnosis chip</span></div>',
  ]) {
    await load(page, `<main><p id="p">An article paragraph to comment on.</p>${editor}</main>`);
    const json = await page.evaluate(() => {
      const mc = (window as any).__mc;
      const r = document.createRange();
      r.selectNodeContents(document.getElementById('p')!);
      return JSON.stringify(mc.describeRange(document.body, r).selectors);
    });
    expect(json, editor).not.toContain('diagnosis');
  }
});

test('a stored selector built to be expensive (tiny quote, huge context) anchors or orphans quickly', async ({ page }) => {
  await load(page, `<main><p>${'Here is a passage that readers can select and discuss. '.repeat(400)}</p></main>`);
  const ms = await page.evaluate(() => {
    const mc = (window as any).__mc;
    const t0 = performance.now();
    for (const exact of ['e', 'a', 's']) {
      mc.anchorSelectors(document.body, [{ type: 'TextQuoteSelector', exact, prefix: 'z'.repeat(400), suffix: 'z'.repeat(400) }]);
    }
    return performance.now() - t0;
  });
  expect(ms).toBeLessThan(1500);
});

test('many expensive threads are anchored in slices, never freezing the page', async ({ page }) => {
  await load(page, `<main>${Array.from({ length: 3000 }, (_, i) => `<p>Paragraph ${i} with ordinary article words, sentences and some numbers ${i * 7}.</p>`).join('')}</main>`);
  const longest = await page.evaluate(async () => {
    const mc = (window as any).__mc;
    // 300 threads whose long quotes aren't on the page: each needs a fuzzy search.
    const threads = Array.from({ length: 300 }, (_, i) => ({
      id: `t${i}`,
      selectors: [{ type: 'TextQuoteSelector', exact: `missing passage ${i} `.repeat(150) }],
    }));
    let longestTask = 0;
    const obs = new PerformanceObserver(list => {
      for (const e of list.getEntries()) longestTask = Math.max(longestTask, e.duration);
    });
    obs.observe({ type: 'longtask', buffered: false } as any);
    const m = new mc.AnchorManager(() => document.body, () => false, () => {});
    m.start();
    m.setThreads(threads);
    await new Promise(r => setTimeout(r, 8000));
    obs.disconnect();
    return longestTask;
  });
  expect(longest).toBeLessThan(400);
});

test('with many anchored threads, every new thread still gets its turn', async ({ page }) => {
  // About 45,000 characters: re-validating 300 anchors on it takes a pass's whole budget.
  const passage = Array.from({ length: 700 }, (_, i) => `Sentence ${i} of a long shared passage that many threads quote.`).join(' ');
  await load(page, `<main><p id="big">${passage}</p>${Array.from({ length: 2000 }, (_, i) => `<p>Paragraph ${i} of filler text.</p>`).join('')}<p id="last">The very last paragraph on the page.</p></main>`);
  const pending = await page.evaluate(async () => {
    const mc = (window as any).__mc;
    const describe = (id: string) => {
      const r = document.createRange();
      r.selectNodeContents(document.getElementById(id)!);
      return mc.describeRange(document.body, r).selectors;
    };
    const big = describe('big');
    const threads = Array.from({ length: 300 }, (_, i) => ({ id: `t${i}`, selectors: big }));
    threads.push({ id: 'late', selectors: describe('last') });
    const m = new mc.AnchorManager(() => document.body, () => false, () => {});
    m.start();
    m.setThreads(threads);
    await new Promise(r => setTimeout(r, 8000));
    return threads.filter(t => m.get(t.id).status === 'pending').map(t => t.id);
  });
  expect(pending).toEqual([]);
});

test('a stored selector with a hostile XPath is ignored, not evaluated', async ({ page }) => {
  await load(page, `<main>${Array.from({ length: 3000 }, (_, i) => `<p>Paragraph ${i} of ordinary page text.</p>`).join('')}<p id="u">A unique passage to anchor.</p></main>`);
  const res = await page.evaluate(() => {
    const mc = (window as any).__mc;
    const t0 = performance.now();
    const out = mc.anchorSelectors(document.body, [
      { type: 'RangeSelector', startContainer: '//*[count(preceding::*[count(preceding::*) > 999999]) > 999999]', startOffset: 0, endContainer: '//*[count(preceding::*) > 999999]', endOffset: 1 },
      { type: 'TextQuoteSelector', exact: 'A unique passage to anchor.' },
    ]);
    return { ms: performance.now() - t0, text: out && out.range.toString() };
  });
  expect(res.text).toBe('A unique passage to anchor.');
  expect(res.ms).toBeLessThan(500);
});

test('a maximum-length quote with one change is matched quickly (and still found)', async ({ page }) => {
  const q = 'Thequickbrownfoxjumpsoverthelazydogandthenrests.'.repeat(1100).slice(0, 50000);
  const shown = q.slice(0, 25000) + 'X' + q.slice(25001);
  await load(page, `<main><p id="p">${shown}</p></main>`);
  const res = await page.evaluate(q => {
    const mc = (window as any).__mc;
    const t0 = performance.now();
    const out = mc.anchorSelectors(document.body, [{ type: 'TextQuoteSelector', exact: q }]);
    return { ms: performance.now() - t0, anchored: !!out, length: out ? out.range.toString().length : 0 };
  }, q);
  expect(res.ms).toBeLessThan(1500);
  expect(res.anchored).toBe(true);
  expect(Math.abs(res.length - 50000)).toBeLessThan(100);
});

test('a long passage whose middle was rewritten is orphaned, not anchored to the new text', async ({ page }) => {
  // Letters only (no spaces), so 25% of the quote survives exactly.
  const letters = (seed: number, n: number, alphabet: string) => {
    let x = seed;
    return Array.from({ length: n }, () => alphabet[(x = (x * 1103515245 + 12345) % 2147483648) % alphabet.length]).join('');
  };
  const original = letters(1, 10240, 'abcdefghij');
  await load(page, `<main><p id="p">${original}</p></main>`);
  const result = await page.evaluate(([original, middle]) => {
    const mc = (window as any).__mc;
    const r = document.createRange();
    r.selectNodeContents(document.getElementById('p')!);
    const { selectors } = mc.describeRange(document.body, r);
    // Keep the first and last 1,280 characters, rewrite the middle 7,680 entirely.
    document.getElementById('p')!.textContent = original.slice(0, 1280) + middle + original.slice(-1280);
    const out = mc.anchorSelectors(document.body, selectors);
    return out ? out.quoteScore : null;
  }, [original, letters(99, 7680, 'klmnopqrst')] as const);
  expect(result).toBeNull();
});

test('a long quote survives a paragraph inserted into or removed from it', async ({ page }) => {
  const words = (seed: number, n: number) => {
    let x = seed;
    const w = ['margin', 'reader', 'note', 'quote', 'thread', 'anchor', 'paragraph', 'comment', 'book', 'essay', 'idea', 'page'];
    return Array.from({ length: n }, () => w[(x = (x * 1103515245 + 12345) % 2147483648) % w.length]).join(' ');
  };
  const original = words(5, 2300).slice(0, 13600);
  const extra = ' ' + words(77, 70).toUpperCase().slice(0, 400) + ' ';
  for (const edit of ['insert', 'delete'] as const) {
    await load(page, `<main><p id="p">${original}</p></main>`);
    const res = await page.evaluate(([original, extra, edit]) => {
      const mc = (window as any).__mc;
      const r = document.createRange();
      r.selectNodeContents(document.getElementById('p')!);
      const { selectors } = mc.describeRange(document.body, r);
      const at = Math.floor(original.length * 0.3);
      document.getElementById('p')!.textContent = edit === 'insert' ? original.slice(0, at) + extra + original.slice(at) : original.slice(0, at) + original.slice(at + 400);
      const out = mc.anchorSelectors(document.body, selectors);
      return out && out.quoteScore;
    }, [original, extra, edit] as const);
    expect(res, edit).not.toBeNull();
    expect(res!, edit).toBeGreaterThan(0.9);
  }
});

test("fallback content the browser doesn't render (canvas, media, frames) stays out of selectors", async ({ page }) => {
  for (const fallback of [
    '<canvas>Account: 123456, balance: 9000</canvas>',
    '<video>Account: 123456, balance: 9000</video>',
    '<audio>Account: 123456, balance: 9000</audio>',
    '<object>Account: 123456, balance: 9000</object>',
  ]) {
    await load(page, `<main><p id="a">First visible paragraph here.</p>${fallback}<p id="b">Second visible paragraph here.</p></main>`);
    const json = await page.evaluate(() => {
      const mc = (window as any).__mc;
      const one = document.createRange();
      one.selectNodeContents(document.getElementById('a')!);
      const across = document.createRange();
      across.setStart(document.getElementById('a')!.firstChild!, 6);
      across.setEnd(document.getElementById('b')!.firstChild!, 6);
      return JSON.stringify([mc.describeRange(document.body, one).selectors, mc.describeRange(document.body, across).selectors]);
    });
    expect(json, fallback).not.toContain('123456');
  }
});

test("a thread on a repeated cell follows its row when a table is re-sorted in place", async ({ page }) => {
  const rows = ['Alice Johnson invoice 1042', 'Oliver Smith invoice 2077', 'Maria Lopez invoice 3150', 'Kenji Sato invoice 4411'];
  await load(
    page,
    `<table>${rows.map((n, i) => `<tr><td id="n${i}">${n}</td><td id="s${i}">Pending approval</td></tr>`).join('')}</table>`,
  );
  await page.evaluate(() => {
    const mc = (window as any).__mc;
    const r = document.createRange();
    r.selectNodeContents(document.getElementById('s0')!);
    const { selectors } = mc.describeRange(document.body, r);
    const m = new mc.AnchorManager(() => document.body, () => false, () => {});
    m.start();
    m.setThreads([{ id: 't', selectors }]);
    (window as any).__m = m;
  });
  const where = () => page.evaluate(() => ((window as any).__m.get('t').range?.startContainer.parentElement as HTMLElement | undefined)?.id ?? null);
  await expect.poll(where, { timeout: 10_000 }).toBe('s0');
  // Sorting reuses the rows and rewrites their cells in place: Alice moves to the third row.
  await page.evaluate(rows => {
    const sorted = [rows[1], rows[2], rows[0], rows[3]];
    sorted.forEach((n, i) => (document.getElementById(`n${i}`)!.textContent = n));
  }, rows);
  await expect.poll(where, { timeout: 10_000 }).toBe('s2');
});

