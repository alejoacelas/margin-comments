import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadConfig } from '../../src/server/config';
import { auth, makeApp, signIn, type TestApp, threadPayload } from './helpers';

let t: TestApp | null = null;
let google: Server | null = null;
afterEach(async () => {
  await t?.app.close();
  google?.close();
  t = null;
  google = null;
});

/** A fake Google: token endpoint + userinfo, configurable verified flag. */
type Profile = { sub: string; email: string; email_verified: boolean; name: string; hd?: string };

async function fakeGoogle(profile: Profile) {
  const seen: Array<Record<string, string>> = [];
  google = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      if (req.url === '/token') {
        seen.push(Object.fromEntries(new URLSearchParams(body)));
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ access_token: 'at-123', token_type: 'Bearer' }));
      }
      if (req.url === '/userinfo' && req.headers.authorization === 'Bearer at-123') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(profile));
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>(r => google!.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(google.address() as AddressInfo).port}`;
  return { base, seen };
}

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const REDIRECT = `https://${EXT}.chromiumapp.org/`;

async function googleApp(profile: Profile) {
  const g = await fakeGoogle(profile);
  const base = loadConfig();
  t = await makeApp({
    google: { ...base.google, clientId: 'cid', clientSecret: 'csecret', authUrl: `${g.base}/auth`, tokenUrl: `${g.base}/token`, userinfoUrl: `${g.base}/userinfo` },
  });
  return g;
}

describe('Google sign-in', () => {
  it('only redirects to allowed extension ids', async () => {
    await googleApp({ sub: '1', email: 'g@example.com', email_verified: true, name: 'G' });
    for (const bad of ['https://evil.example/', 'https://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.chromiumapp.org/', `http://${EXT}.chromiumapp.org/`, `https://${EXT}.chromiumapp.org.evil.com/`]) {
      const r = await t!.app.inject({ method: 'GET', url: `/api/auth/google/start?redirect_uri=${encodeURIComponent(bad)}` });
      expect(r.statusCode, bad).toBe(400);
    }
  });

  it('completes the flow with PKCE, creates a session, and states are single-use', async () => {
    const g = await googleApp({ sub: 'g-1', email: 'Gina@Gmail.com', email_verified: true, name: 'Gina G' });
    const start = await t!.app.inject({ method: 'GET', url: `/api/auth/google/start?redirect_uri=${encodeURIComponent(REDIRECT)}` });
    expect(start.statusCode).toBe(302);
    const authUrl = new URL(start.headers.location as string);
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('redirect_uri')).toBe('https://mc.test/api/auth/google/callback');
    const state = authUrl.searchParams.get('state')!;

    const cb = await t!.app.inject({ method: 'GET', url: `/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}` });
    expect(cb.statusCode).toBe(302);
    const final = new URL(cb.headers.location as string);
    expect(final.origin + final.pathname).toBe(REDIRECT);
    const token = new URLSearchParams(final.hash.slice(1)).get('session')!;
    expect(g.seen[0].code_verifier).toBeTruthy();
    expect(g.seen[0].client_secret).toBe('csecret');
    const me = await t!.app.inject({ method: 'GET', url: '/api/me', headers: auth(token) });
    expect(me.json().user).toMatchObject({ email: 'gina@gmail.com', name: 'Gina G' });

    const replay = await t!.app.inject({ method: 'GET', url: `/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}` });
    expect(replay.statusCode).toBe(400);
  });

  async function signInGoogle() {
    const start = await t!.app.inject({ method: 'GET', url: `/api/auth/google/start?redirect_uri=${encodeURIComponent(REDIRECT)}` });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const cb = await t!.app.inject({ method: 'GET', url: `/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}` });
    const hash = new URLSearchParams(new URL(cb.headers.location as string).hash.slice(1));
    const token = hash.get('session');
    if (!token) return { error: hash.get('error') };
    return { user: (await t!.app.inject({ method: 'GET', url: '/api/me', headers: auth(token) })).json().user, token };
  }

  it('a Google account keeps its user when its (Workspace) email changes', async () => {
    const profile: Profile = { sub: 'g-stable', email: 'old@corp.example', email_verified: true, name: 'Pat', hd: 'corp.example' };
    await googleApp(profile);
    const first = await signInGoogle();
    profile.email = 'new@corp.example';
    const second = await signInGoogle();
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.email).toBe('new@corp.example');
  });

  it("Google can't sign up, link or take over addresses it isn't authoritative for", async () => {
    // Alice's Google account lists a (non-Google) company address she no longer owns.
    const profile: Profile = { sub: 'g-alice', email: 'shared@company.example', email_verified: true, name: 'Alice' };
    await googleApp(profile);
    expect((await signInGoogle()).error).toBe('use_email_code'); // no pre-hijack sign-up
    const bob = await signIn(t!, 'shared@company.example');
    expect((await signInGoogle()).error).toBe('use_email_code'); // no takeover
    expect((await t!.app.inject({ method: 'GET', url: '/api/me', headers: auth(bob.token) })).json().user.email).toBe('shared@company.example');
  });

  it('when Google reports a new address that can not be bound, the old address stops working for that account', async () => {
    const profile: Profile = { sub: 'g-w', email: 'old@corp.example', email_verified: true, name: 'W', hd: 'corp.example' };
    await googleApp(profile);
    const first = await signInGoogle();
    await signIn(t!, 'new@corp.example'); // the new address already has an email account
    profile.email = 'new@corp.example';
    const second = await signInGoogle();
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.email).toMatch(/@unbound\.invalid$/);
    // Whoever gets old@ next gets a fresh account, not this one.
    const next = await signIn(t!, 'old@corp.example');
    expect(next.user.id).not.toBe(first.user.id);
  });

  it('links Google to an existing account when Google is authoritative (Gmail), but never replaces an identity', async () => {
    const profile: Profile = { sub: 'g-gmail', email: 'sam@gmail.com', email_verified: true, name: 'Sam' };
    await googleApp(profile);
    const emailAccount = await signIn(t!, 'sam@gmail.com');
    const linked = await signInGoogle();
    expect(linked.user.id).toBe(emailAccount.user.id);
    profile.sub = 'g-other';
    expect((await signInGoogle()).error).toBe('email_in_use');
  });

  it('refuses unverified Google emails', async () => {
    await googleApp({ sub: 'g-2', email: 'victim@example.com', email_verified: false, name: 'X' });
    const start = await t!.app.inject({ method: 'GET', url: `/api/auth/google/start?redirect_uri=${encodeURIComponent(REDIRECT)}` });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const cb = await t!.app.inject({ method: 'GET', url: `/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}` });
    expect(new URL(cb.headers.location as string).hash).toBe('#error=google_failed');
  });

  it('is off when not configured', async () => {
    t = await makeApp();
    const cfg = await t.app.inject({ method: 'GET', url: '/api/config' });
    expect(cfg.json()).toEqual({ googleEnabled: false, emailMode: 'resend' });
    const r = await t.app.inject({ method: 'GET', url: `/api/auth/google/start?redirect_uri=${encodeURIComponent(REDIRECT)}` });
    expect(r.statusCode).toBe(404);
  });
});

describe('live updates', () => {
  async function listen(app: TestApp) {
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    return `ws://127.0.0.1:${(app.app.server.address() as AddressInfo).port}/api/live`;
  }

  function connect(url: string) {
    const ws = new WebSocket(url);
    const messages: any[] = [];
    ws.on('message', d => messages.push(JSON.parse(String(d))));
    const opened = new Promise<void>(r => ws.on('open', () => r()));
    const closed = new Promise<number>(r => ws.on('close', code => r(code)));
    const waitFor = async (pred: (m: any) => boolean) => {
      for (let i = 0; i < 100; i++) {
        const m = messages.find(pred);
        if (m) return m;
        await new Promise(r => setTimeout(r, 20));
      }
      throw new Error(`no message; got ${JSON.stringify(messages)}`);
    };
    return { ws, messages, opened, closed, waitFor };
  }

  it('delivers thread changes to subscribers of the page only', async () => {
    t = await makeApp();
    const url = await listen(t);
    const a = await signIn(t, 'alice@example.com');
    const b = await signIn(t, 'bob@example.com');
    const sub = connect(url);
    const other = connect(url);
    await Promise.all([sub.opened, other.opened]);
    sub.ws.send(JSON.stringify({ type: 'auth', token: b.token }));
    other.ws.send(JSON.stringify({ type: 'auth', token: b.token }));
    await sub.waitFor(m => m.type === 'ready');
    await other.waitFor(m => m.type === 'ready');
    sub.ws.send(JSON.stringify({ type: 'subscribe', pageKeys: ['example.com/article'] }));
    other.ws.send(JSON.stringify({ type: 'subscribe', pageKeys: ['example.com/other'] }));
    await new Promise(r => setTimeout(r, 50));

    const p = threadPayload();
    await t.app.inject({ method: 'POST', url: '/api/threads', headers: auth(a.token), payload: p });
    const created = await sub.waitFor(m => m.type === 'thread' && m.thread.id === p.id);
    expect(created.thread.comments[0].body).toBe('First!');
    await t.app.inject({ method: 'POST', url: `/api/threads/${p.id}/comments`, headers: auth(a.token), payload: { id: randomUUID(), body: 'second' } });
    await sub.waitFor(m => m.type === 'thread' && m.thread.comments.length === 2);
    await t.app.inject({ method: 'DELETE', url: `/api/comments/${p.comment.id}`, headers: auth(a.token) });
    await sub.waitFor(m => m.type === 'thread-deleted' && m.id === p.id);
    expect(other.messages.filter(m => m.type === 'thread' || m.type === 'thread-deleted')).toEqual([]);
    sub.ws.close();
    other.ws.close();
  });

  it('stops delivering when the session ends', async () => {
    t = await makeApp({}, { liveHeartbeatMs: 100 });
    const url = await listen(t);
    const b = await signIn(t, 'bob@example.com');
    const s = connect(url);
    await s.opened;
    s.ws.send(JSON.stringify({ type: 'auth', token: b.token }));
    await s.waitFor(m => m.type === 'ready');
    t.db.prepare('DELETE FROM sessions').run(); // expired/revoked elsewhere
    expect(await s.closed).toBe(4401);
  });

  it('acknowledges subscriptions, and drops readers that stop reading', async () => {
    t = await makeApp();
    const url = await listen(t);
    const a = await signIn(t, 'alice@example.com');
    const s = connect(url);
    await s.opened;
    s.ws.send(JSON.stringify({ type: 'auth', token: a.token }));
    await s.waitFor(m => m.type === 'ready');
    s.ws.send(JSON.stringify({ type: 'subscribe', pageKeys: ['example.com/article'] }));
    const ack = await s.waitFor(m => m.type === 'subscribed');
    expect(ack.pageKeys).toEqual(['example.com/article']);

    // Stop reading, then generate ~6 MB of updates (large quote, many edits).
    (s.ws as any)._socket.pause();
    const big = 'lorem ipsum dolor sit amet '.repeat(1800); // under the 50k quote limit
    const p = threadPayload({ quote: big, selectors: [{ type: 'TextQuoteSelector', exact: big }] });
    await t.app.inject({ method: 'POST', url: '/api/threads', headers: auth(a.token), payload: p });
    for (let i = 0; i < 80; i++) {
      await t.app.inject({ method: 'PATCH', url: `/api/comments/${p.comment.id}`, headers: auth(a.token), payload: { body: `edit ${i}` } });
    }
    const hub = (t as any).hub;
    await new Promise(r => setTimeout(r, 200));
    expect(hub.size).toBe(0); // the stalled socket was terminated
  });

  it('acknowledges only subscriptions it installed', async () => {
    t = await makeApp();
    const url = await listen(t);
    const a = await signIn(t, 'alice@example.com');
    const s = connect(url);
    await s.opened;
    s.ws.send(JSON.stringify({ type: 'auth', token: a.token }));
    await s.waitFor(m => m.type === 'ready');
    for (let i = 0; i < 200; i += 10) {
      s.ws.send(JSON.stringify({ type: 'subscribe', pageKeys: Array.from({ length: 10 }, (_, j) => `example.com/${i + j}`) }));
    }
    s.ws.send(JSON.stringify({ type: 'subscribe', pageKeys: ['example.com/extra'] }));
    const last = await s.waitFor(m => m.type === 'subscribed' && (m.rejected.length || m.pageKeys.includes('example.com/extra')));
    expect(last.pageKeys).toEqual([]);
    expect(last.rejected).toEqual(['example.com/extra']);
    s.ws.close();
  });

  it('rejects unauthenticated sockets', async () => {
    t = await makeApp();
    const url = await listen(t);
    const s = connect(url);
    await s.opened;
    s.ws.send(JSON.stringify({ type: 'subscribe', pageKeys: ['example.com/article'] }));
    await s.waitFor(m => m.type === 'error' && m.error === 'unauthorized');
    s.ws.send(JSON.stringify({ type: 'auth', token: 'nope' }));
    expect(await s.closed).toBe(4401);
  });
});
