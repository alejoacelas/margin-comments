import type { Selector, TextQuoteSelector } from '../../../shared/types';
import { anchorSelectors, isVisible, stripWs, TextIndex } from './anchor';

export type AnchorState =
  | { status: 'anchored'; range: Range; fuzzy: boolean }
  | { status: 'orphan' }
  | { status: 'pending' };

type Entry = {
  id: string;
  selectors: Selector[];
  exactStripped: string;
  state: AnchorState;
  /** Whitespace-free text the range covered when anchored (validity check). */
  anchoredText: string;
  createdAt: number;
  tries: number;
  nextTry: number;
  lastTry: number;
  /** A text change arrived while a fuzzy anchor's upgrade check was rate-limited. */
  upgradeDue: boolean;
  lastVisibilityCheck: number;
  visibilityDue: boolean;
  /** -1 until the first failed attempt. */
  failedAtLength: number;
};

const THROTTLE_MS = 400;
/** A fuzzy match is only trusted once the page text has stopped changing for this long… */
const SETTLE_MS = 1500;
/** …or once the thread has waited this long. */
const MAX_WAIT_MS = 6000;

/**
 * Keeps every thread anchored as the page changes:
 *  - anchors new threads; re-checks anchored ones after DOM mutations
 *    (throttled) and re-anchors those whose text moved or changed;
 *  - retries orphans with backoff, sooner when the page text changes
 *    (late rendering, infinite scroll);
 *  - trusts fuzzy matches only once the page has settled (so a half-loaded
 *    page doesn't pull a thread onto a look-alike passage), and upgrades a
 *    fuzzy anchor to an exact one if the exact text shows up later.
 */
export class AnchorManager {
  private entries = new Map<string, Entry>();
  private observer: MutationObserver | null = null;
  /** Web components' shadow roots being watched (the document observer can't see into them). */
  private observedRoots = new WeakSet<ShadowRoot>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDue = 0;
  private lastRun = 0;
  private destroyed = false;
  /** Page text changed since the last pass (set by the mutation observer). */
  private dirty = true;
  /** Layout-affecting attributes changed (visibility of copies may have too). */
  private layoutDirty = false;
  private textChangedAt = Date.now();

  constructor(
    private getRoot: () => Element | null,
    private ignore: (node: Node) => boolean,
    private onChange: () => void,
    /** Called after every pass: the page changed, so geometry may have too. */
    private onLayout: () => void = () => {},
  ) {}

  start() {
    this.observer = new MutationObserver(mutations => {
      let text = false;
      let layout = false;
      for (const m of mutations) {
        if (this.ignore(m.target)) continue;
        if (m.type === 'attributes') layout = true;
        else text = true;
        if (text) break;
      }
      if (text) {
        this.dirty = true;
        this.textChangedAt = Date.now();
      }
      // Class/style/hidden changes can show or hide copies of the text.
      if (layout) this.layoutDirty = true;
      if (text || layout) this.schedule();
    });
    this.observer.observe(document.documentElement, OBSERVE);
  }

  /** Watch the shadow roots a text index walked into, so their changes re-anchor too. */
  private observeShadowRoots(index: TextIndex) {
    if (!this.observer) return;
    for (const r of index.shadowRoots) {
      if (this.observedRoots.has(r)) continue;
      this.observedRoots.add(r);
      this.observer.observe(r, OBSERVE);
    }
  }

  destroy() {
    this.destroyed = true;
    this.observer?.disconnect();
    if (this.timer) clearTimeout(this.timer);
  }

  private newEntry(id: string, selectors: Selector[], state: AnchorState): Entry {
    const quote = selectors.find((s): s is TextQuoteSelector => s.type === 'TextQuoteSelector');
    const exactStripped = quote ? stripWs(quote.exact) : '';
    return {
      id,
      selectors,
      exactStripped,
      state,
      anchoredText: state.status === 'anchored' ? exactStripped : '',
      createdAt: Date.now(),
      tries: 0,
      nextTry: 0,
      lastTry: 0,
      upgradeDue: false,
      lastVisibilityCheck: 0,
      visibilityDue: false,
      failedAtLength: -1,
    };
  }

  /** Sync the set of threads to anchor. Selectors of an id never change. */
  setThreads(threads: Array<{ id: string; selectors: Selector[] }>) {
    const seen = new Set<string>();
    let added = false;
    for (const t of threads) {
      seen.add(t.id);
      if (this.entries.has(t.id)) continue;
      this.entries.set(t.id, this.newEntry(t.id, t.selectors, { status: 'pending' }));
      added = true;
    }
    let removed = false;
    for (const id of [...this.entries.keys()]) {
      if (!seen.has(id)) {
        this.entries.delete(id);
        removed = true;
      }
    }
    if (added) this.runNow();
    else if (removed) this.onChange();
  }

  /** Anchor a just-created thread immediately with a known-good range. */
  seed(id: string, selectors: Selector[], range: Range) {
    const entry = this.newEntry(id, selectors, { status: 'anchored', range, fuzzy: false });
    entry.anchoredText = stripWs(range.toString());
    this.entries.set(id, entry);
  }

  get(id: string): AnchorState {
    return this.entries.get(id)?.state ?? { status: 'pending' };
  }

  all(): Array<{ id: string; state: AnchorState }> {
    return [...this.entries.values()].map(e => ({ id: e.id, state: e.state }));
  }

  /** The layout changed (resize, responsive breakpoints): re-check which copies are visible. */
  layoutChanged() {
    this.layoutDirty = true;
    this.schedule();
  }

  /** Run a pass after `delay` (throttled); an earlier request replaces a later one. */
  schedule(delay = 0) {
    if (this.destroyed) return;
    const wait = Math.max(delay, THROTTLE_MS - (Date.now() - this.lastRun));
    const due = Date.now() + wait;
    if (this.timer) {
      if (due >= this.timerDue) return;
      clearTimeout(this.timer);
    }
    this.timerDue = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run();
    }, wait);
  }

  runNow() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.run();
  }

  private valid(e: Entry, range: Range): boolean {
    if (range.collapsed || !range.startContainer.isConnected || !range.endContainer.isConnected) return false;
    return stripWs(range.toString()) === e.anchoredText;
  }

  private run() {
    if (this.destroyed) return;
    const now = Date.now();
    this.lastRun = now;
    const root = this.getRoot();
    if (!root) return;

    const textChanged = this.dirty;
    this.dirty = false;
    const layoutChanged = this.layoutDirty;
    this.layoutDirty = false;
    const settled = now - this.textChangedAt >= SETTLE_MS;

    let index: TextIndex | null = null;
    const getIndex = () => (index ??= new TextIndex(root));
    let changed = false;
    let waiting = false;
    // A pass yields after a short time budget and continues on the next one,
    // so many (or expensive) threads never freeze the page.
    const deadline = performance.now() + PASS_BUDGET_MS;
    let unfinished = false;

    for (const e of this.entries.values()) {
      if (performance.now() > deadline) {
        unfinished = true;
        break;
      }
      if (e.state.status === 'anchored') {
        const stillValid = this.valid(e, e.state.range);
        // A fuzzy anchor is upgraded once the exact text appears (checked at
        // most every 2 s, since it needs a full text index).
        let upgrade = false;
        if (stillValid && e.state.fuzzy && (textChanged || e.upgradeDue)) {
          const wait = 2000 - (now - e.lastTry);
          if (wait > 0) {
            // Too soon: remember to look again rather than dropping the change.
            e.upgradeDue = true;
            this.schedule(wait);
          } else {
            e.upgradeDue = false;
            e.lastTry = now;
            upgrade = getIndex().text.includes(e.exactStripped);
          }
        }
        // Responsive layouts: if the anchored copy is hidden (e.g. a desktop
        // column while the mobile one shows), look for a visible equivalent.
        // Rate-limited, but a skipped check stays due and is rescheduled.
        if (stillValid && !upgrade && (layoutChanged || e.visibilityDue || now - e.lastVisibilityCheck >= 10_000) && !isVisible(e.state.range)) {
          const wait = 1000 - (now - e.lastVisibilityCheck);
          if (wait > 0) {
            e.visibilityDue = true;
            this.schedule(wait);
            continue;
          }
          e.visibilityDue = false;
          e.lastVisibilityCheck = now;
          try {
            const alt = anchorSelectors(root, e.selectors, { index: getIndex() });
            if (alt && isVisible(alt.range)) {
              e.state = { status: 'anchored', range: alt.range, fuzzy: alt.quoteScore < 1 };
              e.anchoredText = stripWs(alt.range.toString());
              changed = true;
            } else if (!alt) {
              // Hidden with no shown copy (e.g. a collapsed section): listed as
              // orphaned; showing it again triggers a retry.
              e.state = { status: 'orphan' };
              e.tries = 1;
              e.nextTry = now + 2000;
              e.failedAtLength = 0;
              changed = true;
            }
          } catch {
            // keep the current anchor
          }
          continue;
        }
        if (stillValid && !upgrade) continue;
        e.state = { status: 'pending' };
        e.tries = 0;
        e.nextTry = 0;
        changed = true;
      }
      if (e.state.status === 'orphan') {
        // Retry when the backoff elapsed, or sooner if the page text changed
        // or something was shown/hidden (hidden text isn't matched, so a
        // collapsed section opening can bring the text back), but not more
        // often than every few seconds on busy pages.
        const grew = (textChanged || layoutChanged || e.failedAtLength < 0) && now - e.lastTry >= Math.min(5000, 500 * e.tries);
        if (now < e.nextTry && !grew) continue;
      }
      e.lastTry = now;
      let result = null;
      try {
        result = anchorSelectors(root, e.selectors, { index: getIndex() });
      } catch {
        result = null;
      }
      const fuzzy = !!result && result.quoteScore < 1;
      if (result && fuzzy && !settled && now - e.createdAt < MAX_WAIT_MS) {
        // Page still loading: wait before trusting an approximate match.
        waiting = true;
        continue;
      }
      if (result) {
        e.state = { status: 'anchored', range: result.range, fuzzy };
        e.anchoredText = stripWs(result.range.toString());
        e.tries = 0;
        changed = true;
      } else {
        const wasOrphan = e.state.status === 'orphan';
        e.state = { status: 'orphan' };
        e.tries++;
        e.nextTry = now + Math.min(30_000, 1000 * 2 ** Math.min(e.tries, 5));
        e.failedAtLength = 0;
        if (!wasOrphan) changed = true;
      }
    }
    // Make sure skipped orphans get their retry even if the page goes quiet.
    let nextRetry = waiting ? now + SETTLE_MS : Infinity;
    for (const e of this.entries.values()) {
      if (e.state.status === 'orphan' && e.nextTry < nextRetry) nextRetry = e.nextTry;
    }
    if (nextRetry !== Infinity) this.schedule(Math.max(0, nextRetry - now));
    const built = index as TextIndex | null;
    if (built) this.observeShadowRoots(built);
    if (unfinished) {
      // The rest still needs this pass's signals.
      this.dirty ||= textChanged;
      this.layoutDirty ||= layoutChanged;
      this.schedule(0);
    }
    if (changed) this.onChange();
    this.onLayout();
  }
}

// Every attribute: pages show and hide content through any of them (class,
// style, hidden, open, but also data-* / aria-* matched by their CSS). Passes
// are throttled, so busy attributes only cost a flag.
/** Longest stretch one anchoring pass runs before yielding to the page. */
const PASS_BUDGET_MS = 50;

const OBSERVE: MutationObserverInit = {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
};
