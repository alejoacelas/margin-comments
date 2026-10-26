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

// Text that is never page text: code, templates, and a textarea's children
// (its initial value, not what it shows).
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA']);

/**
 * Is a node (text, or an element's content) shown to the reader? Two parts:
 * the visibility of the element it renders in (computed, so inheritance and
 * `visibility:visible` overrides are right), and whether that element is
 * rendered at all: `checkVisibility` (display:none ancestors, content hidden
 * by a closed <details> or content-visibility), looking through
 * `display:contents` elements (no box of their own; default for <slot>), and
 * a closed <details> shows only its <summary> (text directly inside it has
 * no element of its own for checkVisibility to judge).
 */
export function nodeShown(node: Node, cache: VisibilityCache = newVisibilityCache()): boolean {
  const el = renderingParent(node, cache);
  if (el === undefined) return false;
  if (!el) return true;
  if (closedDetailsHides(el, node) || contentHidden(el)) return false;
  if (getComputedStyle(el).visibility !== 'visible') return false;
  return rendered(el, cache);
}

/** Per-pass memo for visibility checks (styles don't change within one). */
export type VisibilityCache = { shown: Map<Element, boolean>; closedRoots: Map<Element, ShadowRoot | null> };

export function newVisibilityCache(): VisibilityCache {
  return { shown: new Map(), closedRoots: new Map() };
}

function rendered(el: Element, cache: VisibilityCache): boolean {
  const cached = cache.shown.get(el);
  if (cached !== undefined) return cached;
  let shown: boolean;
  if (typeof el.checkVisibility !== 'function') shown = true;
  else if (getComputedStyle(el).display === 'contents') {
    const parent = renderingParent(el, cache);
    shown = parent === null || (parent !== undefined && !closedDetailsHides(parent, el) && !contentHidden(parent) && rendered(parent, cache));
  } else {
    shown = el.checkVisibility({ contentVisibilityAuto: false } as CheckVisibilityOptions);
  }
  cache.shown.set(el, shown);
  return shown;
}

/** `content-visibility: hidden`: the element's box shows, its contents don't. */
function contentHidden(el: Element): boolean {
  return (getComputedStyle(el) as CSSStyleDeclaration & { contentVisibility?: string }).contentVisibility === 'hidden';
}

/** A closed <details> renders only its (first) <summary>. */
function closedDetailsHides(parent: Element, child: Node): boolean {
  if (parent.localName !== 'details' || (parent as HTMLDetailsElement).open) return false;
  return !(child instanceof Element && child.localName === 'summary' && parent.querySelector(':scope > summary') === child);
}

/**
 * A web component's closed shadow root. Pages can't reach it, but content
 * scripts can (chrome.dom), and we need it to know which of the host's
 * children it renders, and where.
 */
function closedShadowRoot(el: Element, cache: VisibilityCache): ShadowRoot | null {
  if (el.shadowRoot) return null;
  let root = cache.closedRoots.get(el);
  if (root === undefined) {
    const dom = (globalThis as unknown as { chrome?: { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } } }).chrome?.dom;
    try {
      root = dom?.openOrClosedShadowRoot?.(el) ?? null;
    } catch {
      root = null;
    }
    cache.closedRoots.set(el, root);
  }
  return root;
}

/**
 * Where a node renders: its slot if slotted into a web component (also a
 * closed one), else its parent (or shadow host). `undefined`: nowhere, a
 * child of a closed web component that no slot shows.
 */
function renderingParent(node: Node, cache: VisibilityCache): Element | null | undefined {
  const slot = (node as Element | Text).assignedSlot;
  if (slot) return slot;
  const parent = node.parentElement;
  if (parent) {
    const closed = closedShadowRoot(parent, cache);
    if (!closed) return parent;
    for (const s of closed.querySelectorAll('slot')) if (s.assignedNodes().includes(node as ChildNode)) return s;
    return undefined;
  }
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

export function stripWs(s: string): string {
  return s.replace(/\s+/g, '');
}

export function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Whitespace-free projection of the page text under `root`, as rendered: open
 * shadow roots (web components) are walked in place of their host's light
 * children, and slots show what's assigned to them. Keeps a map from each
 * projected character back to its "raw" offset: the offset in the
 * concatenation of all text nodes walked (script/style included, as in
 * `textContent`; for pages without shadow roots raw offsets are exactly
 * `root.textContent` offsets).
 */
export class TextIndex {
  readonly root: Element;
  readonly text: string;
  /** rawOffsets[i] = raw offset of text[i]. */
  readonly rawOffsets: Int32Array;
  readonly rawLength: number;
  /** Every text node walked, in order, with its raw start offset. */
  private readonly nodes: Text[] = [];
  private readonly starts: number[] = [];
  /** Per node: script/style/… text, not part of the rendered text. */
  private readonly skipped: boolean[] = [];
  private nodeIndex: Map<Text, number> | null = null;
  /** Open shadow roots whose content is part of the text (to observe for changes). */
  readonly shadowRoots: ShadowRoot[] = [];

  constructor(root: Element) {
    this.root = root;
    const parts: string[] = [];
    let offsets = new Int32Array(4096);
    let n = 0;
    let raw = 0;
    // Text that isn't rendered (hidden, display:none, visibility:hidden) is
    // treated like script text: counted in raw offsets, but never matched,
    // quoted or used as context (selectors are stored and shown to everyone).
    const shownCache = newVisibilityCache();
    const add = (node: Text, skippedTag: boolean) => {
      const data = node.data;
      const skipped = skippedTag || (data.trim() !== '' && !nodeShown(node, shownCache));
      this.nodes.push(node);
      this.starts.push(raw);
      this.skipped.push(skipped);
      if (!skipped) {
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
    };
    const doc = root.ownerDocument;
    const walkTree = (top: Node, topSkipped: boolean, inShadow: boolean) => {
      const skipCache = new Map<Element, boolean>();
      const walker = doc.createTreeWalker(top, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        if (node.nodeType === Node.TEXT_NODE) {
          add(node as Text, topSkipped || isSkipped(node, top, skipCache));
          node = walker.nextNode();
          continue;
        }
        const el = node as Element;
        const shadow = el.shadowRoot;
        if (shadow) {
          // A web component: what renders is its shadow tree.
          this.shadowRoots.push(shadow);
          walkTree(shadow, topSkipped || isSkipped(el, top, skipCache) || SKIP_TAGS.has(el.tagName), true);
        } else if (inShadow && el.localName === 'slot') {
          const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
          if (assigned.length === 0) {
            node = walker.nextNode(); // fallback content
            continue;
          }
          const sk = topSkipped || isSkipped(el, top, skipCache);
          for (const a of assigned) {
            if (a.nodeType === Node.TEXT_NODE) add(a as Text, sk);
            else if (a.nodeType === Node.ELEMENT_NODE) walkElement(a as Element, sk);
          }
        } else {
          node = walker.nextNode();
          continue;
        }
        // Skip the element's own light children (rendered via slots, if at all).
        node = nextOutside(walker, top);
      }
    };
    /** An element and its subtree (slotted content). */
    const walkElement = (el: Element, skipped: boolean) => {
      const sk = skipped || SKIP_TAGS.has(el.tagName);
      if (el.shadowRoot) {
        this.shadowRoots.push(el.shadowRoot);
        walkTree(el.shadowRoot, sk, true);
      } else {
        walkTree(el, sk, false);
      }
    };
    walkTree(root, false, false);
    this.text = parts.join('');
    this.rawOffsets = offsets.subarray(0, n);
    this.rawLength = raw;
  }

  /** Convert a [start, end) span of `text` into raw offsets. */
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

  /** The text node containing raw offset `raw` (the last one starting at or before it). */
  private nodeAt(raw: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= raw) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * A DOM Range for raw offsets [start, end): from the character at `start`
   * to the one before `end`. Null if empty, out of bounds, or spanning
   * different trees (a Range can't cross a shadow boundary).
   */
  rangeFor(start: number, end: number): Range | null {
    if (end <= start || start < 0 || end > this.rawLength || this.nodes.length === 0) return null;
    let i = this.nodeAt(start);
    // Start inside a node (skip empty nodes / a start at a node's very end).
    while (i < this.nodes.length - 1 && start - this.starts[i] >= this.nodes[i].length) i++;
    const j = this.nodeAt(end - 1);
    const a = this.nodes[i];
    const b = this.nodes[j];
    if (a.getRootNode() !== b.getRootNode()) return null;
    const range = a.ownerDocument.createRange();
    range.setStart(a, Math.min(a.length, start - this.starts[i]));
    range.setEnd(b, Math.min(b.length, end - this.starts[j]));
    return range;
  }

  /** Raw offset of a DOM position inside a walked text node (null otherwise). */
  rawOffsetOf(node: Node, offset: number): number | null {
    if (node.nodeType !== Node.TEXT_NODE) return null;
    if (!this.nodeIndex) {
      this.nodeIndex = new Map();
      this.nodes.forEach((t, k) => this.nodeIndex!.set(t, k));
    }
    const k = this.nodeIndex.get(node as Text);
    return k === undefined ? null : this.starts[k] + offset;
  }

  /**
   * Up to `count` characters of rendered text (script/style excluded, as in
   * matching) just before or after a raw offset.
   */
  renderedAround(raw: number, count: number, side: 'before' | 'after'): string {
    if (this.nodes.length === 0) return '';
    let out = '';
    let k = this.nodeAt(Math.max(0, Math.min(raw, this.rawLength - 1)));
    if (side === 'before') {
      for (; k >= 0 && out.length < count; k--) {
        if (this.skipped[k]) continue;
        const data = this.nodes[k].data.slice(0, Math.max(0, raw - this.starts[k]));
        out = data + out;
      }
      return out.slice(-count);
    }
    for (; k < this.nodes.length && out.length < count; k++) {
      if (this.skipped[k]) continue;
      out += this.nodes[k].data.slice(Math.max(0, raw - this.starts[k]));
    }
    return out.slice(0, count);
  }

  /** The rendered text between two raw offsets (script/style excluded, as in matching). */
  renderedSlice(start: number, end: number): string {
    start = Math.max(0, start);
    end = Math.min(this.rawLength, end);
    let out = '';
    for (let k = this.nodeAt(start); k < this.nodes.length && this.starts[k] < end; k++) {
      if (this.skipped[k]) continue;
      const s = this.starts[k];
      out += this.nodes[k].data.slice(Math.max(0, start - s), Math.max(0, end - s));
    }
    return out;
  }

  /**
   * Raw offsets of a DOM range, shrunk to its first and last rendered
   * non-space characters (null if it has none or isn't in walked text).
   */
  trimmedRawSpan(range: Range): [number, number] | null {
    const a = this.rawOffsetOfBoundary(range.startContainer, range.startOffset, true);
    const b = this.rawOffsetOfBoundary(range.endContainer, range.endOffset, false);
    if (a === null || b === null || b <= a) return null;
    const first = this.fromRaw(a);
    const last = this.fromRaw(b) - 1;
    if (first >= this.rawOffsets.length || last < first) return null;
    return [this.rawOffsets[first], this.rawOffsets[last] + 1];
  }

  /** Like rawOffsetOf, also for a boundary between nodes (an element or shadow root container). */
  private rawOffsetOfBoundary(container: Node, offset: number, forward: boolean): number | null {
    if (container.nodeType === Node.TEXT_NODE) return this.rawOffsetOf(container, offset);
    // The nearest walked text node after (or before) the boundary point.
    const probe = container.ownerDocument!.createRange();
    probe.setStart(container, offset);
    let best: number | null = null;
    for (let k = 0; k < this.nodes.length; k++) {
      const t = this.nodes[k];
      if (t.getRootNode() !== container.getRootNode()) continue;
      const cmp = probe.comparePoint(t, 0);
      if (forward && cmp >= 0) return this.starts[k];
      if (!forward && cmp < 0) best = this.starts[k] + t.length;
    }
    return forward ? null : best;
  }

  /** The raw text between two raw offsets (as `textContent` would have it). */
  rawSlice(start: number, end: number): string {
    start = Math.max(0, start);
    end = Math.min(this.rawLength, end);
    let out = '';
    for (let k = this.nodeAt(start); k < this.nodes.length && this.starts[k] < end; k++) {
      const s = this.starts[k];
      out += this.nodes[k].data.slice(Math.max(0, start - s), Math.max(0, end - s));
    }
    return out;
  }
}

/** Move a TreeWalker past the current node's subtree (stays within `top`). */
function nextOutside(walker: TreeWalker, top: Node): Node | null {
  for (let n: Node | null = walker.currentNode; n && n !== top; n = walker.parentNode()) {
    const sib = walker.nextSibling();
    if (sib) return sib;
  }
  return null;
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

function isSkipped(node: Node, root: Node, cache: Map<Element, boolean>): boolean {
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

/** Is `node` inside `root`, also through (open or closed) shadow boundaries? */
export function composedContains(root: Node, node: Node | null): boolean {
  for (let n: Node | null = node; n; ) {
    if (root.contains(n)) return true;
    const r = n.getRootNode();
    n = r instanceof ShadowRoot ? r.host : null;
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
export function describeRange(root: Element, range: Range, opts: { index?: TextIndex } = {}): Description | null {
  const inShadow = range.commonAncestorContainer.getRootNode() instanceof ShadowRoot;
  if (inShadow ? !composedContains(root, range.commonAncestorContainer) : !root.contains(range.commonAncestorContainer)) return null;
  if (!range.toString().trim()) return null;
  const index = opts.index && opts.index.root === root ? opts.index : new TextIndex(root);
  if (inShadow) {
    // Hypothesis's trimming needs element parents (text can sit directly
    // under a shadow root): trim through the index instead.
    const span = index.trimmedRawSpan(range);
    const trimmedRange = span && index.rangeFor(span[0], span[1]);
    if (!span || !trimmedRange) return null;
    const sels = describeWithIndex(index, trimmedRange, span);
    const q = sels?.find((s): s is TextQuoteSelector => s.type === 'TextQuoteSelector');
    return sels && q && stripWs(q.exact) ? { selectors: sels, quote: collapseWs(q.exact), range: trimmedRange } : null;
  }
  let trimmed: Range;
  try {
    trimmed = TextRange.trimmedRange(range);
  } catch {
    return null;
  }
  // Position, quote and context come from our index, i.e. the rendered text
  // that matching uses: script/style text never enters a selector (it's
  // stored and shown to everyone; Hypothesis's context could include an
  // adjacent inline <script>'s data), and pages with web components get
  // consistent offsets. Hypothesis adds the light-DOM XPath as a hint.
  const hyp = hypothesisDescribe(root, trimmed);
  const own = describeWithIndex(index, trimmed) ?? describeWithIndex(index, trimmed, index.trimmedRawSpan(trimmed) ?? undefined);
  if (!own) return null;
  const selectors: Selector[] = [...hyp.filter(s => s.type === 'RangeSelector'), ...own];
  const quoteSel = selectors.find((s): s is TextQuoteSelector => s.type === 'TextQuoteSelector');
  if (!quoteSel || !stripWs(quoteSel.exact)) return null;
  return { selectors, quote: collapseWs(quoteSel.exact), range: trimmed };
}

/**
 * Position and quote selectors from the page's rendered text (our index), for
 * text inside web components (where Hypothesis's light-DOM describe can't
 * reach, and XPath can't cross a shadow boundary) and on pages that have them.
 */
function describeWithIndex(index: TextIndex, range: Range, span?: [number, number]): Selector[] | null {
  const start = span ? span[0] : index.rawOffsetOf(range.startContainer, range.startOffset);
  const end = span ? span[1] : index.rawOffsetOf(range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  const CONTEXT = 32;
  return [
    { type: 'TextPositionSelector', start, end },
    {
      type: 'TextQuoteSelector',
      // Rendered text only: an inline <script>/<style> inside the selection
      // isn't part of the quote (and must never be published with it).
      exact: index.renderedSlice(start, end),
      // Context from rendered text (components often start with a <style>),
      // as matching sees it.
      prefix: index.renderedAround(start, CONTEXT, 'before'),
      suffix: index.renderedAround(end, CONTEXT, 'after'),
    },
  ];
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
  const index = options.index && options.index.root === root ? options.index : new TextIndex(root);
  // The range's rendered text (as the index sees it: no script, style or
  // hidden text) must be the quote; a range with none (e.g. a copy the page
  // has hidden) doesn't verify.
  const verifies = (r: Range) => {
    if (r.collapsed) return false;
    const span = index.trimmedRawSpan(r);
    return !!span && stripWs(index.renderedSlice(span[0], span[1])) === exactStripped;
  };

  // The saved range/position are only trusted when the quote is unique on
  // the page: with repeats, content inserted above can shift them onto a
  // different occurrence, and only context matching picks the right one.
  const first = index.text.indexOf(exactStripped);
  const unique = first >= 0 && index.text.indexOf(exactStripped, first + 1) < 0;

  let shortcut: AnchorResult | null = null;
  if (rangeSel && unique) {
    try {
      const r = RangeAnchor.fromSelector(root, rangeSel).toRange();
      if (verifies(r)) shortcut = { range: r, method: 'range', quoteScore: 1 };
    } catch {
      // fall through
    }
  }
  if (!shortcut && position && unique) {
    const r = index.rangeFor(position.start, position.end);
    if (r && verifies(r)) shortcut = { range: r, method: 'position', quoteScore: 1 };
  }

  const viaQuote = matchQuoteInIndex(index, quote, position?.start);
  // The saved range lands on the only exact copy, but that copy may be a
  // repeat elsewhere while the thread's own passage was lightly edited (and
  // moved): quote matching then picks the passage (see matchQuoteInIndex).
  if (shortcut && viaQuote?.method === 'fuzzy') return viaQuote;
  return shortcut ?? viaQuote;
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
    // only when it is clearly still there: lightly edited text in (mostly)
    // the original surroundings, against an exact copy in mostly different
    // surroundings. (A changed name in a list of similar items, say
    // setEndAfter -> setEndBefore, is a different item: the exact text wins.)
    const top = candidates[0];
    // Only the context sides we have count (a quote can start or end the page).
    const sides = top ? [prefix ? top.prefixScore : -1, suffix ? top.suffixScore : -1].filter(x => x >= 0) : [];
    const topContext = sides.length ? sides.reduce((a, b) => a + b, 0) / sides.length : 1;
    if (top && top.quoteScore === 1 && sides.length && q.length >= 20 && topContext < 0.5) {
      const near = matchQuoteCandidates(text, q, { prefix, suffix, hint }, true).find(c => c.quoteScore < 1);
      // One side of its surroundings intact (the other may change when the
      // passage moves), mostly intact overall.
      const nearOk = near && near.quoteScore >= 0.85 && Math.max(near.prefixScore, near.suffixScore) >= 0.95 && (near.prefixScore + near.suffixScore) / 2 >= 0.75;
      if (near && nearOk) candidates = [near, ...candidates];
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
  return index.rangeFor(rawStart, rawEnd);
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
    const shown = node instanceof Element ? getComputedStyle(node).visibility === 'visible' && rendered(node, newVisibilityCache()) : nodeShown(node);
    if (!shown) return false;
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
