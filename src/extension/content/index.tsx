/**
 * Content script entry: wires page identity, the background connection,
 * anchoring, highlights, selection handling and the Shadow-DOM UI.
 */
import { render } from 'preact';
import type { Selector, TextPositionSelector, Thread } from '../../shared/types';
import { LIMITS } from '../../shared/types';
import { type PageIdentity, pageIdentity, threadIdFromUrl } from '../../shared/url';
import type { Draft, NewOp, ToContent } from '../messages';
import { anchorSelectors, describeRange } from './anchoring/anchor';
import { AnchorManager } from './anchoring/manager';
import { Highlighter, hueIndexFor, pageIsDark } from './highlights';
import { BackgroundPort } from './port';
import { isMine, type State, Store, type UiState, viewThreads, type ViewThread } from './store';
import type { Actions, AnchorBox } from './ui/actions';
import { App } from './ui/app';
import { CSS_TEXT } from './ui/styles';

declare const __API_URL__: string;
const API_URL = __API_URL__;
const API_ORIGIN = new URL(API_URL).origin;
const HOST_TAG = 'margin-comments-root';

declare global {
  interface Window {
    __marginComments?: { destroy(): void };
    __marginCommentsShield?: { host: Element | null };
  }
}

function currentIdentity(): PageIdentity | null {
  const canonical = document.querySelector<HTMLLinkElement>('link[rel~="canonical" i][href]');
  return pageIdentity(location.href, canonical?.href ?? null);
}

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function inEditable(node: Node | null): boolean {
  const el = node instanceof Element ? node : node?.parentElement;
  return !!el?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]');
}

/** Line boxes of a range plus the right edge of the block it sits in. */
function boxOf(range: Range): AnchorBox | null {
  const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
  if (rects.length === 0) return null;
  let columnRight = Math.max(...rects.map(r => r.right));
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  let block: Element | null = start;
  while (block && block !== document.body) {
    const display = getComputedStyle(block).display;
    if (display !== 'inline' && display !== 'contents') break;
    block = block.parentElement;
  }
  if (block && block !== document.body) {
    const br = block.getBoundingClientRect();
    if (br.width > 0 && br.right - columnRight < 600) columnRight = Math.max(columnRight, br.right);
  }
  return { rects, columnRight };
}

const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

class MarginComments implements Actions {
  readonly apiUrl = API_URL;
  private store: Store;
  private port: BackgroundPort;
  private anchors: AnchorManager;
  private highlighter: Highlighter;
  private host: HTMLElement;
  private container: HTMLElement;
  private abort = new AbortController();
  private identity: PageIdentity;
  /** Draft text not yet acknowledged by the background (retried until it is). */
  private draftTimers = new Map<string, { timer: ReturnType<typeof setTimeout> | null; draft: Draft }>();
  private draftRetry: ReturnType<typeof setTimeout> | null = null;
  private composerText = '';
  private pendingOpen: string | null = null;
  private urlTimer: ReturnType<typeof setInterval>;
  private rafPending = false;
  private hoverRaf = false;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(identity: PageIdentity) {
    this.identity = identity;
    const ui: UiState = {
      sidebarOpen: false,
      sidebarFilter: 'open',
      activeThreadId: null,
      hoverThreadId: null,
      composer: null,
      adder: null,
      layoutTick: 0,
      toast: null,
    };
    this.store = new Store({
      user: null,
      config: null,
      connection: 'offline',
      loaded: false,
      loadError: null,
      threads: new Map(),
      ops: [],
      drafts: [],
      anchors: new Map(),
      pageKeys: identity.keys,
      pageUrl: identity.url,
      ui,
      invalidated: false,
    });

    // UI host: a custom element on <html> (outside <body>, so page text and
    // text offsets never include it), with an open shadow root.
    for (const old of document.querySelectorAll(HOST_TAG)) old.remove();
    this.host = document.createElement(HOST_TAG);
    const shadow = this.host.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS_TEXT);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = CSS_TEXT;
      shadow.appendChild(style);
    }
    this.container = document.createElement('div');
    shadow.appendChild(this.container);
    // Clicks inside our UI activate normally but don't bubble out to the page
    // (see early.ts for why clicks aren't replayed like other events).
    for (const type of ['click', 'dblclick', 'auxclick']) this.host.addEventListener(type, e => e.stopPropagation());
    document.documentElement.appendChild(this.host);
    if (window.__marginCommentsShield) window.__marginCommentsShield.host = this.host;

    this.highlighter = new Highlighter(pageIsDark());
    this.anchors = new AnchorManager(
      () => document.body,
      node => node === this.host || this.host.contains(node),
      () => this.onAnchorsChanged(),
      () => this.onLayoutChange(),
    );

    this.port = new BackgroundPort(
      msg => this.onMessage(msg),
      () => this.teardown(),
      () => this.flushDrafts(),
    );

    render(<App store={this.store} actions={this} />, this.container);
    this.store.subscribe(() => this.sync());
    this.listen();
    this.anchors.start();
    this.port.connect();
    this.port.setHello(identity.keys, identity.url);
    this.pendingOpen = threadIdFromUrl(location.href);
    this.urlTimer = setInterval(() => this.checkUrl(), 1000);
    void this.loadFonts();
    if (location.origin === API_ORIGIN && location.pathname === '/auth/verify') void this.handleVerifyPage();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  destroy() {
    this.teardown();
  }

  private teardown() {
    if (this.store.state.invalidated) return;
    this.store.set({ invalidated: true });
    this.abort.abort();
    clearInterval(this.urlTimer);
    this.anchors.destroy();
    this.highlighter.destroy();
    this.port.close();
    try {
      render(null, this.container);
    } catch {
      // ignore
    }
    this.host.remove();
    if (window.__marginCommentsShield?.host === this.host) window.__marginCommentsShield.host = null;
  }

  private async loadFonts() {
    const faces: Array<[string, string, string]> = [
      ['MC Source Sans', 'fonts/source-sans-3-400.woff2', '400'],
      ['MC Source Sans', 'fonts/source-sans-3-600.woff2', '600'],
      ['MC Source Sans', 'fonts/source-sans-3-700.woff2', '700'],
      ['MC Lora', 'fonts/lora-400.woff2', '400'],
    ];
    for (const [family, file, weight] of faces) {
      try {
        // Load bytes, not a URL: page CSP (font-src) can't block it.
        const res = await fetch(chrome.runtime.getURL(file));
        const face = new FontFace(family, await res.arrayBuffer(), { weight });
        await face.load();
        document.fonts.add(face);
      } catch {
        // fall back to the system font stack
      }
    }
  }

  private async handleVerifyPage() {
    const token = new URLSearchParams(location.hash.slice(1)).get('token');
    if (!token) return;
    // Don't leave the one-time token in history.
    history.replaceState(history.state, '', location.pathname + location.search);
    const title = document.getElementById('mc-verify-title');
    const message = document.getElementById('mc-verify-message');
    const box = document.getElementById('mc-verify');
    try {
      const { user } = await this.port.call('consumeLink', { token });
      if (title) title.textContent = "You're signed in";
      if (message) message.textContent = `Signed in as ${user.email}. You can close this tab and go back to the page you were reading.`;
      box?.setAttribute('data-state', 'done');
    } catch (err) {
      if (title) title.textContent = "That link didn't work";
      if (message) message.textContent = `${(err as Error).message} Request a new link from the extension.`;
      box?.setAttribute('data-state', 'error');
    }
  }

  // -------------------------------------------------------------------------
  // Background messages
  // -------------------------------------------------------------------------

  private onMessage(msg: ToContent) {
    const s = this.store.state;
    switch (msg.t) {
      case 'state':
        this.store.set({ user: msg.user, config: msg.config, connection: msg.connection, ops: msg.ops, drafts: msg.drafts });
        break;
      case 'threads': {
        const threads = new Map<string, Thread>();
        for (const t of msg.threads) threads.set(t.id, t);
        this.store.set({ threads, loaded: msg.loaded, loadError: msg.error ?? null });
        break;
      }
      case 'thread': {
        const prev = s.threads.get(msg.thread.id);
        if (prev && prev.version > msg.thread.version) break;
        const threads = new Map(s.threads);
        threads.set(msg.thread.id, msg.thread);
        this.store.set({ threads });
        // Someone else resolved the thread we're looking at: let it go, as Google Docs does.
        const ui = s.ui;
        if (prev && !prev.resolved && msg.thread.resolved && ui.activeThreadId === msg.thread.id && !(ui.sidebarOpen && ui.sidebarFilter === 'resolved')) {
          this.store.setUi({ activeThreadId: null });
        }
        break;
      }
      case 'thread-deleted': {
        if (!s.threads.has(msg.id)) break;
        const threads = new Map(s.threads);
        threads.delete(msg.id);
        this.store.set({ threads });
        if (s.ui.activeThreadId === msg.id) this.store.setUi({ activeThreadId: null });
        break;
      }
      case 'toggle-sidebar':
        this.toggleSidebar();
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Derived state: anchors + highlights
  // -------------------------------------------------------------------------

  private views: ViewThread[] = [];

  private sync() {
    const s = this.store.state;
    if (s.invalidated) return;
    this.views = viewThreads(s);
    this.anchors.setThreads(this.views.map(t => ({ id: t.id, selectors: t.selectors })));
    this.renderHighlights();
    this.maybeOpenPending();
  }

  private onAnchorsChanged() {
    const anchors = new Map(this.anchors.all().map(a => [a.id, a.state.status] as const));
    this.highlighter.invalidate();
    this.store.set({ anchors });
  }

  private renderHighlights() {
    const s = this.store.state;
    const { activeThreadId, hoverThreadId, composer } = s.ui;
    const items = [];
    for (const t of this.views) {
      if (t.resolved && t.id !== activeThreadId) continue;
      const a = this.anchors.get(t.id);
      if (a.status !== 'anchored') continue;
      items.push({
        threadId: t.id,
        range: a.range,
        kind: isMine(t, s.user) ? ('own' as const) : hueIndexFor(t.author.name),
        active: t.id === activeThreadId || t.id === hoverThreadId,
      });
    }
    this.highlighter.render(items, composer?.range ?? null);
  }

  private maybeOpenPending() {
    const id = this.pendingOpen;
    if (!id) return;
    const s = this.store.state;
    if (!s.user || !s.loaded) return;
    const t = this.views.find(v => v.id === id);
    if (!t) {
      this.pendingOpen = null;
      return;
    }
    const a = this.anchors.get(id);
    if (a.status === 'pending') return;
    this.pendingOpen = null;
    this.openThread(id, { scroll: true, fromSidebar: a.status === 'orphan' });
  }

  // -------------------------------------------------------------------------
  // Page events
  // -------------------------------------------------------------------------

  private listen() {
    const opts = { signal: this.abort.signal };
    const passive = { signal: this.abort.signal, passive: true, capture: true };
    document.addEventListener('mouseup', e => this.onMouseUp(e), opts);
    document.addEventListener('keyup', e => this.onKeyUp(e), opts);
    document.addEventListener('keydown', e => this.onKeyDown(e), opts);
    document.addEventListener('selectionchange', () => this.onSelectionChange(), opts);
    document.addEventListener('click', e => this.onClick(e), opts);
    document.addEventListener('mousemove', e => this.onMouseMove(e), { signal: this.abort.signal, passive: true });
    window.addEventListener('scroll', () => this.onLayoutChange(), passive);
    window.addEventListener('resize', () => this.onLayoutChange(), { signal: this.abort.signal, passive: true });
    window.addEventListener('popstate', () => this.checkUrl(), opts);
    window.addEventListener('hashchange', () => this.checkUrl(), opts);
    window.addEventListener('pagehide', () => this.flushDrafts(), opts);
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState === 'hidden') this.flushDrafts();
        else if (this.store.state.connection !== 'online' || this.store.state.ops.length) this.refresh();
      },
      opts,
    );
    // Layout can change without DOM mutations (images loading, fonts, CSS):
    // keep hit-testing and card positions in step.
    const resize = new ResizeObserver(() => this.onLayoutChange());
    if (document.body) resize.observe(document.body);
    this.abort.signal.addEventListener('abort', () => resize.disconnect());
    // Re-attach our host if a framework wipes unknown nodes off <html>.
    const keeper = new MutationObserver(() => {
      if (!this.host.isConnected && !this.store.state.invalidated) document.documentElement.appendChild(this.host);
    });
    keeper.observe(document.documentElement, { childList: true });
    this.abort.signal.addEventListener('abort', () => keeper.disconnect());
  }

  private selectionTimer: ReturnType<typeof setTimeout> | null = null;

  private onMouseUp(e: MouseEvent) {
    if (e.button !== 0) return;
    setTimeout(() => this.checkSelection(), 0);
  }

  private onKeyUp(e: KeyboardEvent) {
    if (e.shiftKey || e.key === 'Shift' || (e.key === 'a' && (e.metaKey || e.ctrlKey))) this.checkSelectionSoon();
  }

  private onSelectionChange() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed) {
      if (this.store.state.ui.adder) this.store.setUi({ adder: null });
      return;
    }
    this.checkSelectionSoon();
  }

  private checkSelectionSoon() {
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    this.selectionTimer = setTimeout(() => this.checkSelection(), 250);
  }

  private checkSelection() {
    const hide = () => {
      if (this.store.state.ui.adder) this.store.setUi({ adder: null });
    };
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !document.body) return hide();
    const range = sel.getRangeAt(0);
    if (!document.body.contains(range.commonAncestorContainer)) return hide();
    if (inEditable(range.startContainer) || inEditable(range.endContainer)) return hide();
    if (!range.toString().trim()) return hide();
    const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
    if (rects.length === 0) return hide();
    const bounds = range.getBoundingClientRect();
    const vw = window.innerWidth - (this.store.state.ui.sidebarOpen ? 320 : 0);
    let left = bounds.right + 10;
    let top = Math.max(4, bounds.top);
    if (left + 90 > vw || top > window.innerHeight - 30) {
      const last = rects[rects.length - 1];
      left = Math.min(Math.max(4, last.right - 70), vw - 90);
      top = Math.min(window.innerHeight - 34, last.bottom + 6);
    }
    this.store.setUi({ adder: { rect: new DOMRect(left, top, 0, 0) } });
  }

  private onClick(e: MouseEvent) {
    if (e.button !== 0) return;
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed) return;
    const id = this.highlighter.hitTest(e.clientX, e.clientY);
    const ui = this.store.state.ui;
    if (id) {
      if (ui.composer && !this.composerText.trim()) this.store.setUi({ composer: null });
      if (!ui.composer) this.openThread(id);
      return;
    }
    // A click elsewhere on the page closes the card (drafts are kept).
    if (ui.activeThreadId && !ui.sidebarOpen) this.store.setUi({ activeThreadId: null });
    if (ui.composer && !this.composerText.trim()) this.store.setUi({ composer: null });
  }

  private onMouseMove(e: MouseEvent) {
    if (this.hoverRaf) return;
    this.hoverRaf = true;
    const { clientX, clientY } = e;
    requestAnimationFrame(() => {
      this.hoverRaf = false;
      const id = this.highlighter.hitTest(clientX, clientY, false);
      if (id !== this.store.state.ui.hoverThreadId) this.store.setUi({ hoverThreadId: id });
    });
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    const ui = this.store.state.ui;
    if (ui.composer) this.cancelComposer();
    else if (ui.activeThreadId) this.closeCard();
    else if (ui.adder) this.store.setUi({ adder: null });
  }

  private onLayoutChange() {
    this.highlighter.invalidate();
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      const ui = this.store.state.ui;
      if (ui.adder) this.checkSelection();
      if (ui.activeThreadId || ui.composer) this.store.setUi({ layoutTick: ui.layoutTick + 1 });
    });
  }

  private checkUrl() {
    const next = currentIdentity();
    if (!next || sameKeys(next.keys, this.identity.keys)) {
      if (next) this.identity = next;
      return;
    }
    // SPA navigation (or a canonical link that appeared late).
    this.identity = next;
    this.store.set({ threads: new Map(), loaded: false, pageKeys: next.keys, pageUrl: next.url });
    this.store.setUi({ activeThreadId: null, composer: null, adder: null });
    this.port.setHello(next.keys, next.url);
    const fromLink = threadIdFromUrl(location.href);
    if (fromLink) this.pendingOpen = fromLink;
  }

  // -------------------------------------------------------------------------
  // Actions (called by the UI)
  // -------------------------------------------------------------------------

  async startEmail(email: string) {
    return this.port.call('startEmail', { email });
  }

  async verifyCode(requestId: string, code: string) {
    await this.port.call('verifyCode', { requestId, code });
  }

  async googleSignIn() {
    await this.port.call('googleSignIn', {});
  }

  async signOut() {
    await this.port.call('signOut', {});
  }

  async updateMe(patch: { name?: string; notifyEmail?: boolean }) {
    await this.port.call('updateMe', patch);
  }

  clickAdder() {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || !document.body) return;
    const desc = describeRange(document.body, sel.getRangeAt(0).cloneRange());
    if (!desc) {
      this.toast("Can't comment on that selection.");
      return;
    }
    if (desc.quote.length > LIMITS.quote) {
      this.toast('That selection is too long to comment on.');
      return;
    }
    const pos = desc.selectors.find((s): s is TextPositionSelector => s.type === 'TextPositionSelector');
    const draftKey = `new:${this.identity.keys[0]}:${hash(`${desc.quote}|${pos?.start ?? ''}`)}`;
    this.composerText = this.store.state.drafts.find(d => d.key === draftKey)?.text ?? '';
    this.store.setUi({
      adder: null,
      activeThreadId: null,
      composer: {
        threadId: crypto.randomUUID(),
        commentId: crypto.randomUUID(),
        draftKey,
        quote: desc.quote,
        selectors: desc.selectors,
        range: desc.range,
      },
    });
    sel.removeAllRanges();
  }

  /**
   * Queue a change. The background persists it (and drops the draft) before
   * acknowledging; until then the draft stays saved, so a failure here loses
   * nothing.
   */
  private async mutate(op: NewOp, draftKey?: string) {
    if (draftKey) this.pauseDraftSave(draftKey);
    try {
      await this.port.call('mutate', { op, draftKey });
    } catch (err) {
      if (draftKey) this.flushDraft(draftKey);
      throw err;
    }
    if (draftKey) this.draftTimers.delete(draftKey);
  }

  async createThread(body: string) {
    const c = this.store.state.ui.composer;
    if (!c) throw new Error('Nothing selected');
    const keys = this.identity.keys;
    await this.mutate(
      {
        kind: 'createThread',
        threadId: c.threadId,
        pageKeys: keys,
        payload: {
          id: c.threadId,
          pageKeys: keys,
          url: this.identity.url,
          title: document.title.slice(0, LIMITS.title),
          quote: c.quote,
          selectors: c.selectors,
          comment: { id: c.commentId, body },
        },
      },
      c.draftKey,
    );
    this.anchors.seed(c.threadId, c.selectors, c.range);
    this.composerText = '';
    this.store.setUi({ composer: null, activeThreadId: c.threadId });
  }

  cancelComposer() {
    const c = this.store.state.ui.composer;
    if (c) this.flushDraft(c.draftKey);
    this.composerText = '';
    this.store.setUi({ composer: null });
  }

  async reply(thread: ViewThread, commentId: string, body: string, draftKey: string) {
    await this.mutate({ kind: 'addComment', threadId: thread.id, pageKeys: this.keysFor(thread), commentId, body }, draftKey);
  }

  async edit(thread: ViewThread, commentId: string, body: string, draftKey: string) {
    await this.mutate({ kind: 'editComment', threadId: thread.id, pageKeys: this.keysFor(thread), commentId, body }, draftKey);
  }

  async remove(thread: ViewThread, commentId: string) {
    const isFirst = thread.comments[0]?.id === commentId;
    // An unsent thread: drop its create op, and also queue a delete in case
    // the create is already in flight (deleting a thread the server never
    // got is a harmless no-op).
    if (isFirst && thread.pending) {
      const op = this.store.state.ops.find(o => o.kind === 'createThread' && o.threadId === thread.id);
      if (op) await this.port.call('discardOp', { opId: op.opId });
    }
    await this.mutate({ kind: 'deleteComment', threadId: thread.id, pageKeys: this.keysFor(thread), commentId });
    if (isFirst && this.store.state.ui.activeThreadId === thread.id) this.store.setUi({ activeThreadId: null });
  }

  async setResolved(thread: ViewThread, resolved: boolean) {
    await this.mutate({ kind: 'resolve', threadId: thread.id, pageKeys: this.keysFor(thread), resolved });
    // Like Google Docs: a resolved thread gets out of the way.
    if (resolved && this.store.state.ui.activeThreadId === thread.id) this.store.setUi({ activeThreadId: null });
  }

  private keysFor(thread: ViewThread): string[] {
    return [thread.pageKey, ...(thread.altPageKey ? [thread.altPageKey] : [])];
  }

  retryOp(opId: string) {
    void this.port.call('retryOp', { opId });
  }

  discardOp(opId: string) {
    void this.port.call('discardOp', { opId });
  }

  saveDraft(key: string, text: string) {
    if (key === this.store.state.ui.composer?.draftKey) this.composerText = text;
    const c = this.store.state.ui.composer;
    const draft: Draft = {
      key,
      text,
      updatedAt: Date.now(),
      anchor: key.startsWith('new:') && c && c.draftKey === key ? { pageKeys: this.identity.keys, selectors: c.selectors, quote: c.quote } : undefined,
      pageKeys: this.identity.keys,
    };
    const existing = this.draftTimers.get(key);
    if (existing?.timer) clearTimeout(existing.timer);
    const timer = setTimeout(() => this.flushDraft(key), 400);
    this.draftTimers.set(key, { timer, draft });
  }

  draftText(key: string): string | undefined {
    return this.draftTimers.get(key)?.draft.text ?? this.store.state.drafts.find(d => d.key === key)?.text;
  }

  /** Persist a draft; it stays queued here until the background confirms. */
  private flushDraft(key: string) {
    const entry = this.draftTimers.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    this.port
      .call('saveDraft', { draft: entry.draft })
      .then(() => {
        if (this.draftTimers.get(key) === entry) this.draftTimers.delete(key);
      })
      .catch(() => this.retryDraftsSoon());
  }

  private retryDraftsSoon() {
    if (this.draftRetry || this.store.state.invalidated) return;
    this.draftRetry = setTimeout(() => {
      this.draftRetry = null;
      this.flushDrafts();
    }, 1000);
  }

  private flushDrafts() {
    for (const key of [...this.draftTimers.keys()]) this.flushDraft(key);
  }

  /** Hold a draft's pending save while it's being submitted. */
  private pauseDraftSave(key: string) {
    const entry = this.draftTimers.get(key);
    if (entry?.timer) clearTimeout(entry.timer);
    if (entry) entry.timer = null;
  }

  deleteDraft(key: string) {
    const entry = this.draftTimers.get(key);
    if (entry?.timer) clearTimeout(entry.timer);
    this.draftTimers.delete(key);
    void this.port.call('deleteDraft', { key }).catch(() => {});
  }

  resumeDraft(draft: Draft) {
    if (!draft.anchor || !document.body) return;
    const result = anchorSelectors(document.body, draft.anchor.selectors as Selector[]);
    if (!result) {
      this.toast("That text isn't on the page anymore. Copy your draft instead.");
      return;
    }
    this.composerText = draft.text;
    this.store.setUi({
      activeThreadId: null,
      composer: {
        threadId: crypto.randomUUID(),
        commentId: crypto.randomUUID(),
        draftKey: draft.key,
        quote: draft.anchor.quote,
        selectors: draft.anchor.selectors as Selector[],
        range: result.range,
      },
    });
    this.scrollToRange(result.range);
  }

  openThread(id: string, opts: { scroll?: boolean; fromSidebar?: boolean } = {}) {
    const ui = this.store.state.ui;
    const patch: Partial<UiState> = { activeThreadId: id, composer: null, adder: null };
    const a = this.anchors.get(id);
    if (opts.fromSidebar || a.status === 'orphan') {
      patch.sidebarOpen = true;
      const t = this.views.find(v => v.id === id);
      if (t) patch.sidebarFilter = t.resolved ? 'resolved' : 'open';
    }
    if (ui.composer) this.flushDraft(ui.composer.draftKey);
    this.store.setUi(patch);
    if (opts.scroll && a.status === 'anchored') this.scrollToRange(a.range);
  }

  private scrollToRange(range: Range) {
    const el = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const rect = range.getBoundingClientRect();
    if (rect.top >= 60 && rect.bottom <= window.innerHeight - 60) return;
    el?.scrollIntoView({ block: 'center', inline: 'nearest' });
    const after = range.getBoundingClientRect();
    if (after.top < 0 || after.top > window.innerHeight) window.scrollBy({ top: after.top - window.innerHeight / 3 });
  }

  closeCard() {
    this.store.setUi({ activeThreadId: null });
  }

  toggleSidebar(open?: boolean) {
    const next = open ?? !this.store.state.ui.sidebarOpen;
    this.store.setUi({ sidebarOpen: next });
  }

  setFilter(filter: 'open' | 'resolved') {
    this.store.setUi({ sidebarFilter: filter, activeThreadId: null });
  }

  copy(text: string) {
    navigator.clipboard
      .writeText(text)
      .then(() => this.toast('Copied to clipboard'))
      .catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text;
        this.container.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        this.toast(ok ? 'Copied to clipboard' : "Couldn't copy. Select the text and copy it manually.");
      });
  }

  refresh() {
    void this.port.call('refresh', {}).catch(() => {});
  }

  anchorBox(threadId: string): AnchorBox | null {
    const a = this.anchors.get(threadId);
    return a.status === 'anchored' ? boxOf(a.range) : null;
  }

  draftBox(): AnchorBox | null {
    const r = this.store.state.ui.composer?.range;
    return r ? boxOf(r) : null;
  }

  isOrphan(threadId: string): boolean {
    return this.anchors.get(threadId).status === 'orphan';
  }

  private toast(text: string) {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.store.setUi({ toast: text });
    this.toastTimer = setTimeout(() => this.store.setUi({ toast: null }), 3500);
  }
}

function main() {
  // A previous instance (e.g. before an extension update) gives way.
  try {
    window.__marginComments?.destroy();
  } catch {
    // ignore
  }
  window.__marginComments = undefined;
  if (window.top !== window) return; // top frame only (v1)
  const identity = currentIdentity();
  if (!identity || !document.documentElement) return;
  const start = () => {
    const app = new MarginComments(identity);
    window.__marginComments = app;
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}

main();

export type { State };
