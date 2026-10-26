// Bundled into an IIFE and injected into corpus pages by corpus.spec.ts.
import { anchorSelectors, describeRange, stripWs, TextIndex } from '../../src/extension/content/anchoring/anchor';
import { AnchorManager } from '../../src/extension/content/anchoring/manager';
import { renderedTextFromRange } from '../../src/extension/content/anchoring/hypothesis/rendered-text';
import { TextRange } from '../../src/extension/content/anchoring/hypothesis/text-range';
import type { Selector } from '../../src/shared/types';

function rawOffset(range: Range): number {
  return TextRange.fromRange(range).relativeTo(document.body).start.offset;
}

/** Seeded selections that look like what people select: word-aligned, 1 word to many paragraphs. */
function makeSelections(seedText: string, count: number) {
  let seed = 0;
  for (const ch of seedText) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (!n.data.trim() || n.parentElement?.closest('script,style,noscript,template')) continue;
    const r = document.createRange();
    r.selectNodeContents(n);
    if (r.getClientRects().length === 0) continue; // hidden
    nodes.push(n);
  }
  const out: Array<{ selectors: Selector[]; quote: string; rawStart: number; length: number }> = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 20 && nodes.length) {
    const bucket = rand();
    const target = bucket < 0.25 ? 8 + rand() * 22 : bucket < 0.7 ? 30 + rand() * 170 : bucket < 0.95 ? 200 + rand() * 1000 : 1200 + rand() * 2800;
    const i = Math.floor(rand() * nodes.length);
    const start = nodes[i];
    let startOffset = Math.floor(rand() * start.data.length);
    while (startOffset > 0 && /\S/.test(start.data[startOffset - 1])) startOffset--; // word start
    let remaining = target;
    let j = i;
    let endNode = start;
    let endOffset = startOffset;
    while (j < nodes.length) {
      endNode = nodes[j];
      const from = j === i ? startOffset : 0;
      const avail = endNode.data.length - from;
      if (avail >= remaining) {
        endOffset = from + Math.floor(remaining);
        while (endOffset < endNode.data.length && /\S/.test(endNode.data[endOffset])) endOffset++; // word end
        break;
      }
      remaining -= avail;
      endOffset = endNode.data.length;
      j++;
    }
    const range = document.createRange();
    range.setStart(start, startOffset);
    range.setEnd(endNode, endOffset);
    const desc = describeRange(document.body, range);
    if (!desc) continue;
    out.push({ selectors: desc.selectors, quote: desc.quote, rawStart: rawOffset(desc.range), length: stripWs(desc.quote).length });
  }
  return out;
}

/** Describe selections of specific texts (e.g. around known edits). */
function selectionsFor(texts: string[]) {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let all = '';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    starts.push(all.length);
    nodes.push(n);
    all += n.data;
  }
  const locate = (offset: number) => {
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { node: nodes[lo], offset: offset - starts[lo] };
  };
  const out: Array<{ selectors: Selector[]; quote: string; rawStart: number; length: number }> = [];
  for (const t of texts) {
    const at = all.indexOf(t);
    if (at < 0 || !t.trim()) continue;
    const a = locate(at);
    const b = locate(at + t.length);
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, Math.min(b.offset, b.node.data.length));
    const desc = describeRange(document.body, range);
    if (desc) out.push({ selectors: desc.selectors, quote: desc.quote, rawStart: rawOffset(desc.range), length: stripWs(desc.quote).length });
  }
  return out;
}

type Result = {
  anchored: boolean;
  method?: string;
  quoteScore?: number;
  text?: string;
  rawStart?: number;
  /** Start/end of the anchored text in the whitespace-free page text. */
  sStart?: number;
  sEnd?: number;
  ms: number;
};

function anchorAll(list: Array<{ selectors: Selector[] }>, opts: { quoteOnly?: boolean } = {}): { results: Result[]; text: string } {
  const index = new TextIndex(document.body);
  const results = list.map(({ selectors }) => {
    const sels = opts.quoteOnly ? selectors.filter(s => s.type === 'TextQuoteSelector') : selectors;
    const t0 = performance.now();
    const r = anchorSelectors(document.body, sels, { index });
    const ms = performance.now() - t0;
    if (!r) return { anchored: false, ms };
    const raw = rawOffset(r.range);
    // Visible text (inline <style>/<script> excluded, as in quotes).
    const text = renderedTextFromRange(r.range);
    const sStart = index.fromRaw(raw);
    return { anchored: true, method: r.method, quoteScore: r.quoteScore, text, rawStart: raw, sStart, sEnd: sStart + stripWs(text).length, ms };
  });
  return { results, text: index.text };
}

(window as unknown as { __mc: unknown }).__mc = { makeSelections, selectionsFor, anchorAll, stripWs, describeRange, anchorSelectors, AnchorManager };
