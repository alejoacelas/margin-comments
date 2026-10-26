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
import { renderedTextFromRange } from './hypothesis/rendered-text';
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
    const parts: string[] = [];
    let offsets = new Int32Array(4096);
    let n = 0;
    let raw = 0;
    const skipCache = new Map<Element, boolean>();
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const data = node.data;
      if (!isSkipped(node, root, skipCache)) {
        if (n + data.length > offsets.length) {
          const bigger = new Int32Array(Math.max(offsets.length * 2, n + data.length));
          bigger.set(offsets);
          offsets = bigger;
        }
        for (let i = 0; i < data.length; i++) {
          if (!isWsCode(data.charCodeAt(i))) offsets[n++] = raw + i;
        }
        parts.push(data.replace(/\s+/g, ''));
      }
      raw += data.length;
    }
    this.text = parts.join('');
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

/** Same set as the regex `\s` (so `text` and `rawOffsets` stay aligned). */
function isWsCode(c: number): boolean {
  return (
    (c >= 9 && c <= 13) ||
    c === 32 ||
    c === 160 ||
    c === 5760 ||
    (c >= 8192 && c <= 8202) ||
    c === 8232 ||
    c === 8233 ||
    c === 8239 ||
    c === 8287 ||
    c === 12288 ||
    c === 65279
  );
}

function isSkipped(node: Node, root: Element, cache: Map<Element, boolean>): boolean {
  const parent = node.parentElement;
  if (!parent || parent === root) return false;
  const cached = cache.get(parent);
  if (cached !== undefined) return cached;
  let el: Element | null = parent;
  let skipped = false;
  while (el && el !== root) {
    if (SKIP_TAGS.has(el.tagName)) {
      skipped = true;
      break;
    }
    el = el.parentElement;
  }
  cache.set(parent, skipped);
  return skipped;
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
  // Same text representation as the quote (scripts/styles excluded).
  const verifies = (r: Range) => !r.collapsed && stripWs(renderedTextFromRange(r)) === exactStripped;
  const index = options.index && options.index.root === root ? options.index : new TextIndex(root);

  // The saved range/position are only trusted when the quote is unique on
  // the page: with repeats, content inserted above can shift them onto a
  // different occurrence, and only context matching picks the right one.
  const first = index.text.indexOf(exactStripped);
  const unique = first >= 0 && index.text.indexOf(exactStripped, first + 1) < 0;

  if (rangeSel && unique) {
    try {
      const r = RangeAnchor.fromSelector(root, rangeSel).toRange();
      if (verifies(r)) return { range: r, method: 'range', quoteScore: 1 };
    } catch {
      // fall through
    }
  }
  if (position && unique) {
    try {
      const r = TextPositionAnchor.fromSelector(root, position).toRange();
      if (verifies(r)) return { range: r, method: 'position', quoteScore: 1 };
    } catch {
      // fall through
    }
  }

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
    // An exact match whose surroundings don't fit may be a repeat of a
    // passage that was edited where the thread was. The passage itself wins
    // only when it is clearly still there: lightly edited text in the
    // original surroundings, against an exact copy in mostly different
    // surroundings. (A changed name in a list of similar items, say
    // setEndAfter -> setEndBefore, is a different item: the exact text wins.)
    const top = candidates[0];
    // Only the context sides we have count (a quote can start or end the page).
    const sides = top ? [prefix ? top.prefixScore : -1, suffix ? top.suffixScore : -1].filter(x => x >= 0) : [];
    const topContext = sides.length ? sides.reduce((a, b) => a + b, 0) / sides.length : 1;
    if (top && top.quoteScore === 1 && sides.length && q.length >= 20 && topContext < 0.5) {
      const near = matchQuoteCandidates(text, q, { prefix, suffix, hint }, true).find(c => c.quoteScore < 1);
      if (near && near.quoteScore >= 0.85 && near.prefixScore >= 0.95 && near.suffixScore >= 0.95) candidates = [near, ...candidates];
    }
  }
  if (candidates.length === 0) return null;

  const best = candidates[0];
  const exactCount = candidates.filter(c => c.quoteScore === 1).length;
  if (!acceptable(best, q.length, !!prefix || !!suffix, exactCount === 1)) return null;

  // Prefer a visible match (hidden text can't be highlighted for the reader):
  // responsive pages often render the same passage twice and hide one copy.
  // A visible candidate wins if it's about as good a quote match and not much
  // worse on context; for long quotes (identical long text is the same
  // passage) context may differ entirely.
  const contextSlack = q.length >= 40 ? 0.45 : 0.15;
  const contenders = candidates.filter(c => c.quoteScore >= best.quoteScore - 0.05 && c.score >= best.score - contextSlack).slice(0, 10);
  let chosen: { cand: Candidate; range: Range } | null = null;
  for (const cand of contenders) {
    const range = toRange(index, cand);
    if (!range) continue;
    if (!chosen) chosen = { cand, range };
    if (isVisible(range) && acceptable(cand, q.length, !!prefix || !!suffix, exactCount === 1)) {
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
export function acceptable(c: Candidate, quoteLength: number, hasContext: boolean, uniqueExact = false): boolean {
  const context = hasContext ? (c.prefixScore + c.suffixScore) / 2 : 1;
  if (c.quoteScore === 1) {
    // The only exact occurrence on the page is strong evidence by itself
    // (also for CJK, where a few characters are a whole phrase).
    if (uniqueExact && quoteLength >= 8) return true;
    // Short exact strings ("the", "Introduction") recur; demand some context.
    if (quoteLength < 20) return context >= 0.6;
    if (quoteLength < 60) return context >= 0.35;
    return true;
  }
  if (c.quoteScore < 0.75) return false;
  if (quoteLength < 20) return false;
  if (c.quoteScore >= 0.9) return context >= 0.3 || quoteLength >= 60;
  // One side of the context still intact (e.g. a paragraph was inserted just
  // before the passage) plus a mostly intact quote.
  if (hasContext && c.quoteScore >= 0.8 && Math.max(c.prefixScore, c.suffixScore) >= 0.85) return true;
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

/**
 * Can the reader see this text? Needs layout boxes and, for the elements at
 * both ends, no `visibility: hidden` / `content-visibility` / hidden ancestors.
 */
export function isVisible(range: Range): boolean {
  const rects = range.getClientRects();
  let boxed = false;
  for (let i = 0; i < rects.length; i++) {
    if (rects[i].width > 0 && rects[i].height > 0) {
      boxed = true;
      break;
    }
  }
  if (!boxed) return false;
  for (const node of [range.startContainer, range.endContainer]) {
    const el = node instanceof Element ? node : node.parentElement;
    if (!el) continue;
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: false } as CheckVisibilityOptions)) return false;
    } else if (getComputedStyle(el).visibility === 'hidden') {
      return false;
    }
  }
  return true;
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
