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
  loadFailures: number;
  /** The content script instance (tab page load) behind this port. */
  instanceId?: string;
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

/** Unsent work is private to the account that wrote it. */
function opsFor(info: PortInfo): Op[] {
  if (!session) return [];
  const me = session.user.id;
  return ops.filter(op => op.userId === me && op.pageKeys.some(k => info.keys.includes(k)));
}

function draftsFor(info: PortInfo): Draft[] {
  if (!session) return [];
  const me = session.user.id;
  return Object.values(drafts).filter(d => {
    if (d.userId !== me) return false;
    const keys = d.anchor?.pageKeys ?? d.pageKeys;
    return !keys || keys.some(k => info.keys.includes(k));
  });
}

/**
 * Drafts are stored per account, editor key and tab: "<user>|<key>|<tab>".
 * Each tab writes only its own slot, so tabs never overwrite each other; a
 * draft is removed by its own tab, or by text (what the user saw) when it is
 * discarded, cancelled or submitted from another tab.
 */
function draftSlot(key: string, instanceId: string, userId = session?.user.id): string | null {
  return userId ? `${userId}|${key}|${instanceId}` : null;
}

function normalizedText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Remove the user's drafts for `key` whose text is in `texts` (or a prefix of
 * `subsumedBy`). Drafts of other tabs that are still open are kept unless
 * `includeLive` — those tabs still show (and own) their text.
 */
function removeDraftsByText(userId: string, key: string, texts: string[], subsumedBy?: string, includeLive = false, self?: string): boolean {
  const wanted = new Set(texts.map(normalizedText).filter(Boolean));
  const sub = subsumedBy ? normalizedText(subsumedBy) : null;
  const live = new Set([...ports].map(p => p.instanceId).filter((x): x is string => !!x && x !== self));
  let changed = false;
  for (const [slot, d] of Object.entries(drafts)) {
    if (d.userId !== userId || d.key !== key) continue;
    if (!includeLive && d.instanceId && live.has(d.instanceId)) continue;
    const t = normalizedText(d.text);
    if (wanted.has(t) || (sub !== null && sub.startsWith(t))) {
      delete drafts[slot];
      changed = true;
    }
  }
  return changed;
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

function deliverThreadToPorts(thread: Thread) {
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

function deliverDeletedToPorts(id: string, pageKey: string, altPageKey: string | null) {
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
    const threads: Thread[] = [];
    let after = 0;
    for (let pageNo = 0; pageNo < 100; pageNo++) {
      const page = await api<{ threads: Thread[]; next: number | null }>('GET', `/api/threads?${query}&after=${after}`, { token });
      threads.push(...page.threads);
      if (page.next === null || page.next === undefined) break;
      after = page.next;
    }
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
    info.loadFailures = 0;
    post(info, { t: 'threads', threads: [...merged.values()], loaded: true });
    updateBadge(info);
  } catch (err) {
    if (gen !== info.loadGen) return;
    if (err instanceof RequestError && err.status === 401) {
      if (session?.token === token) return handleUnauthorized();
      return;
    }
    // Keep whatever we showed before; tell the page; try again with backoff
    // (independently of the live socket, which may be fine).
    post(info, { t: 'threads', threads: [...info.threads.values()], loaded: info.loaded, error: (err as Error).message });
    info.loadFailures++;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(info.loadFailures, 5));
    setTimeout(() => {
      if (gen === info.loadGen && ports.has(info)) void loadThreads(info);
    }, delay);
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
    loadFailures: 0,
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
    if (typeof msg.instanceId === 'string') info.instanceId = msg.instanceId;
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
    if (!token) {
      const error = hash.get('error');
      throw new Error(
        error === 'email_in_use' || error === 'use_email_code'
          ? 'Use the email code to sign in with this address.'
          : error === 'google_failed'
            ? 'Google sign-in failed'
            : 'Sign-in was cancelled',
      );
    }
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
    const token = session.token;
    const { user } = await api<{ user: Me }>('PATCH', '/api/me', { token, body: params });
    // The account may have changed while the request was in flight.
    if (session?.token !== token || session.user.id !== user.id) throw new Error('You switched accounts; try again.');
    session = { ...session, user };
    await persist(['session']);
    broadcastState();
    return { user };
  },
  async mutate({ op, draftKey, draftText, userId, draftInstance }) {
    if (!session) throw new Error('Sign in first');
    // Never attribute text to an account other than the one it was typed under.
    if (userId && userId !== session.user.id) throw new Error("You're signed in as a different account now. Your text is kept as a draft.");
    const full = {
      ...op,
      opId: crypto.randomUUID(),
      userId: session.user.id,
      createdAt: Date.now(),
      attempts: 0,
      status: 'pending',
    } as Op;
    ops.push(full);
    // The submitted text consumes this tab's draft and any draft it contains
    // (e.g. one this editor restored and extended); diverging drafts from
    // other tabs stay.
    if (draftKey && draftInstance) {
      const own = draftSlot(draftKey, draftInstance);
      if (own) delete drafts[own];
    }
    // Closed tabs' drafts contained in the submission are consumed; an open
    // tab's draft only if it's exactly the submitted text.
    const draftConsumed =
      !!draftKey &&
      (removeDraftsByText(session.user.id, draftKey, [], draftText ?? '', false, draftInstance) ||
        removeDraftsByText(session.user.id, draftKey, draftText ? [draftText] : [], undefined, true) ||
        !!draftInstance);
    await persist(draftConsumed ? ['outbox', 'drafts'] : ['outbox']);
    broadcastState();
    void flush();
    return { opId: full.opId };
  },
  async retryOp({ opId }) {
    const op = ops.find(o => o.opId === opId && o.userId === session?.user.id);
    if (op) {
      if (op.errorCode === 'id_conflict') {
        // Same ids already used for different text: send this text as new.
        if (op.kind === 'addComment') op.commentId = crypto.randomUUID();
        if (op.kind === 'createThread') {
          const threadId = crypto.randomUUID();
          op.threadId = threadId;
          op.payload = { ...op.payload, id: threadId, comment: { ...op.payload.comment, id: crypto.randomUUID() } };
        }
      }
      op.status = 'pending';
      op.errorCode = undefined;
      op.error = undefined;
      op.attempts = 0;
      await persist(['outbox']);
      broadcastState();
      void flush();
    }
    return { ok: true as const };
  },
  async discardOp({ opId }) {
    if (!session) return { ok: true as const };
    const me = session.user.id;
    ops = ops.filter(o => !(o.opId === opId && o.userId === me));
    await persist(['outbox']);
    broadcastState();
    return { ok: true as const };
  },
  async saveDraft({ draft }) {
    // Saved for the account that typed it (it may have signed out since).
    const owner = draft.userId ?? session?.user.id;
    const slot = owner ? draftSlot(draft.key, draft.instanceId ?? 'legacy', owner) : null;
    if (!slot || !owner) throw new Error('Sign in first');
    if (!draft.text.trim()) delete drafts[slot];
    else drafts[slot] = { ...draft, userId: owner, updatedAt: Date.now() };
    pruneDrafts();
    await persist(['drafts']);
    broadcastState();
    return { ok: true as const };
  },
  async deleteDraft({ key, instanceId, texts }) {
    if (!session) return { ok: true as const };
    let changed = false;
    if (instanceId) {
      const own = draftSlot(key, instanceId);
      if (own && drafts[own]) {
        delete drafts[own];
        changed = true;
      }
    }
    if (texts?.length && removeDraftsByText(session.user.id, key, texts, undefined, false, instanceId)) changed = true;
    if (changed) {
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
  const entries = Object.entries(drafts).sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  const cutoff = Date.now() - 60 * 86400_000;
  drafts = Object.fromEntries(entries.filter(([, d], i) => i < 300 && d.updatedAt > cutoff && d.userId));
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
  // Results only reach pages while the session that made the request is
  // still the current one (the op itself is still acknowledged either way).
  const deliverThread = (t: Thread) => {
    if (session?.token === token) deliverThreadToPorts(t);
  };
  const deliverDeleted = (id: string, pageKey: string, alt: string | null) => {
    if (session?.token === token) deliverDeletedToPorts(id, pageKey, alt);
  };
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
        const token = session.token;
        try {
          await execute(op, token);
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
            // Only if that session is still the current one.
            if (session?.token === token) await handleUnauthorized();
            return;
          }
          op.status = 'failed';
          op.error = (err as Error).message;
          op.errorCode = err instanceof RequestError ? err.code : undefined;
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
/** Subscribe requests sent but not yet acknowledged. */
const requested = new Set<string>();

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
  requested.clear();
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
      // Subscribe; each page catches up once its subscription is acknowledged.
      syncSubscriptions();
      void flush();
      if (pingTimer) clearInterval(pingTimer);
      // Traffic every 20s keeps the service worker (and the socket) alive.
      pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
      }, 20_000);
    } else if (msg.type === 'subscribed' && Array.isArray(msg.pageKeys)) {
      onSubscribed(msg.pageKeys, Array.isArray(msg.rejected) ? msg.rejected : []);
      // Live delivery for these pages is in place: fetch a snapshot now, so
      // nothing committed in between can be missed.
      for (const info of ports) if (info.keys.some(k => msg.pageKeys.includes(k))) void loadThreads(info);
    } else if (msg.type === 'thread' && msg.thread) {
      if (session?.token === token) deliverThreadToPorts(msg.thread as Thread);
    } else if (msg.type === 'thread-deleted') {
      if (session?.token === token) deliverDeletedToPorts(msg.id, msg.pageKey, msg.altPageKey ?? null);
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
      // Verify the session before giving up on it (if it's still current then).
      if (session?.token === token)
        api('GET', '/api/me', { token }).catch(err => {
          if (err instanceof RequestError && err.status === 401 && session?.token === token) void handleUnauthorized();
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
  requested.clear();
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
  for (const k of [...requested]) if (!wanted.has(k)) requested.delete(k);
  const remove = [...subscribed].filter(k => !wanted.has(k));
  // Removals first (frees capacity), then additions in batches of the
  // server's per-message limit. Keys count as subscribed only once the
  // server acknowledges them; refused ones are retried later.
  for (let i = 0; i < remove.length; i += 10) ws.send(JSON.stringify({ type: 'unsubscribe', pageKeys: remove.slice(i, i + 10) }));
  for (const k of remove) subscribed.delete(k);
  const toRequest = add.filter(k => !requested.has(k));
  for (let i = 0; i < toRequest.length; i += 10) ws.send(JSON.stringify({ type: 'subscribe', pageKeys: toRequest.slice(i, i + 10) }));
  for (const k of toRequest) requested.add(k);
}

function onSubscribed(installed: string[], rejected: string[]) {
  for (const k of installed) {
    requested.delete(k);
    subscribed.add(k);
  }
  for (const k of rejected) requested.delete(k);
  if (rejected.length) setTimeout(syncSubscriptions, 15_000);
}

// ---------------------------------------------------------------------------
// Toolbar button, install/update
// ---------------------------------------------------------------------------

const CONTENT_FILES = { early: 'early.js', main: 'content.js', css: 'highlights.css' };

async function injectInto(tabId: number) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: [CONTENT_FILES.css] });
  await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_FILES.early, CONTENT_FILES.main] });
}

/** The content script's connection for a tab, waiting briefly for it to show up. */
async function portForTab(tabId: number, waitMs: number): Promise<PortInfo | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const p = [...ports].find(x => x.tabId === tabId);
    if (p || Date.now() >= deadline) return p;
    await new Promise(r => setTimeout(r, 100));
  }
}

async function onActionClicked(tab: { id?: number }) {
  if (tab.id === undefined) return;
  await ready;
  // The page's script may still be connecting (page just loaded, or the
  // worker just woke up): give it a moment before assuming it's missing.
  let target = await portForTab(tab.id, 1500);
  if (!target) {
    // Page loaded before the extension was installed: inject, then open.
    try {
      await injectInto(tab.id);
    } catch {
      return; // chrome:// pages, the Web Store, etc.
    }
    target = await portForTab(tab.id, 3000);
  }
  if (target) post(target, { t: 'toggle-sidebar' });
}

chrome.action.onClicked.addListener(tab => void onActionClicked(tab));

// Lets end-to-end tests "click" the toolbar button (Playwright can't reach
// browser UI). Only callable from the extension's own worker context.
(globalThis as unknown as { __marginTest: unknown }).__marginTest = {
  onActionClicked,
  debug: () => ({ ports: [...ports].map(p => ({ tab: p.tabId, keys: p.keys })), connection, signedIn: !!session }),
};

chrome.runtime.onInstalled.addListener(async details => {
  if (details.reason !== 'install' && details.reason !== 'update') return;
  // Bring already-open tabs up to date without a reload. Tabs that loaded
  // after the install already run the manifest's content scripts (they
  // connect within moments); injecting there too would start a second copy.
  await new Promise(r => setTimeout(r, 1000));
  const connected = new Set([...ports].map(p => p.tabId));
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    if (tab.id !== undefined && !tab.discarded && !connected.has(tab.id)) injectInto(tab.id).catch(() => {});
  }
});

void ready.then(() => {
  void refreshConfig();
  void flush();
});
