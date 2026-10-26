/**
 * Background service worker: owns the session, the outbox of unsent changes,
 * the drafts, and the single live WebSocket. Content scripts talk to it over
 * long-lived ports; it never runs page code.
 */
import type { Me, ServerConfig, Thread } from '../../shared/types';
import type { Connection, Draft, NewOp, Op, RpcMethod, RpcMethods, ToBackground, ToContent } from '../messages';
import { PORT_NAME } from '../messages';
import { api, API_URL, RequestError, TransientError, WS_URL } from './api';

type Session = { token: string; user: Me };

type PortInfo = {
  port: chrome.runtime.Port;
  tabId: number | undefined;
  keys: string[];
  threads: Map<string, Thread>;
  loaded: boolean;
  /** Bumped on every (re)load; a response from an older load is discarded. */
  loadGen: number;
  /** When each thread last arrived live, so an older fetch can't drop it. */
  liveAt: Map<string, number>;
  /** Threads deleted while this page was open; a fetch can't resurrect them. */
  tombstones: Set<string>;
};

// ---------------------------------------------------------------------------
// Persistent state
// ---------------------------------------------------------------------------

let session: Session | null = null;
let config: ServerConfig | null = null;
let ops: Op[] = [];
let drafts: Record<string, Draft> = {};

const ready: Promise<void> = (async () => {
  const stored = await chrome.storage.local.get(['session', 'outbox', 'drafts']);
  session = (stored.session as Session | undefined) ?? null;
  ops = Array.isArray(stored.outbox) ? (stored.outbox as Op[]) : [];
  drafts = (stored.drafts as Record<string, Draft> | undefined) ?? {};
})();

let writeChain: Promise<unknown> = Promise.resolve();
/** Serialize storage writes so later state never gets overwritten by earlier state. */
function persist(keys: Array<'session' | 'outbox' | 'drafts'>): Promise<void> {
  const snapshot: Record<string, unknown> = {};
  for (const k of keys) snapshot[k] = k === 'session' ? session : k === 'outbox' ? ops : drafts;
  const p = writeChain.then(async () => {
    const toRemove = Object.entries(snapshot)
      .filter(([, v]) => v === null)
      .map(([k]) => k);
    const toSet = Object.fromEntries(Object.entries(snapshot).filter(([, v]) => v !== null));
    if (toRemove.length) await chrome.storage.local.remove(toRemove);
    if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);
  });
  writeChain = p.catch(() => {});
  return p;
}

// ---------------------------------------------------------------------------
// Ports (one per tab's content script)
// ---------------------------------------------------------------------------

const ports = new Set<PortInfo>();
let connection: Connection = 'offline';

function post(info: PortInfo, msg: ToContent) {
  try {
    info.port.postMessage(msg);
  } catch {
    // port closed; onDisconnect cleans up
  }
}

function opsFor(info: PortInfo): Op[] {
  return ops.filter(op => op.pageKeys.some(k => info.keys.includes(k)));
}

function draftsFor(info: PortInfo): Draft[] {
  return Object.values(drafts).filter(d => {
    const keys = d.anchor?.pageKeys ?? d.pageKeys;
    return !keys || keys.some(k => info.keys.includes(k));
  });
}

function sendState(info: PortInfo) {
  post(info, { t: 'state', user: session?.user ?? null, config, connection, ops: opsFor(info), drafts: draftsFor(info) });
}

function broadcastState() {
  for (const info of ports) sendState(info);
}

function matches(info: PortInfo, thread: { pageKey: string; altPageKey: string | null }) {
  return info.keys.includes(thread.pageKey) || (!!thread.altPageKey && info.keys.includes(thread.altPageKey));
}

function deliverThread(thread: Thread) {
  for (const info of ports) {
    if (!matches(info, thread)) continue;
    if (info.tombstones.has(thread.id)) continue;
    const prev = info.threads.get(thread.id);
    if (prev && prev.version > thread.version) continue;
    info.threads.set(thread.id, thread);
    info.liveAt.set(thread.id, Date.now());
    post(info, { t: 'thread', thread });
    updateBadge(info);
  }
}

function deliverDeleted(id: string, pageKey: string, altPageKey: string | null) {
  for (const info of ports) {
    if (!matches(info, { pageKey, altPageKey }) && !info.threads.has(id)) continue;
    info.threads.delete(id);
    info.tombstones.add(id);
    post(info, { t: 'thread-deleted', id });
    updateBadge(info);
  }
}

function updateBadge(info: PortInfo) {
  if (info.tabId === undefined) return;
  const open = [...info.threads.values()].filter(t => !t.resolved).length;
  chrome.action.setBadgeText({ tabId: info.tabId, text: open ? String(open) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId: info.tabId, color: '#409FFF' }).catch(() => {});
}

async function loadThreads(info: PortInfo) {
  const gen = ++info.loadGen;
  if (!session || info.keys.length === 0) {
    info.threads.clear();
    info.loaded = false;
    post(info, { t: 'threads', threads: [], loaded: false });
    updateBadge(info);
    return;
  }
  const startedAt = Date.now();
  const token = session.token;
  try {
    const query = info.keys.map(k => `key=${encodeURIComponent(k)}`).join('&');
    const { threads } = await api<{ threads: Thread[] }>('GET', `/api/threads?${query}`, { token });
    // A newer load (navigation, reconnect, sign-in) superseded this one.
    if (gen !== info.loadGen || session?.token !== token || !ports.has(info)) return;
    // Merge with what arrived live while the request was in flight: highest
    // version wins, deletions stick, and threads created meanwhile are kept.
    const merged = new Map<string, Thread>();
    for (const t of threads) {
      if (info.tombstones.has(t.id)) continue;
      const cur = info.threads.get(t.id);
      merged.set(t.id, cur && cur.version > t.version ? cur : t);
    }
    for (const [id, cur] of info.threads) {
      if (!merged.has(id) && (info.liveAt.get(id) ?? 0) >= startedAt) merged.set(id, cur);
    }
    info.threads = merged;
    info.loaded = true;
    post(info, { t: 'threads', threads: [...merged.values()], loaded: true });
    updateBadge(info);
  } catch (err) {
    if (gen !== info.loadGen) return;
    if (err instanceof RequestError && err.status === 401) return handleUnauthorized();
    // Keep whatever we showed before; tell the page we're offline.
    post(info, { t: 'threads', threads: [...info.threads.values()], loaded: info.loaded, error: (err as Error).message });
  }
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== PORT_NAME) return;
  const info: PortInfo = {
    port,
    tabId: port.sender?.tab?.id,
    keys: [],
    threads: new Map(),
    loaded: false,
    loadGen: 0,
    liveAt: new Map(),
    tombstones: new Set(),
  };
  ports.add(info);
  port.onMessage.addListener((msg: ToBackground) => {
    void ready.then(() => onPortMessage(info, msg));
  });
  port.onDisconnect.addListener(() => {
    ports.delete(info);
    syncSubscriptions();
  });
});

async function onPortMessage(info: PortInfo, msg: ToBackground) {
  if (msg.t === 'hello') {
    info.keys = Array.isArray(msg.pageKeys) ? msg.pageKeys.slice(0, 2).filter(k => typeof k === 'string') : [];
    info.threads.clear();
    info.liveAt.clear();
    info.tombstones.clear();
    info.loaded = false;
    sendState(info);
    if (!config) void refreshConfig();
    syncSubscriptions();
    ensureLive();
    await loadThreads(info);
    return;
  }
  if (msg.t === 'rpc') {
    try {
      const result = await handleRpc(msg.method, msg.params as never, info);
      post(info, { t: 'rpc-result', id: msg.id, ok: true, result });
    } catch (err) {
      const e = err as Error & { code?: string };
      post(info, { t: 'rpc-result', id: msg.id, ok: false, error: e.message || 'Something went wrong', code: e.code });
    }
  }
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

type Handler<M extends RpcMethod> = (params: RpcMethods[M]['params'], info: PortInfo) => Promise<RpcMethods[M]['result']>;

const handlers: { [M in RpcMethod]: Handler<M> } = {
  async startEmail({ email }) {
    return api('POST', '/api/auth/email/start', { body: { email } });
  },
  async verifyCode({ requestId, code }) {
    const r = await api<{ token: string; user: Me }>('POST', '/api/auth/email/verify', { body: { requestId, code } });
    await signIn(r.token, r.user);
    return { user: r.user };
  },
  async consumeLink({ token }) {
    const r = await api<{ token: string; user: Me }>('POST', '/api/auth/email/verify', { body: { token } });
    await signIn(r.token, r.user);
    return { user: r.user };
  },
  async googleSignIn() {
    const redirect = chrome.identity.getRedirectURL();
    const url = `${API_URL}/api/auth/google/start?redirect_uri=${encodeURIComponent(redirect)}`;
    const final = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
    const hash = new URLSearchParams(new URL(final ?? 'about:blank').hash.slice(1));
    const token = hash.get('session');
    if (!token) throw new Error(hash.get('error') === 'google_failed' ? 'Google sign-in failed' : 'Sign-in was cancelled');
    const { user } = await api<{ user: Me }>('GET', '/api/me', { token });
    await signIn(token, user);
    return { user };
  },
  async signOut() {
    const token = session?.token;
    await signOutLocal();
    if (token) api('POST', '/api/auth/logout', { token }).catch(() => {});
    return { ok: true as const };
  },
  async updateMe(params) {
    if (!session) throw new Error('Sign in first');
    const { user } = await api<{ user: Me }>('PATCH', '/api/me', { token: session.token, body: params });
    session = { ...session, user };
    await persist(['session']);
    broadcastState();
    return { user };
  },
  async mutate({ op, draftKey }) {
    if (!session) throw new Error('Sign in first');
    const full = {
      ...op,
      opId: crypto.randomUUID(),
      userId: session.user.id,
      createdAt: Date.now(),
      attempts: 0,
      status: 'pending',
    } as Op;
    ops.push(full);
    if (draftKey) delete drafts[draftKey];
    // The op is on disk before we acknowledge it: closing the tab now loses nothing.
    await persist(draftKey ? ['outbox', 'drafts'] : ['outbox']);
    broadcastState();
    void flush();
    return { opId: full.opId };
  },
  async retryOp({ opId }) {
    const op = ops.find(o => o.opId === opId);
    if (op) {
      op.status = 'pending';
      op.error = undefined;
      op.attempts = 0;
      await persist(['outbox']);
      broadcastState();
      void flush();
    }
    return { ok: true as const };
  },
  async discardOp({ opId }) {
    ops = ops.filter(o => o.opId !== opId);
    await persist(['outbox']);
    broadcastState();
    return { ok: true as const };
  },
  async saveDraft({ draft }) {
    if (!draft.text.trim()) delete drafts[draft.key];
    else drafts[draft.key] = { ...draft, updatedAt: Date.now() };
    pruneDrafts();
    await persist(['drafts']);
    broadcastState();
    return { ok: true as const };
  },
  async deleteDraft({ key }) {
    if (drafts[key]) {
      delete drafts[key];
      await persist(['drafts']);
      broadcastState();
    }
    return { ok: true as const };
  },
  async refresh(_params, info) {
    retryNow();
    await refreshConfig();
    await loadThreads(info);
    return { ok: true as const };
  },
};

function handleRpc<M extends RpcMethod>(method: M, params: RpcMethods[M]['params'], info: PortInfo) {
  const h = handlers[method] as Handler<M> | undefined;
  if (!h) return Promise.reject(new Error(`unknown method ${String(method)}`));
  return h(params, info);
}

function pruneDrafts() {
  const entries = Object.values(drafts).sort((a, b) => b.updatedAt - a.updatedAt);
  const cutoff = Date.now() - 60 * 86400_000;
  drafts = Object.fromEntries(entries.filter((d, i) => i < 300 && d.updatedAt > cutoff).map(d => [d.key, d]));
}

async function refreshConfig() {
  try {
    config = await api<ServerConfig>('GET', '/api/config', { timeoutMs: 10_000 });
    broadcastState();
  } catch {
    // offline; retry next time
  }
}

async function signIn(token: string, user: Me) {
  session = { token, user };
  await persist(['session']);
  broadcastState();
  restartLive();
  for (const info of ports) void loadThreads(info);
  void flush();
}

async function signOutLocal() {
  session = null;
  await persist(['session']);
  closeLive();
  for (const info of ports) {
    info.threads.clear();
    info.loaded = false;
    post(info, { t: 'threads', threads: [], loaded: false });
    updateBadge(info);
  }
  broadcastState();
}

async function handleUnauthorized() {
  // The session was revoked or expired. Unsent ops stay in the outbox.
  if (session) await signOutLocal();
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

let flushing = false;
let flushAgain = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

async function execute(op: Op, token: string): Promise<void> {
  try {
    switch (op.kind) {
      case 'createThread': {
        const r = await api<{ thread: Thread }>('POST', '/api/threads', { token, body: op.payload });
        deliverThread(r.thread);
        return;
      }
      case 'addComment': {
        const r = await api<{ thread: Thread }>('POST', `/api/threads/${op.threadId}/comments`, {
          token,
          body: { id: op.commentId, body: op.body },
        });
        deliverThread(r.thread);
        return;
      }
      case 'editComment': {
        const r = await api<{ thread: Thread }>('PATCH', `/api/comments/${op.commentId}`, { token, body: { body: op.body } });
        deliverThread(r.thread);
        return;
      }
      case 'deleteComment': {
        const r = await api<{ thread?: Thread; deletedThread?: string }>('DELETE', `/api/comments/${op.commentId}`, { token });
        if (r.thread) deliverThread(r.thread);
        if (r.deletedThread) deliverDeleted(r.deletedThread, op.pageKeys[0], op.pageKeys[1] ?? null);
        return;
      }
      case 'resolve': {
        const r = await api<{ thread: Thread }>('POST', `/api/threads/${op.threadId}/resolve`, {
          token,
          body: { resolved: op.resolved },
        });
        deliverThread(r.thread);
        return;
      }
    }
  } catch (err) {
    // Outcomes that mean "nothing left to do".
    if (err instanceof RequestError) {
      if (op.kind === 'deleteComment' && (err.status === 404 || err.status === 410)) return;
      if ((op.kind === 'resolve' || op.kind === 'createThread') && err.status === 410) return;
    }
    throw err;
  }
}

async function flush(): Promise<void> {
  await ready;
  if (flushing) {
    flushAgain = true;
    return;
  }
  flushing = true;
  try {
    do {
      flushAgain = false;
      for (const op of [...ops]) {
        if (!session || op.status !== 'pending' || op.userId !== session.user.id) continue;
        try {
          await execute(op, session.token);
          ops = ops.filter(o => o.opId !== op.opId);
          await persist(['outbox']);
          broadcastState();
        } catch (err) {
          if (err instanceof TransientError) {
            op.attempts++;
            await persist(['outbox']);
            scheduleRetry(err.retryAfterMs ?? Math.min(15_000, 1000 * 2 ** Math.min(op.attempts, 4)));
            broadcastState();
            return;
          }
          if (err instanceof RequestError && err.status === 401) {
            await handleUnauthorized();
            return;
          }
          op.status = 'failed';
          op.error = (err as Error).message;
          await persist(['outbox']);
          broadcastState();
        }
      }
    } while (flushAgain);
  } finally {
    flushing = false;
    updateAlarm();
  }
}

function scheduleRetry(ms: number) {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(
    () => {
      retryTimer = null;
      void flush();
    },
    ms + Math.random() * 500,
  );
  updateAlarm();
}

function updateAlarm() {
  // Backup for when the worker is suspended while changes are waiting.
  if (ops.some(o => o.status === 'pending')) chrome.alarms.create('flush', { periodInMinutes: 0.5 });
  else chrome.alarms.clear('flush').catch(() => {});
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'flush') void flush();
});

/** Connectivity may be back: retry now instead of waiting out the backoff. */
function retryNow() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (!ws && reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectDelay = 1000;
  }
  ensureLive();
  void flush();
}

self.addEventListener('online', retryNow);

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

let ws: WebSocket | null = null;
let wsReady = false;
let reconnectDelay = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
const subscribed = new Set<string>();

function setConnection(c: Connection) {
  if (connection === c) return;
  connection = c;
  broadcastState();
}

function wantLive() {
  return !!session && ports.size > 0;
}

function ensureLive() {
  if (!wantLive()) {
    closeLive();
    return;
  }
  if (ws || reconnectTimer) return;
  connectLive();
}

function connectLive() {
  if (!session) return;
  setConnection('connecting');
  const token = session.token;
  let socket: WebSocket;
  try {
    socket = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = socket;
  wsReady = false;
  subscribed.clear();
  socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token }));
  socket.onmessage = ev => {
    let msg: any;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg.type === 'ready') {
      wsReady = true;
      reconnectDelay = 1000;
      setConnection('online');
      syncSubscriptions();
      // Catch up on anything missed while disconnected.
      for (const info of ports) void loadThreads(info);
      void flush();
      if (pingTimer) clearInterval(pingTimer);
      // Traffic every 20s keeps the service worker (and the socket) alive.
      pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
      }, 20_000);
    } else if (msg.type === 'thread' && msg.thread) {
      deliverThread(msg.thread as Thread);
    } else if (msg.type === 'thread-deleted') {
      deliverDeleted(msg.id, msg.pageKey, msg.altPageKey ?? null);
    }
  };
  socket.onclose = ev => {
    if (ws !== socket) return;
    ws = null;
    wsReady = false;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    setConnection('offline');
    if (ev.code === 4401) {
      // Verify the session before giving up on it.
      if (session)
        api('GET', '/api/me', { token: session.token }).catch(err => {
          if (err instanceof RequestError && err.status === 401) void handleUnauthorized();
        });
    }
    if (wantLive()) scheduleReconnect();
  };
  socket.onerror = () => {
    // onclose follows
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = reconnectDelay + Math.random() * 1000;
  reconnectDelay = Math.min(10_000, reconnectDelay * 2);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureLive();
  }, delay);
}

function closeLive() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
  const socket = ws;
  ws = null;
  wsReady = false;
  subscribed.clear();
  if (socket) socket.close(1000);
  setConnection('offline');
}

function restartLive() {
  closeLive();
  reconnectDelay = 1000;
  ensureLive();
}

function syncSubscriptions() {
  if (!wantLive()) {
    closeLive();
    return;
  }
  if (!ws || !wsReady) return;
  const wanted = new Set<string>();
  for (const info of ports) for (const k of info.keys) wanted.add(k);
  const add = [...wanted].filter(k => !subscribed.has(k));
  const remove = [...subscribed].filter(k => !wanted.has(k));
  // The server takes at most 10 keys per message.
  for (let i = 0; i < add.length; i += 10) ws.send(JSON.stringify({ type: 'subscribe', pageKeys: add.slice(i, i + 10) }));
  for (let i = 0; i < remove.length; i += 10) ws.send(JSON.stringify({ type: 'unsubscribe', pageKeys: remove.slice(i, i + 10) }));
  for (const k of add) subscribed.add(k);
  for (const k of remove) subscribed.delete(k);
}

// ---------------------------------------------------------------------------
// Toolbar button, install/update
// ---------------------------------------------------------------------------

const CONTENT_FILES = { early: 'early.js', main: 'content.js', css: 'highlights.css' };

async function injectInto(tabId: number) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: [CONTENT_FILES.css] });
  await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_FILES.early, CONTENT_FILES.main] });
}

async function onActionClicked(tab: { id?: number }) {
  if (tab.id === undefined) return;
  const target = [...ports].find(p => p.tabId === tab.id);
  if (target) {
    post(target, { t: 'toggle-sidebar' });
    return;
  }
  // Page loaded before the extension was installed: inject, then open.
  try {
    await injectInto(tab.id);
    setTimeout(() => {
      const p = [...ports].find(x => x.tabId === tab.id);
      if (p) post(p, { t: 'toggle-sidebar' });
    }, 500);
  } catch {
    // chrome:// pages, the Web Store, etc.
  }
}

chrome.action.onClicked.addListener(tab => void onActionClicked(tab));

// Lets end-to-end tests "click" the toolbar button (Playwright can't reach
// browser UI). Only callable from the extension's own worker context.
(globalThis as unknown as { __marginTest: unknown }).__marginTest = { onActionClicked };

chrome.runtime.onInstalled.addListener(async details => {
  if (details.reason !== 'install' && details.reason !== 'update') return;
  // Bring already-open tabs up to date without a reload.
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    if (tab.id !== undefined && !tab.discarded) injectInto(tab.id).catch(() => {});
  }
});

void ready.then(() => {
  void refreshConfig();
  void flush();
});
