import type { Selector, TextQuoteSelector } from '../../../shared/types';
import { anchorSelectors, stripWs, TextIndex } from './anchor';

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
  /** Text length of the page when this entry last failed to anchor. */
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
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastRun = 0;
  private destroyed = false;
  private textLength = -1;
  private textChangedAt = Date.now();

  constructor(
    private getRoot: () => Element | null,
    private ignore: (node: Node) => boolean,
    private onChange: () => void,
  ) {}

  start() {
    this.observer = new MutationObserver(mutations => {
      for (const m of mutations) {
        if (!this.ignore(m.target)) {
          this.schedule();
          return;
        }
      }
    });
    this.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
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
    this.entries.set(id, this.newEntry(id, selectors, { status: 'anchored', range, fuzzy: false }));
  }

  get(id: string): AnchorState {
    return this.entries.get(id)?.state ?? { status: 'pending' };
  }

  all(): Array<{ id: string; state: AnchorState }> {
    return [...this.entries.values()].map(e => ({ id: e.id, state: e.state }));
  }

  schedule(delay = 0) {
    if (this.destroyed || this.timer) return;
    const wait = Math.max(delay, THROTTLE_MS - (Date.now() - this.lastRun));
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

    const length = root.textContent?.length ?? 0;
    const lengthChanged = length !== this.textLength;
    if (lengthChanged) {
      this.textLength = length;
      this.textChangedAt = now;
    }
    const settled = now - this.textChangedAt >= SETTLE_MS;

    let index: TextIndex | null = null;
    const getIndex = () => (index ??= new TextIndex(root));
    let changed = false;
    let waiting = false;

    for (const e of this.entries.values()) {
      if (e.state.status === 'anchored') {
        const stillValid = this.valid(e, e.state.range);
        // A fuzzy anchor is upgraded as soon as the exact text appears.
        const upgrade = stillValid && e.state.fuzzy && lengthChanged && getIndex().text.includes(e.exactStripped);
        if (stillValid && !upgrade) continue;
        e.state = { status: 'pending' };
        e.tries = 0;
        e.nextTry = 0;
        changed = true;
      }
      if (e.state.status === 'orphan') {
        // Retry when the backoff elapsed, or sooner if the page text changed
        // (but not more often than every few seconds on busy pages).
        const grew = length !== e.failedAtLength && now - e.lastTry >= Math.min(5000, 500 * e.tries);
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
        e.failedAtLength = length;
        if (!wasOrphan) changed = true;
      }
    }
    if (waiting) this.schedule(SETTLE_MS);
    if (changed) this.onChange();
  }
}
