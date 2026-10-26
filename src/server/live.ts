import type { WebSocket } from 'ws';
import type { ClientLiveMessage, ServerLiveMessage, Thread } from '../shared/types';
import { isValidPageKey } from '../shared/url';
import { PUBLIC_GROUP_ID } from '../shared/types';
import { sha256 } from './crypto';
import type { DB } from './db';
import { canAccessGroup } from './threads';
import { publicUser, type UserRow } from './users';

type Client = {
  socket: WebSocket;
  user: UserRow | null;
  token: string | null;
  tokenHash: string | null;
  keys: Set<string>;
  alive: boolean;
};

const MAX_SUBSCRIPTIONS = 200;
const AUTH_TIMEOUT_MS = 10_000;
/** A socket that falls this far behind is dropped (it reconnects and refetches). */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const MAX_SOCKETS_PER_USER = 30;

/**
 * Fan-out of thread changes to every socket subscribed to the thread's page.
 * Single process: Fly runs one machine (SQLite on a volume).
 */
export class LiveHub {
  private subs = new Map<string, Set<Client>>();
  private clients = new Set<Client>();
  private heartbeat: NodeJS.Timeout;

  constructor(
    private db: DB,
    private authenticate: (token: string) => UserRow | null,
    heartbeatMs = 30_000,
  ) {
    // Protocol-level pings detect dead connections (e.g. a sleeping laptop);
    // sessions are re-checked so a revoked or expired one stops receiving.
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) {
        if (c.token && !this.authenticate(c.token)) {
          c.socket.close(4401, 'session ended');
          continue;
        }
        if (!c.alive) {
          c.socket.terminate();
          continue;
        }
        c.alive = false;
        try {
          c.socket.ping();
        } catch {
          // ignore
        }
      }
    }, heartbeatMs);
    this.heartbeat.unref();
  }

  close() {
    clearInterval(this.heartbeat);
    for (const c of this.clients) c.socket.close(1001, 'server shutting down');
  }

  get size() {
    return this.clients.size;
  }

  attach(socket: WebSocket) {
    const client: Client = { socket, user: null, token: null, tokenHash: null, keys: new Set(), alive: true };
    this.clients.add(client);
    const authTimer = setTimeout(() => {
      if (!client.user) socket.close(4401, 'auth timeout');
    }, AUTH_TIMEOUT_MS);

    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('message', (data, isBinary) => {
      client.alive = true;
      if (isBinary) return;
      let msg: ClientLiveMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return this.send(client, { type: 'error', error: 'bad_json' });
      }
      this.onMessage(client, msg, authTimer);
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      this.detach(client);
    });
    socket.on('error', () => {
      this.detach(client);
    });
  }

  private onMessage(client: Client, msg: ClientLiveMessage, authTimer: NodeJS.Timeout) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') return this.send(client, { type: 'pong' });
    if (msg.type === 'auth') {
      const user = typeof msg.token === 'string' ? this.authenticate(msg.token) : null;
      if (!user) {
        this.send(client, { type: 'error', error: 'unauthorized' });
        client.socket.close(4401, 'unauthorized');
        return;
      }
      clearTimeout(authTimer);
      // Re-authenticating as someone else must not inherit subscriptions.
      if (client.user && client.user.id !== user.id) this.unsubscribeAll(client);
      const sockets = [...this.clients].filter(c => c !== client && c.user?.id === user.id).length;
      if (sockets >= MAX_SOCKETS_PER_USER) {
        this.send(client, { type: 'error', error: 'too_many_connections' });
        client.socket.close(4429, 'too many connections');
        return;
      }
      client.user = user;
      client.token = msg.token;
      client.tokenHash = sha256(msg.token);
      return this.send(client, { type: 'ready', user: publicUser(user) });
    }
    if (!client.user) return this.send(client, { type: 'error', error: 'unauthorized' });
    if (msg.type === 'subscribe' || msg.type === 'unsubscribe') {
      const groupId = typeof msg.groupId === 'string' ? msg.groupId : PUBLIC_GROUP_ID;
      if (!Array.isArray(msg.pageKeys)) return;
      if (msg.type === 'subscribe' && !canAccessGroup(this.db, client.user, groupId)) {
        return this.send(client, { type: 'error', error: 'forbidden' });
      }
      const installed: string[] = [];
      const rejected: string[] = [];
      for (const pageKey of msg.pageKeys.slice(0, 10)) {
        if (!isValidPageKey(pageKey)) continue;
        const key = `${groupId}|${pageKey}`;
        if (msg.type === 'subscribe') {
          if (client.keys.size >= MAX_SUBSCRIPTIONS && !client.keys.has(key)) {
            rejected.push(pageKey);
            continue;
          }
          installed.push(pageKey);
          client.keys.add(key);
          let set = this.subs.get(key);
          if (!set) this.subs.set(key, (set = new Set()));
          set.add(client);
        } else {
          client.keys.delete(key);
          const set = this.subs.get(key);
          set?.delete(client);
          if (set && set.size === 0) this.subs.delete(key);
        }
      }
      // Acknowledge, so the client fetches its catch-up snapshot only once
      // live delivery for these pages is in place.
      if (msg.type === 'subscribe') this.send(client, { type: 'subscribed', groupId, pageKeys: installed, rejected });
    }
  }

  private detach(client: Client) {
    this.clients.delete(client);
    this.unsubscribeAll(client);
  }

  private unsubscribeAll(client: Client) {
    for (const key of client.keys) {
      const set = this.subs.get(key);
      set?.delete(client);
      if (set && set.size === 0) this.subs.delete(key);
    }
    client.keys.clear();
  }

  private send(client: Client, msg: ServerLiveMessage) {
    if (client.socket.readyState !== 1) return;
    if (client.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      // Slow or stalled reader: don't let its queue grow without bound.
      client.socket.terminate();
      return;
    }
    try {
      client.socket.send(JSON.stringify(msg));
    } catch {
      // the close handler cleans up
    }
  }

  private recipients(groupId: string, pageKeys: Array<string | null>): Set<Client> {
    const out = new Set<Client>();
    for (const k of pageKeys) {
      if (!k) continue;
      for (const c of this.subs.get(`${groupId}|${k}`) ?? []) {
        // Membership can change after subscribing (private groups).
        if (c.user && (groupId === PUBLIC_GROUP_ID || canAccessGroup(this.db, c.user, groupId))) out.add(c);
      }
    }
    return out;
  }

  publishThread(thread: Thread) {
    const msg: ServerLiveMessage = { type: 'thread', thread };
    for (const c of this.recipients(thread.groupId, [thread.pageKey, thread.altPageKey])) this.send(c, msg);
  }

  publishDeleted(groupId: string, id: string, pageKey: string, altPageKey: string | null) {
    const msg: ServerLiveMessage = { type: 'thread-deleted', id, pageKey, altPageKey };
    for (const c of this.recipients(groupId, [pageKey, altPageKey])) this.send(c, msg);
  }

  /** Close sockets authenticated with a session that was just signed out. */
  disconnectSession(token: string) {
    const hash = sha256(token);
    for (const c of this.clients) if (c.tokenHash === hash) c.socket.close(4401, 'signed out');
  }
}
