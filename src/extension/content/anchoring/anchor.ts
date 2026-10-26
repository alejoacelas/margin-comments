/**
 * Anchoring: turn a DOM selection into W3C selectors, and selectors back into
 * a DOM Range on a (possibly changed) page.
 *
 * Built on Hypothesis's anchoring code (./hypothesis, BSD-2-Clause):
 *  - `describe` produces RangeSelector + TextPositionSelector + TextQuoteSelector.
 *  - Anchoring tries the RangeSelector and TextPositionSelector first, each
 *    verified against the quote, then falls back to Hypothesis's fuzzy quote
 *    matcher (approx-string-match, scored by prefix/suffix/position).
 *
 * Additions here:
 *  - Quote matching runs on a whitespace-free projection of the page text
 *    (script/style excluded), so reformatting, re-indentation and <br>/block
 *    changes never break an anchor.
 *  - An acceptance threshold: a weak match is reported as orphaned instead of
 *    highlighting the wrong text.
 *  - Among near-tied candidates, a visible match wins over a hidden one.
 *  - Long quotes are matched by their head and tail to bound the cost.
 */
import approxSearch from 'approx-string-match';
import type { Selector, TextPositionSelector, TextQuoteSelector, RangeSelector } from '../../../shared/types';
import { describe as hypothesisDescribe } from './hypothesis/html';
import { matchQuoteCandidates } from './hypothesis/match-quote';
import { TextRange } from './hypothesis/text-range';
import { RangeAnchor, TextPositionAnchor } from './hypothesis/types';

export type AnchorMethod = 'range' | 'position' | 'quote' | 'fuzzy';

export type AnchorResult = {
  range: Range;
  method: AnchorMethod;
  /** 1 for verified selectors and exact matches; lower for fuzzy matches. */
  quoteScore: number;
};

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
const WS = /\s/;

export function stripWs(s: string): string {
  return s.replace(/\s+/g, '');
}

export function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Whitespace-free projection of `root`'s text, with a map from each
 * projected character back to its offset in `root.textContent`.
 */
export class TextIndex {
  readonly root: Element;
  readonly text: string;
  /** rawOffsets[i] = offset in root.textContent of text[i]. */
  readonly rawOffsets: Int32Array;
  readonly rawLength: number;

  constructor(root: Element) {
    this.root = root;
    const chars: string[] = [];
    let offsets = new Int32Array(1024);
    let n = 0;
    let raw = 0;
    const push = (c: string, r: number) => {
      if (n === offsets.length) {
        const bigger = new Int32Array(offsets.length * 2);
        bigger.set(offsets);
        offsets = bigger;
      }
      chars.push(c);
      offsets[n++] = r;
    };

    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node) {
      const data = node.data;
      if (!isSkipped(node, root)) {
        for (let i = 0; i < data.length; i++) {
          const c = data[i];
          if (!WS.test(c)) push(c, raw + i);
        }
      }
      raw += data.length;
      node = walker.nextNode() as Text | null;
    }
    this.text = chars.join('');
    this.rawOffsets = offsets.subarray(0, n);
    this.rawLength = raw;
  }

  /** Convert a [start, end) span of `text` into raw textContent offsets. */
  toRaw(start: number, end: number): [number, number] {
    return [this.rawOffsets[start], this.rawOffsets[end - 1] + 1];
  }

  /** Index into `text` of the first character at or after a raw offset. */
  fromRaw(raw: number): number {
    let lo = 0;
    let hi = this.rawOffsets.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.rawOffsets[mid] < raw) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

function isSkipped(node: Node, root: Element): boolean {
  let el = node.parentElement;
  while (el && el !== root) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    el = el.parentElement;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

export type Description = {
  selectors: Selector[];
  /** Human-readable quote (whitespace collapsed). */
  quote: string;
  /** The selection trimmed of surrounding whitespace. */
  range: Range;
};

/**
 * Describe a user selection. Returns null if the range has no text or lies
 * outside `root`.
 */
export function describeRange(root: Element, range: Range): Description | null {
  if (!root.contains(range.commonAncestorContainer)) return null;
  if (!range.toString().trim()) return null;
  let trimmed: Range;
  try {
    trimmed = TextRange.trimmedRange(range);
  } catch {
    return null;
  }
  const selectors = hypothesisDescribe(root, trimmed);
  const quoteSel = selectors.find((s): s is TextQuoteSelector => s.type === 'TextQuoteSelector');
  if (!quoteSel || !stripWs(quoteSel.exact)) return null;
  return { selectors, quote: collapseWs(quoteSel.exact), range: trimmed };
}

// ---------------------------------------------------------------------------
// Anchor
// ---------------------------------------------------------------------------

export type AnchorOptions = {
  /** Reuse a text index across many anchors in one pass. */
  index?: TextIndex;
};

export function anchorSelectors(
  root: Element,
  selectors: Selector[],
  options: AnchorOptions = {},
): AnchorResult | null {
  let quote: TextQuoteSelector | undefined;
  let position: TextPositionSelector | undefined;
  let rangeSel: RangeSelector | undefined;
  for (const s of selectors) {
    if (s.type === 'TextQuoteSelector') quote = s;
    else if (s.type === 'TextPositionSelector') position = s;
    else if (s.type === 'RangeSelector') rangeSel = s;
  }
  if (!quote || !stripWs(quote.exact)) return null;
  const exactStripped = stripWs(quote.exact);
  const verifies = (r: Range) => !r.collapsed && stripWs(r.toString()) === exactStripped;

  if (rangeSel) {
    try {
      const r = RangeAnchor.fromSelector(root, rangeSel).toRange();
      if (verifies(r)) return { range: r, method: 'range', quoteScore: 1 };
    } catch {
      // fall through
    }
  }
  if (position) {
    try {
      const r = TextPositionAnchor.fromSelector(root, position).toRange();
      if (verifies(r)) return { range: r, method: 'position', quoteScore: 1 };
    } catch {
      // fall through
    }
  }

  const index = options.index && options.index.root === root ? options.index : new TextIndex(root);
  return matchQuoteInIndex(index, quote, position?.start);
}

type Candidate = {
  start: number;
  end: number;
  score: number;
  quoteScore: number;
  prefixScore: number;
  suffixScore: number;
};

const LONG_QUOTE = 1000;
const LONG_QUOTE_PART = 256;

function matchQuoteInIndex(
  index: TextIndex,
  quote: TextQuoteSelector,
  rawHint: number | undefined,
): AnchorResult | null {
  const q = stripWs(quote.exact);
  const prefix = quote.prefix ? stripWs(quote.prefix) : undefined;
  const suffix = quote.suffix ? stripWs(quote.suffix) : undefined;
  const hint = typeof rawHint === 'number' ? index.fromRaw(rawHint) : undefined;
  const text = index.text;
  if (!text) return null;

  let candidates: Candidate[];
  if (q.length > LONG_QUOTE && text.indexOf(q) === -1) {
    candidates = matchLongQuote(text, q, prefix, suffix, hint);
  } else {
    candidates = matchQuoteCandidates(text, q, { prefix, suffix, hint });
  }
  if (candidates.length === 0) return null;

  const best = candidates[0];
  if (!acceptable(best, q.length, !!prefix || !!suffix)) return null;

  // Prefer a visible match among near-ties (e.g. a duplicated mobile menu).
  const nearTies = candidates.filter(c => c.score >= best.score - 0.02).slice(0, 10);
  let chosen: { cand: Candidate; range: Range } | null = null;
  for (const cand of nearTies) {
    const range = toRange(index, cand);
    if (!range) continue;
    if (!chosen) chosen = { cand, range };
    if (isVisible(range)) {
      chosen = { cand, range };
      break;
    }
  }
  if (!chosen) return null;
  return {
    range: chosen.range,
    method: chosen.cand.quoteScore === 1 ? 'quote' : 'fuzzy',
    quoteScore: chosen.cand.quoteScore,
  };
}

/**
 * Decide whether the best match is good enough to highlight. When in doubt,
 * orphan: a thread in the sidebar beats a thread on the wrong sentence.
 */
export function acceptable(c: Candidate, quoteLength: number, hasContext: boolean): boolean {
  const context = hasContext ? (c.prefixScore + c.suffixScore) / 2 : 1;
  if (c.quoteScore === 1) {
    // Short exact strings ("the", "Introduction") recur; demand some context.
    if (quoteLength < 20) return context >= 0.6;
    if (quoteLength < 60) return context >= 0.35;
    return true;
  }
  if (c.quoteScore < 0.75) return false;
  if (quoteLength < 20) return false;
  if (c.quoteScore >= 0.9) return context >= 0.3 || quoteLength >= 60;
  return context >= 0.55;
}

function toRange(index: TextIndex, cand: { start: number; end: number }): Range | null {
  if (cand.end <= cand.start) return null;
  const [rawStart, rawEnd] = index.toRaw(cand.start, cand.end);
  try {
    return new TextPositionAnchor(index.root, rawStart, rawEnd).toRange();
  } catch {
    return null;
  }
}

function isVisible(range: Range): boolean {
  const rects = range.getClientRects();
  for (let i = 0; i < rects.length; i++) {
    if (rects[i].width > 0 && rects[i].height > 0) return true;
  }
  return false;
}

/**
 * Fuzzy-match a long quote by locating its head and tail separately, then
 * scoring the span between them. Bounded cost: the expensive comparison is
 * done only over the candidate span, not the whole page.
 */
function matchLongQuote(
  text: string,
  q: string,
  prefix: string | undefined,
  suffix: string | undefined,
  hint: number | undefined,
): Candidate[] {
  const head = q.slice(0, LONG_QUOTE_PART);
  const tail = q.slice(-LONG_QUOTE_PART);
  const heads = matchQuoteCandidates(text, head, { prefix, hint }).slice(0, 5);
  const out: Candidate[] = [];
  for (const h of heads) {
    if (h.quoteScore < 0.7) continue;
    const windowStart = h.start;
    const windowEnd = Math.min(text.length, h.start + Math.ceil(q.length * 1.5));
    const region = text.slice(windowStart, windowEnd);
    const tails = matchQuoteCandidates(region, tail, { suffix, hint: q.length - LONG_QUOTE_PART }).slice(0, 3);
    for (const t of tails) {
      if (t.quoteScore < 0.7) continue;
      const start = h.start;
      const end = windowStart + t.end;
      const span = end - start;
      if (span < q.length * 0.5 || span > q.length * 1.5) continue;
      const maxErrors = Math.ceil(q.length * 0.3);
      const m = approxSearch(text.slice(start, end), q, maxErrors);
      const errors = m.length ? Math.min(...m.map(x => x.errors)) : Math.abs(span - q.length) + maxErrors;
      const quoteScore = Math.max(0, 1 - errors / q.length);
      const score = (50 * quoteScore + 20 * h.prefixScore + 20 * t.suffixScore + 2) / 92;
      out.push({ start, end, score, quoteScore, prefixScore: h.prefixScore, suffixScore: t.suffixScore });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

export function quoteOf(selectors: Selector[]): string {
  const q = selectors.find((s): s is TextQuoteSelector => s.type === 'TextQuoteSelector');
  return q ? collapseWs(q.exact) : '';
}
