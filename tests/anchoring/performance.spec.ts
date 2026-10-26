// Anchoring cost on a very large page (~2 million characters, 15,000 paragraphs).
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

test('anchoring stays fast on a very large page', async ({ page }) => {
  const bundle = (await build({ entryPoints: ['tests/anchoring/harness.ts'], bundle: true, write: false, format: 'iife', target: 'chrome120', logLevel: 'error' })).outputFiles[0].text;
  await page.route('**/*', r => (r.request().url() === 'http://perf.test/' ? r.fulfill({ body: '<!doctype html><html><body><main id="m"></main></body></html>', contentType: 'text/html' }) : r.abort()));
  await page.goto('http://perf.test/');
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(() => {
    const words = 'reader margin note quote thread anchor fuzzy paragraph comment highlight text page web share friend book essay idea'.split(' ');
    let seed = 7;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const main = document.getElementById('m')!;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 15000; i++) {
      const p = document.createElement('p');
      const n = 18 + Math.floor(rand() * 10);
      p.textContent = `${i}. ` + Array.from({ length: n }, () => words[Math.floor(rand() * words.length)]).join(' ') + '.';
      frag.appendChild(p);
    }
    main.appendChild(frag);
    const mc = (window as any).__mc;
    const total = document.body.textContent!.length;
    // Selections near the end, then make every one of them a fuzzy case by editing a word.
    const sels = mc.makeSelections('perf', 25);
    for (const p of Array.from(main.querySelectorAll('p')).slice(-20000)) {
      if (p.textContent!.includes('margin')) p.textContent = p.textContent!.replace('margin', 'marginal');
    }
    const t0 = performance.now();
    const res = mc.anchorAll(sels);
    const ms = performance.now() - t0;
    const max = Math.max(...res.results.map((r: any) => r.ms));
    return { total, ms, max, anchored: res.results.filter((r: any) => r.anchored).length, n: sels.length };
  });
  console.log(`large page: ${result.total} chars, ${result.n} anchors in ${result.ms.toFixed(0)} ms (slowest ${result.max.toFixed(0)} ms), ${result.anchored} anchored`);
  expect(result.total).toBeGreaterThan(1_500_000);
  expect(result.max).toBeLessThan(2000);
  expect(result.ms).toBeLessThan(15_000);
});
