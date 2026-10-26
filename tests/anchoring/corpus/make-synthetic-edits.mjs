// Create edited.html for corpus pages whose meta.json says "editKind": "synthetic".
//
//   node tests/anchoring/corpus/make-synthetic-edits.mjs [slug ...]
//
// Loads original.html in Chromium with JavaScript disabled (no network) and
// applies realistic, deterministic edits (seeded by the slug):
//   - insert an editor's-note paragraph near the top
//   - delete one paragraph in the middle
//   - replace a word in four sentences (copy edits)
//   - reflow whitespace in one paragraph and change punctuation in another
//   - wrap a few words in new <em>/<a> elements (splits text nodes)
//   - move one paragraph from the second half to the first half
// Every edit is recorded in meta.json "edits" so tests know the ground truth.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const dir = dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const slugs = readdirSync(dir).filter(s => existsSync(join(dir, s, 'meta.json')));

const browser = await chromium.launch();
for (const slug of slugs) {
  if (only.length && !only.includes(slug)) continue;
  const metaPath = join(dir, slug, 'meta.json');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  if (meta.editKind !== 'synthetic') continue;
  const html = readFileSync(join(dir, slug, 'original.html'), 'utf8');
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.route('**/*', route => (route.request().url() === 'http://corpus.test/' ? route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' }) : route.abort()));
  await page.goto('http://corpus.test/');
  const result = await page.evaluate(seedText => {
    let seed = 0;
    for (const ch of seedText) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pick = arr => arr[Math.floor(rand() * arr.length)];
    const edits = [];
    const textOf = el => el.textContent.replace(/\s+/g, ' ').trim();
    // Paragraph-like units: <p>/<li> elements, or (old-school pages that
    // separate paragraphs with <br><br>) long bare text runs.
    const paragraphs = () => {
      const els = [...document.body.querySelectorAll('p, li')].filter(
        p => textOf(p).length >= 120 && !p.closest('nav, header, footer, aside') && p.querySelectorAll('p, li').length === 0,
      );
      if (els.length >= 6) return els;
      const runs = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) if (n.data.replace(/\s+/g, ' ').trim().length >= 120) runs.push(n);
      return runs;
    };
    const textNodesIn = unit => {
      if (unit.nodeType === Node.TEXT_NODE) return [unit];
      const out = [];
      const w = document.createTreeWalker(unit, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n);
      return out;
    };

    // 1. Editor's note near the top.
    const ps0 = paragraphs();
    if (ps0.length) {
      const text = "Editor's note: this piece was updated after publication with corrections and a few new passages.";
      if (ps0[0].nodeType === Node.TEXT_NODE) {
        ps0[0].before(document.createTextNode(text), document.createElement('br'), document.createElement('br'));
      } else {
        const note = document.createElement('p');
        note.textContent = text;
        ps0[0].before(note);
      }
      edits.push({ type: 'insert', after: text });
    }

    // 2. Delete a paragraph from the middle.
    const ps1 = paragraphs();
    const victim = ps1[Math.floor(ps1.length / 2)];
    if (victim) {
      edits.push({ type: 'delete', before: victim.textContent });
      victim.remove();
    }

    // 3. Copy edits: replace one word in four paragraphs.
    const replacements = ['notably', 'arguably', 'clearly', 'roughly', 'perhaps', 'largely', 'frankly', 'simply'];
    const used = new Set();
    for (let i = 0; i < 4; i++) {
      const ps = paragraphs().filter(p => !used.has(p));
      if (!ps.length) break;
      const p = pick(ps);
      used.add(p);
      const nodes = textNodesIn(p).filter(n => /[A-Za-z]{6,}/.test(n.data));
      if (!nodes.length) continue;
      const node = pick(nodes);
      const words = [...node.data.matchAll(/[A-Za-z]{6,}/g)];
      const w = pick(words);
      const to = pick(replacements);
      const at = w.index;
      const ctxBefore = node.data.slice(Math.max(0, at - 40), at);
      const ctxAfter = node.data.slice(at + w[0].length, at + w[0].length + 40);
      node.data = node.data.slice(0, at) + to + node.data.slice(at + w[0].length);
      edits.push({ type: 'replace-word', from: w[0], to, before: ctxBefore + w[0] + ctxAfter, after: ctxBefore + to + ctxAfter });
    }

    // 4a. Reflow whitespace in one paragraph (text unchanged apart from whitespace).
    const ps2 = paragraphs().filter(p => !used.has(p));
    const reflow = ps2.length ? pick(ps2) : null;
    if (reflow) {
      used.add(reflow);
      for (const n of textNodesIn(reflow)) n.data = n.data.replace(/ /g, (m, i) => (i % 7 === 3 ? '\n      ' : ' '));
      edits.push({ type: 'whitespace', before: textOf(reflow) });
    }
    // 4b. Punctuation: first comma -> semicolon in one paragraph.
    const ps3 = paragraphs().filter(p => !used.has(p) && /,/.test(p.textContent));
    if (ps3.length) {
      const p = pick(ps3);
      used.add(p);
      for (const n of textNodesIn(p)) {
        const i = n.data.indexOf(',');
        if (i >= 0) {
          const before = n.data.slice(Math.max(0, i - 40), i + 40);
          n.data = n.data.slice(0, i) + ';' + n.data.slice(i + 1);
          edits.push({ type: 'replace-word', from: ',', to: ';', before, after: before.replace(',', ';') });
          break;
        }
      }
    }

    // 5. Wrap a few words in new inline elements.
    for (let i = 0; i < 3; i++) {
      const ps = paragraphs().filter(p => !used.has(p));
      if (!ps.length) break;
      const p = pick(ps);
      used.add(p);
      const nodes = textNodesIn(p).filter(n => n.data.trim().split(/\s+/).length > 6);
      if (!nodes.length) continue;
      const node = pick(nodes);
      const m = /\S+\s+\S+\s+\S+/.exec(node.data.slice(Math.floor(node.data.length / 3)));
      if (!m) continue;
      const start = Math.floor(node.data.length / 3) + m.index;
      const r = document.createRange();
      r.setStart(node, start);
      r.setEnd(node, start + m[0].length);
      const el = document.createElement(i % 2 ? 'a' : 'em');
      if (el.tagName === 'A') el.setAttribute('href', '#added-link');
      r.surroundContents(el);
      edits.push({ type: 'wrap', tag: el.tagName.toLowerCase(), text: m[0] });
    }

    // 6. Move a paragraph from the second half to the first half.
    const ps4 = paragraphs().filter(p => !used.has(p));
    if (ps4.length > 4) {
      const mover = ps4[Math.floor(ps4.length * 0.8)];
      const target = ps4[Math.floor(ps4.length * 0.2)];
      target.before(mover);
      edits.push({ type: 'move', text: textOf(mover) });
    }
    return { html: '<!DOCTYPE html>\n' + document.documentElement.outerHTML, edits };
  }, slug);
  writeFileSync(join(dir, slug, 'edited.html'), result.html);
  meta.edits = result.edits;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  console.log(`${slug}: ${result.edits.length} edits`);
  await context.close();
}
await browser.close();
