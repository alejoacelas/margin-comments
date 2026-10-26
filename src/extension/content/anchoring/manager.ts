import type { Selector, TextQuoteSelector } from '../../../shared/types';
import { anchorSelectors, stripWs, TextIndex } from './anchor';

export type AnchorState = { status: 'anchored'; range: Range } | { status: 'orphan' } | { status: 'pending' };

type Entry = {
  id: string;
  selectors: Selector[];
  exactStripped: string;
  state: AnchorState;
  tries: number;
  nextTry: number;
  lastTry: number;
  /** Text length of the page when this entry last failed to anchor. */
  failedAtLength: number;
};

const THROTTLE_MS = 400;

/**
 * Keeps every thread anchored as the page changes. Anchors new threads,
 * re-checks anchored ones after DOM mutations (throttled), re-anchors those
 * whose text moved or changed, and retries orphans with backoff — sooner
 * when the page text has grown (late rendering, infinite scroll).
 */
export class AnchorManager {
  private entries = new Map<string, Entry>();
  private observer: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastRun = 0;
  private destroyed = false;

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

  /** Sync the set of threads to anchor. Selectors of an id never change. */
  setThreads(threads: Array<{ id: string; selectors: Selector[] }>) {
    const seen = new Set<string>();
    let added = false;
    for (const t of threads) {
      seen.add(t.id);
      if (this.entries.has(t.id)) continue;
      const quote = t.selectors.find((s): s is TextQuoteSelector => s.type === 'TextQuoteSelector');
      this.entries.set(t.id, {
        id: t.id,
        selectors: t.selectors,
        exactStripped: quote ? stripWs(quote.exact) : '',
        state: { status: 'pending' },
        tries: 0,
        nextTry: 0,
        lastTry: 0,
        failedAtLength: -1,
      });
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
    const quote = selectors.find((s): s is TextQuoteSelector => s.type === 'TextQuoteSelector');
    this.entries.set(id, {
      id,
      selectors,
      exactStripped: quote ? stripWs(quote.exact) : '',
      state: { status: 'anchored', range },
      tries: 0,
      nextTry: 0,
      lastTry: 0,
      failedAtLength: -1,
    });
  }

  get(id: string): AnchorState {
    return this.entries.get(id)?.state ?? { status: 'pending' };
  }

  all(): Array<{ id: string; state: AnchorState }> {
    return [...this.entries.values()].map(e => ({ id: e.id, state: e.state }));
  }

  schedule() {
    if (this.destroyed || this.timer) return;
    const wait = Math.max(0, THROTTLE_MS - (Date.now() - this.lastRun));
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
    return stripWs(range.toString()) === e.exactStripped;
  }

  private run() {
    if (this.destroyed) return;
    this.lastRun = Date.now();
    const root = this.getRoot();
    if (!root) return;
    let index: TextIndex | null = null;
    let textLength = -1;
    const now = Date.now();
    let changed = false;

    for (const e of this.entries.values()) {
      if (e.state.status === 'anchored') {
        if (this.valid(e, e.state.range)) continue;
        e.state = { status: 'pending' };
        e.tries = 0;
        e.nextTry = 0;
        changed = true;
      }
      if (e.state.status === 'orphan') {
        if (textLength < 0) textLength = root.textContent?.length ?? 0;
        // Retry when the backoff elapsed, or sooner if the page text changed
        // (but not more often than every few seconds on busy pages).
        const grew = textLength !== e.failedAtLength && now - e.lastTry >= Math.min(5000, 500 * e.tries);
        if (now < e.nextTry && !grew) continue;
      }
      e.lastTry = now;
      let result = null;
      try {
        index ??= new TextIndex(root);
        result = anchorSelectors(root, e.selectors, { index });
      } catch {
        result = null;
      }
      if (result) {
        e.state = { status: 'anchored', range: result.range };
        e.tries = 0;
        changed = true;
      } else {
        const wasOrphan = e.state.status === 'orphan';
        e.state = { status: 'orphan' };
        e.tries++;
        e.nextTry = now + Math.min(30_000, 1000 * 2 ** Math.min(e.tries, 5));
        if (textLength < 0) textLength = root.textContent?.length ?? 0;
        e.failedAtLength = textLength;
        if (!wasOrphan) changed = true;
      }
    }
    if (changed) this.onChange();
  }
}
