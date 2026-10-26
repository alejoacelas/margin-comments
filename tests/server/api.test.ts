import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auth, makeApp, signIn, type TestApp, threadPayload } from './helpers';

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.app.close();
});

describe('email sign-in', () => {
  it('signs in with the emailed code and normalizes the address', async () => {
    const { token, user } = await signIn(t, 'Alice@Example.COM');
    expect(user.email).toBe('alice@example.com');
    expect(user.name).toBe('Alice');
    const me = await t.app.inject({ method: 'GET', url: '/api/me', headers: auth(token) });
    expect(me.json().user.email).toBe('alice@example.com');
  });

  it('locks a request after 5 wrong codes and never accepts it again', async () => {
    const start = await t.app.inject({ method: 'POST', url: '/api/auth/email/start', payload: { email: 'bob@example.com' } });
    const { requestId } = start.json();
    await t.queue.tick();
    const code = /(\d{6})/.exec(t.provider.to('bob@example.com')[0].subject)![1];
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const r = await t.app.inject({ method: 'POST', url: '/api/auth/email/verify', payload: { requestId, code: wrong } });
      expect(r.statusCode).toBe(400);
    }
    const r = await t.app.inject({ method: 'POST', url: '/api/auth/email/verify', payload: { requestId, code } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('too_many_attempts');
  });

  it('link tokens are single-use', async () => {
    await t.app.inject({ method: 'POST', url: '/api/auth/email/start', payload: { email: 'carol@example.com' } });
    await t.queue.tick();
    const mail = t.provider.to('carol@example.com')[0];
    const token = /#token=([\w-]+)/.exec(mail.text)![1];
    expect(mail.text).toContain('https://mc.test/auth/verify#token=');
    const ok = await t.app.inject({ method: 'POST', url: '/api/auth/email/verify', payload: { token } });
    expect(ok.statusCode).toBe(200);
    const again = await t.app.inject({ method: 'POST', url: '/api/auth/email/verify', payload: { token } });
    expect(again.statusCode).toBe(400);
  });

  it('rate-limits sign-in emails per address', async () => {
    for (let i = 0; i < 6; i++) {
      const r = await t.app.inject({ method: 'POST', url: '/api/auth/email/start', payload: { email: 'spam@example.com' } });
      expect(r.statusCode).toBe(200);
    }
    const r = await t.app.inject({ method: 'POST', url: '/api/auth/email/start', payload: { email: 'spam@example.com' } });
    expect(r.statusCode).toBe(429);
  });

  it('rejects malformed emails', async () => {
    for (const email of ['nope', 'a@b', 'x y@z.com', '<a@b.com>', 'a@b.com\r\nBcc: c@d.com']) {
      const r = await t.app.inject({ method: 'POST', url: '/api/auth/email/start', payload: { email } });
      expect(r.statusCode, email).toBe(400);
    }
  });

  it('logout revokes the session', async () => {
    const { token } = await signIn(t, 'dave@example.com');
    await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: auth(token) });
    const me = await t.app.inject({ method: 'GET', url: '/api/me', headers: auth(token) });
    expect(me.statusCode).toBe(401);
  });
});

describe('threads', () => {
  it('requires a session', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/threads?key=example.com%2Farticle' });
    expect(r.statusCode).toBe(401);
    const c = await t.app.inject({ method: 'POST', url: '/api/threads', payload: threadPayload() });
    expect(c.statusCode).toBe(401);
  });

  it('creates idempotently and lists by either page key', async () => {
    const { token } = await signIn(t, 'alice@example.com');
    const p = threadPayload({ pageKeys: ['example.com/canonical', 'm.example.com/article'] });
    const first = await t.app.inject({ method: 'POST', url: '/api/threads', headers: auth(token), payload: p });
    expect(first.statusCode).toBe(201);
    const thread = first.json().thread;
    expect(thread.url).toBe('https://example.com/article'); // tracking params stripped
    expect(thread.comments[0].body).toBe('First!');
    const retry = await t.app.inject({ method: 'POST', url: '/api/threads', headers: auth(token), payload: p });
    expect(retry.statusCode).toBe(200);
    for (const key of ['example.com/canonical', 'm.example.com/article']) {
      const list = await t.app.inject({ method: 'GET', url: `/api/threads?key=${encodeURIComponent(key)}`, headers: auth(token) });
      expect(list.json().threads).toHaveLength(1);
    }
  });

  it('page keys with commas, escapes and unicode round-trip (decoded exactly once)', async () => {
    const { token } = await signIn(t, 'alice@example.com');
    const keys = ['example.com/a%20b', 'example.com/x,y', 'example.com/caf%C3%A9?q=1,2'];
    for (const key of keys) {
      const p = threadPayload({ pageKeys: [key] });
      expect((await t.app.inject({ method: 'POST', url: '/api/threads', headers: auth(token), payload: p })).statusCode).toBe(201);
      const list = await t.app.inject({ method: 'GET', url: `/api/threads?key=${encodeURIComponent(key)}`, headers: auth(token) });
      expect(list.statusCode, key).toBe(200);
      expect(list.json().threads.map((x: { pageKey: string }) => x.pageKey), key).toEqual([key]);
    }
    const both = await t.app.inject({ method: 'GET', url: `/api/threads?key=${encodeURIComponent(keys[0])}&key=${encodeURIComponent(keys[1])}`, headers: auth(token) });
    expect(both.json().threads).toHaveLength(2);
  });

  it('ignores spoofed client-IP headers when there is no trusted proxy', async () => {
    let limited = 0;
    for (let i = 0; i < 60; i++) {
      const r = await t.app.inject({
        method: 'POST',
        url: '/api/auth/email/start',
        headers: { 'fly-client-ip': `10.0.0.${i}`, 'x-forwarded-for': `10.0.1.${i}` },
        payload: { email: `user${i}@example.com` },
      });
      if (r.statusCode === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });

  it('lists every thread of a busy page through pagination', async () => {
    const { token } = await signIn(t, 'alice@example.com');
    t.provider.sent = [];
    const ids = new Set<string>();
    for (let i = 0; i < 450; i++) {
      const p = threadPayload();
      ids.add(p.id);
      // Direct inserts keep this fast; the API path is covered elsewhere.
      const { createThread } = await import('../../src/server/threads');
      createThread(t.db, (await import('../../src/server/users')).getUserByEmail(t.db, 'alice@example.com')!, { ...p, groupId: 'public' } as any);
    }
    const seen = new Set<string>();
    let after = 0;
    for (let i = 0; i < 10; i++) {
      const r = (await t.app.inject({ method: 'GET', url: `/api/threads?key=example.com%2Farticle&after=${after}`, headers: auth(token) })).json();
      for (const th of r.threads) seen.add(th.id);
      if (r.next === null) break;
      after = r.next;
    }
    expect(seen.size).toBe(450);
    expect([...ids].every(id => seen.has(id))).toBe(true);
  });

  it("refuses another user's id reuse", async () => {
    const a = await signIn(t, 'alice@example.com');
    const b = await signIn(t, 'bob@example.com');
    const p = threadPayload();
    await t.app.inject({ method: 'POST', url: '/api/threads', headers: auth(a.token), payload: p });
    const r = await t.app.inject({ method: 'POST', url: '/api/threads', headers: auth(b.token), payload: p });
    expect(r.statusCode).toBe(409);
  });

  it('validates input', async () => {
    const { token } = await signIn(t, 'alice@example.com');
    const bad = [
      threadPayload({ selectors: [{ type: 'TextPositionSelector', start: 0, end: 3 }] }),
      threadPayload({ comment: { id: randomUUID(), body: '   ' } }),
      threadPayload({ comment: { id: randomUUID(), body: 'x'.repeat(10_001) } }),
      threadPayload({ id: 'not-a-uuid' }),
      threadPayload({ url: 'javascript:alert(1)' }),
      threadPayload({ pageKeys: ['has space'] }),
      threadPayload({ pageKeys: [] }),
    ];
    for (const p of bad) {
      const r = await t.app.inject({ method: 'POST', url: '/api/threads', headers: auth(token), payload: p });
      expect(r.statusCode, JSON.stringify(p).slice(0, 120)).toBeGreaterThanOrEqual(400);
      expect(r.statusCode).toBeLessThan(500);
    }
    const junk = await t.app.inject({ method: 'POST', url: '/api/threads', headers: { ...auth(token), 'content-type': 'application/json' }, payload: '{nope' });
    expect(junk.statusCode).toBe(400);
  });

  it('only authors can edit or delete their comments; deleting the first comment deletes the thread', async () => {
    const a = await signIn(t, 'alice@example.com');
    const b = await signIn(t, 'bob@example.com');
    const p = threadPayload();
    await t.app.inject({ method: 'POST', url: '/api/threads', headers: auth(a.token), payload: p });
    const replyId = randomUUID();
    const reply = await t.app.inject({ method: 'POST', url: `/api/threads/${p.id}/comments`, headers: auth(b.token), payload: { id: replyId, body: 'Bob here' } });
    expect(reply.statusCode).toBe(201);

    const editOther = await t.app.inject({ method: 'PATCH', url: `/api/comments/${p.comment.id}`, headers: auth(b.token), payload: { body: 'hacked' } });
    expect(editOther.statusCode).toBe(403);
    const delOther = await t.app.inject({ method: 'DELETE', url: `/api/comments/${p.comment.id}`, headers: auth(b.token) });
    expect(delOther.statusCode).toBe(403);

    const edit = await t.app.inject({ method: 'PATCH', url: `/api/comments/${replyId}`, headers: auth(b.token), payload: { body: 'Bob, edited' } });
    expect(edit.json().thread.comments[1].body).toBe('Bob, edited');
    expect(edit.json().thread.comments[1].editedAt).toBeTruthy();

    const delReply = await t.app.inject({ method: 'DELETE', url: `/api/comments/${replyId}`, headers: auth(b.token) });
    expect(delReply.json().thread.comments).toHaveLength(1);
    const delAgain = await t.app.inject({ method: 'DELETE', url: `/api/comments/${replyId}`, headers: auth(b.token) });
    expect(delAgain.statusCode).toBe(200);

    const delThread = await t.app.inject({ method: 'DELETE', url: `/api/comments/${p.comment.id}`, headers: auth(a.token) });
    expect(delThread.json().deletedThread).toBe(p.id);
    const list = await t.app.inject({ method: 'GET', url: '/api/threads?key=example.com%2Farticle', headers: auth(a.token) });
    expect(list.json().threads).toHaveLength(0);
    // A retried create of a deleted thread does not resurrect it.
    const recreate = await t.app.inject({ method: 'POST', url: '/api/threads', headers: auth(a.token), payload: p });
    expect(recreate.statusCode).toBe(410);
    const replyToDeleted = await t.app.inject({ method: 'POST', url: `/api/threads/${p.id}/comments`, headers: auth(b.token), payload: { id: randomUUID(), body: 'late' } });
    expect(replyToDeleted.statusCode).toBe(410);
  });

  it('resolve/reopen; a reply reopens a resolved thread', async () => {
    const a = await signIn(t, 'alice@example.com');
    const b = await signIn(t, 'bob@example.com');
    const p = threadPayload();
    await t.app.inject({ method: 'POST', url: '/api/threads', headers: auth(a.token), payload: p });
    const resolved = await t.app.inject({ method: 'POST', url: `/api/threads/${p.id}/resolve`, headers: auth(b.token), payload: { resolved: true } });
    expect(resolved.json().thread.resolved).toBe(true);
    expect(resolved.json().thread.resolvedBy.id).toBe(b.user.id);
    const reply = await t.app.inject({ method: 'POST', url: `/api/threads/${p.id}/comments`, headers: auth(a.token), payload: { id: randomUUID(), body: 'reopen' } });
    expect(reply.json().thread.resolved).toBe(false);
  });

  it('never exposes other users’ email addresses', async () => {
    const a = await signIn(t, 'alice@example.com');
    const b = await signIn(t, 'bob@example.com');
    const p = threadPayload();
    await t.app.inject({ method: 'POST', url: '/api/threads', headers: auth(a.token), payload: p });
    const list = await t.app.inject({ method: 'GET', url: '/api/threads?key=example.com%2Farticle', headers: auth(b.token) });
    expect(list.body).not.toContain('alice@example.com');
  });

  it('display names are cleaned and can be changed; notifications can be turned off', async () => {
    const a = await signIn(t, 'alice@example.com');
    const r = await t.app.inject({ method: 'PATCH', url: '/api/me', headers: auth(a.token), payload: { name: '  Alice\u0000  <b>A</b>  ', notifyEmail: false } });
    expect(r.json().user.name).toBe('Alice <b>A</b>');
    expect(r.json().user.notifyEmail).toBe(false);
    const empty = await t.app.inject({ method: 'PATCH', url: '/api/me', headers: auth(a.token), payload: { name: '   ' } });
    expect(empty.statusCode).toBe(400);
  });
});

describe('pages', () => {
  it('admin outbox needs the password', async () => {
    const no = await t.app.inject({ method: 'GET', url: '/admin/outbox' });
    expect(no.statusCode).toBe(401);
    const wrong = await t.app.inject({ method: 'GET', url: '/admin/outbox', headers: { authorization: 'Basic ' + Buffer.from('x:nope').toString('base64') } });
    expect(wrong.statusCode).toBe(401);
    const ok = await t.app.inject({ method: 'GET', url: '/admin/outbox', headers: { authorization: 'Basic ' + Buffer.from('admin:admin-pass').toString('base64') } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('serves the verify page without scripts', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/auth/verify' });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('<script');
    expect(r.headers['x-frame-options']).toBe('DENY');
  });
});

describe('private groups (data model readiness)', () => {
  it('enforces membership on reads, writes, idempotent retries and notifications', async () => {
    const a = await signIn(t, 'alice@example.com');
    const b = await signIn(t, 'bob@example.com');
    const c = await signIn(t, 'carol@example.com');
    const now = new Date().toISOString();
    t.db.prepare("INSERT INTO groups (id, name, visibility, created_at) VALUES ('g1', 'Book club', 'private', ?)").run(now);
    for (const u of [a, c]) t.db.prepare("INSERT INTO group_members (group_id, user_id, created_at) VALUES ('g1', ?, ?)").run(u.user.id, now);

    const p = threadPayload({ groupId: 'g1' });
    expect((await t.app.inject({ method: 'POST', url: '/api/threads', headers: auth(a.token), payload: p })).statusCode).toBe(201);
    // Non-member: can't see or touch it.
    expect((await t.app.inject({ method: 'GET', url: '/api/threads?group=g1&key=example.com%2Farticle', headers: auth(b.token) })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/api/threads?key=example.com%2Farticle', headers: auth(b.token) })).json().threads).toEqual([]);
    expect((await t.app.inject({ method: 'GET', url: `/api/threads/${p.id}`, headers: auth(b.token) })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: `/api/threads/${p.id}/comments`, headers: auth(b.token), payload: { id: randomUUID(), body: 'x' } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: `/api/threads/${p.id}/resolve`, headers: auth(b.token), payload: { resolved: true } })).statusCode).toBe(404);

    // Alice loses membership: retries of her own earlier writes reveal nothing.
    const replyId = randomUUID();
    await t.app.inject({ method: 'POST', url: `/api/threads/${p.id}/comments`, headers: auth(a.token), payload: { id: replyId, body: 'mine' } });
    t.db.prepare("DELETE FROM group_members WHERE group_id = 'g1' AND user_id = ?").run(a.user.id);
    expect((await t.app.inject({ method: 'POST', url: '/api/threads', headers: auth(a.token), payload: p })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: `/api/threads/${p.id}/comments`, headers: auth(a.token), payload: { id: replyId, body: 'mine' } })).statusCode).toBe(404);

    // Carol replies: Alice (no longer a member) is not emailed.
    t.provider.sent = [];
    await t.app.inject({ method: 'POST', url: `/api/threads/${p.id}/comments`, headers: auth(c.token), payload: { id: randomUUID(), body: 'secret' } });
    await t.queue.tick();
    expect(t.provider.sent.filter(s => s.msg.to === 'alice@example.com')).toEqual([]);
  });
});
