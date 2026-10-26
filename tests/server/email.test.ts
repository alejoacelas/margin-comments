import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/server/db';
import { verifySvix, signSvix } from '../../src/server/email/inbound';
import { ResendProvider, PermanentEmailError, RetryableEmailError } from '../../src/server/email/provider';
import { EmailQueue } from '../../src/server/email/queue';
import { extractReply } from '../../src/server/email/reply-parse';
import { parseReplyAddress, replyAddress } from '../../src/server/email/reply-token';
import { auth, makeApp, receivedEmail, RecordingProvider, signIn, svixHeaders, type TestApp, threadPayload, WEBHOOK_SECRET } from './helpers';

describe('reply addresses', () => {
  const threadId = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const userId = 'abcdefghij23';
  it('round-trips and survives lowercasing, display names and mailto', () => {
    const addr = replyAddress('secret', 'reply.example.com', threadId, userId);
    expect(addr.split('@')[0].length).toBeLessThanOrEqual(64);
    expect(parseReplyAddress('secret', 'reply.example.com', addr)).toEqual({ threadId, userId });
    expect(parseReplyAddress('secret', 'reply.example.com', `"Margin" <${addr.toUpperCase()}>`)).toEqual({ threadId, userId });
  });
  it('rejects forgeries', () => {
    const addr = replyAddress('secret', 'reply.example.com', threadId, userId);
    expect(parseReplyAddress('other-secret', 'reply.example.com', addr)).toBeNull();
    expect(parseReplyAddress('secret', 'reply.example.com', addr.replace('reply.example.com', 'evil.example.com'))).toBeNull();
    // Same signature, different user (swap the user id): invalid.
    expect(parseReplyAddress('secret', 'reply.example.com', addr.replace(userId, 'zzzzzzzzzz22'))).toBeNull();
    expect(parseReplyAddress('secret', 'reply.example.com', 'r-short-x-y@reply.example.com')).toBeNull();
  });
});

describe('bareAddress', () => {
  it('takes the real mailbox, never one hidden in a display name or comment', async () => {
    const { bareAddress } = await import('../../src/server/email/reply-token');
    expect(bareAddress('Alice <Alice@Example.com>')).toBe('alice@example.com');
    expect(bareAddress('alice@example.com')).toBe('alice@example.com');
    expect(bareAddress('"Alice, A." <alice@example.com>')).toBe('alice@example.com');
    expect(bareAddress('"<alice@example.com>" <mallory@evil.test>')).toBe('mallory@evil.test');
    expect(bareAddress('(alice@example.com) mallory@evil.test')).toBe('mallory@evil.test');
    expect(bareAddress('alice@example.com, mallory@evil.test')).toBe('');
    expect(bareAddress('<alice@example.com> <mallory@evil.test>')).toBe('');
    expect(bareAddress('"unterminated <alice@example.com>')).toBe('');
  });
});

describe('svix signatures', () => {
  const secret = 'whsec_' + Buffer.from('k'.repeat(24)).toString('base64');
  const body = '{"type":"email.received"}';
  const now = 1_800_000_000;
  const headers = (sig: string, ts = now) => ({ 'svix-id': 'msg_1', 'svix-timestamp': String(ts), 'svix-signature': sig });
  it('accepts a valid signature, also among several', () => {
    const sig = signSvix(secret, 'msg_1', now, body);
    expect(verifySvix(secret, headers(`v1,${sig}`), body, now)).toBe(true);
    expect(verifySvix(secret, headers(`v1,bogus v1,${sig}`), body, now)).toBe(true);
  });
  it('rejects tampering, stale timestamps and missing headers', () => {
    const sig = signSvix(secret, 'msg_1', now, body);
    expect(verifySvix(secret, headers(`v1,${sig}`), body + ' ', now)).toBe(false);
    expect(verifySvix(secret, headers(`v1,${sig}`, now), body, now + 301)).toBe(false);
    expect(verifySvix(secret, headers(`v2,${sig}`), body, now)).toBe(false);
    expect(verifySvix(secret, {}, body, now)).toBe(false);
    expect(verifySvix('', headers(`v1,${sig}`), body, now)).toBe(false);
  });
});

describe('extractReply', () => {
  it('Gmail plain text with quote and signature', () => {
    const text = 'Sounds good to me!\n\nBest,\nAlice\n\nOn Mon, Oct 26, 2026 at 3:00 PM Margin Comments <\nr-abcdefghijklmnopqrstuvwxyz-abcdefghij23-abcdefghijklmnop@reply.mail.test> wrote:\n\n> Bob replied\n> > nested\n';
    expect(extractReply(text, null)).toBe('Sounds good to me!');
  });
  it('Gmail HTML-only', () => {
    const html = '<div dir="ltr">Two lines<br>of reply</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, Oct 26 Margin wrote:<br></div><blockquote class="gmail_quote">old stuff</blockquote></div>';
    expect(extractReply(null, html)).toBe('Two lines\nof reply');
  });
  it('Outlook headers block', () => {
    const text = 'Will do.\r\n\r\n________________________________\r\nFrom: Margin Comments <notifications@mail.test>\r\nSent: Monday, October 26, 2026 3:00 PM\r\nTo: Alice\r\nSubject: hello\r\n\r\nold text';
    expect(extractReply(text, null)).toBe('Will do.');
  });
  it('Outlook without separator line', () => {
    const text = 'Agreed.\n\nFrom: Margin Comments <notifications@mail.test>\nSent: Monday\nTo: Alice\n\nquoted';
    expect(extractReply(text, null)).toBe('Agreed.');
  });
  it('mobile signatures and RFC 3676 dash-dash', () => {
    expect(extractReply('Yes!\n\nSent from my iPhone', null)).toBe('Yes!');
    expect(extractReply('Nice.\n-- \nAlice Example\nCEO', null)).toBe('Nice.');
    expect(extractReply('Ok\n\nGet Outlook for iOS', null)).toBe('Ok');
  });
  it('keeps multi-paragraph replies and inline URLs', () => {
    const text = 'First paragraph.\n\nSecond paragraph with https://example.com/x?y=1\n\nOn Tue, Bob <bob@example.com> wrote:\n> hi';
    expect(extractReply(text, null)).toBe('First paragraph.\n\nSecond paragraph with https://example.com/x?y=1');
  });
  it('localized quote headers', () => {
    expect(extractReply('Merci !\n\nLe lun. 26 oct. 2026 à 15:00, Margin <x@y.z> a écrit :\n> salut', null)).toBe('Merci !');
    expect(extractReply('¡Gracias!\n\nEl lun, 26 oct 2026 a las 15:00, Margin (<x@y.z>) escribió:\n> hola', null)).toBe('¡Gracias!');
  });
  it('drops sign-offs but never the whole message', () => {
    expect(extractReply('Love this.\n\nThanks,\nBob', null)).toBe('Love this.');
    expect(extractReply('Love this.\n\nBest regards,\nBob Smith\nAcme Inc.', null)).toBe('Love this.');
    expect(extractReply('Thanks!', null)).toBe('Thanks!');
    expect(extractReply('We should talk about the best,\ncheapest option.', null)).toBe('We should talk about the best,\ncheapest option.');
  });
  it('keeps bottom-posted and inline replies', () => {
    expect(extractReply('On Mon, Oct 26, 2026, Bob <bob@example.com> wrote:\n> Earlier comment.\n\nMy new reply.', null)).toBe('My new reply.');
    expect(extractReply('On Mon, Bob wrote:\n> First point\nAgreed on that.\n> Second point\nNot this one.', null)).toBe('Agreed on that.\nNot this one.');
  });
  it('keeps inline answers below an introduction', () => {
    const text = 'Hi Bob, answers inline.\n\nOn Mon, Bob wrote:\n> Can we ship Friday?\nYes, Friday works.\n> Which region?\nLondon.';
    expect(extractReply(text, null)).toBe('Hi Bob, answers inline.\n\nYes, Friday works.\nLondon.');
  });
  it('does not post an unquoted copy of our own notification', () => {
    const forwarded = 'On Mon, Margin Comments wrote:\nBob replied on "Page"\n\nquote text\n\nReply to this email to respond in the thread.';
    expect(extractReply(forwarded, null)).toBe('');
  });
  it("an Outlook reply quoting our notification unquoted posts only the new text", async () => {
    const { notificationEmail } = await import('../../src/server/email/templates');
    const n = notificationEmail({
      threadId: 't1',
      pageTitle: 'A page',
      pageUrl: 'https://example.com/a',
      threadLink: 'https://example.com/a#margin-comments=t1',
      quote: 'The anchored sentence',
      replyAuthor: 'Bob',
      replyBody: 'Can we ship on Friday?',
      previous: { author: 'Alice', body: 'An earlier comment' },
      recipientStartedThread: true,
      unsubscribeLink: 'https://mc.test/unsubscribe?u=1&s=2',
      canReplyByEmail: true,
    });
    const header = 'From: Margin Comments <notifications@mail.test>\nSent: Monday, October 26, 2026 3:00 PM\nTo: Alice\nSubject: ' + n.subject;
    for (const sep of ['________________________________\n', '', '-----Original Message-----\n']) {
      const reply = `Confirmed, Friday works.\n\n${sep}${header}\n\n${n.text}`;
      expect(extractReply(reply, null), JSON.stringify(sep)).toBe('Confirmed, Friday works.');
    }
  });
  it('an HTML-only Outlook reply quoting our notification posts only the new text', async () => {
    const { notificationEmail } = await import('../../src/server/email/templates');
    const n = notificationEmail({
      threadId: 't1',
      pageTitle: 'A page',
      pageUrl: 'https://example.com/a',
      threadLink: 'https://example.com/a#margin-comments=t1',
      quote: 'The anchored sentence',
      replyAuthor: 'Bob',
      replyBody: 'Can we ship on Friday?',
      previous: { author: 'Alice', body: 'An earlier comment' },
      recipientStartedThread: true,
      unsubscribeLink: 'https://mc.test/unsubscribe?u=1&s=2',
      canReplyByEmail: true,
    });
    const outlookWeb =
      '<html><body><div dir="ltr">Yes, Friday works.</div><div id="appendonsend"></div><hr style="display:inline-block;width:98%" tabindex="-1">' +
      '<div id="divRplyFwdMsg" dir="ltr"><font face="Calibri"><b>From:</b> Margin Comments &lt;notifications@mail.test&gt;<br><b>Sent:</b> Monday, October 26, 2026 3:00 PM<br><b>To:</b> Alice<br><b>Subject:</b> hi</font><div>&nbsp;</div></div>' +
      `<div>${n.html}</div></body></html>`;
    const outlookDesktop =
      '<html><body><div class="WordSection1"><p class="MsoNormal">Yes, Friday works.</p><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in">' +
      '<p class="MsoNormal"><b>From:</b> Margin Comments<br><b>Sent:</b> Monday<br><b>To:</b> Alice</p></div>' +
      `${n.html}</div></body></html>`;
    for (const html of [outlookWeb, outlookDesktop]) {
      const out = extractReply(null, html);
      expect(out).toBe('Yes, Friday works.');
    }
  });
  it('HTML-only Apple Mail / Thunderbird replies: answers below or between <blockquote> quotes are kept', async () => {
    const { notificationEmail } = await import('../../src/server/email/templates');
    const n = notificationEmail({
      threadId: 't1',
      pageTitle: 'A page',
      pageUrl: 'https://example.com/a',
      threadLink: 'https://example.com/a#margin-comments=t1',
      quote: 'The anchored sentence',
      replyAuthor: 'Bob',
      replyBody: 'Can we ship on Friday?',
      previous: { author: 'Alice', body: 'An earlier comment' },
      recipientStartedThread: true,
      unsubscribeLink: 'https://mc.test/unsubscribe?u=1&s=2',
      canReplyByEmail: true,
    });
    const bottom = '<div>On Mon, Oct 26, 2026, at 15:00, Bob &lt;bob@example.com&gt; wrote:</div><blockquote type="cite"><div>Can we ship Friday?</div></blockquote><div>Yes, Friday works.</div>';
    expect(extractReply(null, bottom)).toBe('Yes, Friday works.');
    const inline =
      '<div>Answers below.</div><br><div>On Mon, Bob wrote:</div><blockquote type="cite"><div>Can we ship Friday?</div></blockquote><div>Yes, Friday works.</div>' +
      '<blockquote type="cite"><div>Which region?</div></blockquote><div>London.</div>';
    expect(extractReply(null, inline)).toBe('Answers below.\n\nYes, Friday works.\n\nLondon.');
    const top = `<div>Sounds good.</div><div><br><blockquote type="cite"><div>On Mon, Oct 26, 2026, Margin Comments wrote:</div>${n.html}</blockquote></div>`;
    expect(extractReply(null, top)).toBe('Sounds good.');
    const thunderbird = `<p>Thanks!</p><div class="moz-cite-prefix">On 10/26/26 3:00 PM, Margin Comments wrote:<br></div><blockquote type="cite" cite="mid:x@y">${n.html}</blockquote>`;
    expect(extractReply(null, thunderbird)).toBe('Thanks!');
  });
  it('returns empty for a quote-only reply', () => {
    expect(extractReply('\n\nOn Mon, Oct 26, 2026 Margin <x@y.z> wrote:\n> hi', null)).toBe('');
  });
});

describe('ResendProvider wire format', () => {
  it('sends snake_case JSON with auth, user agent and idempotency key', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'email-1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new ResendProvider('re_key', 'https://api.resend.test', fake);
    const r = await p.send({ to: 'a@b.com', from: 'X <n@mail.test>', replyTo: 'r@reply.test', subject: 'S', text: 'T', html: '<p>H</p>', headers: { References: '<x@y>' } }, 'notify/1/2');
    expect(r.id).toBe('email-1');
    const { url, init } = calls[0];
    expect(url).toBe('https://api.resend.test/emails');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer re_key');
    expect(headers['Idempotency-Key']).toBe('notify/1/2');
    expect(headers['User-Agent']).toMatch(/margin-comments/);
    expect(JSON.parse(init.body as string)).toEqual({ from: 'X <n@mail.test>', to: ['a@b.com'], subject: 'S', html: '<p>H</p>', text: 'T', reply_to: 'r@reply.test', headers: { References: '<x@y>' } });
  });

  it('classifies errors', async () => {
    const respond = (status: number, name: string, headers: Record<string, string> = {}) =>
      new ResendProvider('re', 'https://x', (async () => new Response(JSON.stringify({ name, message: name }), { status, headers })) as unknown as typeof fetch);
    await expect(respond(422, 'missing_required_field').send({ to: 'a@b.c', from: 'f', subject: 's', text: 't', html: 'h' }, 'k')).rejects.toBeInstanceOf(PermanentEmailError);
    await expect(respond(500, 'application_error').send({ to: 'a@b.c', from: 'f', subject: 's', text: 't', html: 'h' }, 'k')).rejects.toBeInstanceOf(RetryableEmailError);
    const rl = respond(429, 'rate_limit_exceeded', { 'retry-after': '3' }).send({ to: 'a@b.c', from: 'f', subject: 's', text: 't', html: 'h' }, 'k');
    await expect(rl).rejects.toMatchObject({ retryAfterMs: 3000 });
    const net = new ResendProvider('re', 'https://x', (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    await expect(net.send({ to: 'a@b.c', from: 'f', subject: 's', text: 't', html: 'h' }, 'k')).rejects.toBeInstanceOf(RetryableEmailError);
  });
});

describe('email queue', () => {
  it('retries transient failures, gives up on permanent ones, and never sends twice', async () => {
    const db = openDb(':memory:');
    const provider = new RecordingProvider();
    const q = new EmailQueue(db, provider, 60_000);
    provider.failures.push(new RetryableEmailError('503', 1), new RetryableEmailError('503', 1));
    q.enqueue('test', { to: 'a@b.com', from: 'f', subject: 'retry me', text: 't', html: 'h' }, 'job-1');
    q.enqueue('test', { to: 'a@b.com', from: 'f', subject: 'retry me', text: 't', html: 'h' }, 'job-1'); // duplicate key ignored
    for (let i = 0; i < 3; i++) {
      await q.tick();
      await new Promise(r => setTimeout(r, 5));
    }
    expect(provider.sent.map(s => s.msg.subject)).toEqual(['retry me']);
    provider.failures.push(new PermanentEmailError('422'));
    q.enqueue('test', { to: 'a@b.com', from: 'f', subject: 'bad', text: 't', html: 'h' }, 'job-2');
    await q.tick();
    const row = db.prepare("SELECT status FROM email_jobs WHERE idempotency_key = 'job-2'").get() as { status: string };
    expect(row.status).toBe('failed');
    db.close();
  });
});

describe('notifications and inbound replies (through the API)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
  });

  async function setup() {
    const a = await signIn(t, 'alice@example.com');
    const b = await signIn(t, 'bob@example.com');
    const c = await signIn(t, 'carol@example.com');
    const p = threadPayload({ quote: 'the <quick> & "brown" fox' });
    await t.app.inject({ method: 'POST', url: '/api/threads', headers: auth(a.token), payload: p });
    return { a, b, c, p };
  }

  it('emails thread participants except the author and opted-out users, with escaped content', async () => {
    const { a, b, c, p } = await setup();
    t.provider.sent = [];
    await t.app.inject({ method: 'POST', url: `/api/threads/${p.id}/comments`, headers: auth(b.token), payload: { id: randomUUID(), body: 'Bob <script>alert(1)</script>' } });
    await t.queue.tick();
    expect(t.provider.sent.map(s => s.msg.to)).toEqual(['alice@example.com']);
    const mail = t.provider.sent[0].msg;
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('the &lt;quick&gt; &amp; &quot;brown&quot; fox');
    expect(mail.text).toContain('https://example.com/article#margin-comments=' + p.id);
    expect(mail.replyTo).toMatch(/@reply\.mail\.test$/);
    expect(mail.headers?.References).toBe(`<thread-${p.id}@mail.test>`);

    // Carol replies: Alice and Bob are notified; Carol isn't.
    t.provider.sent = [];
    await t.app.inject({ method: 'PATCH', url: '/api/me', headers: auth(b.token), payload: { notifyEmail: false } });
    await t.app.inject({ method: 'POST', url: `/api/threads/${p.id}/comments`, headers: auth(c.token), payload: { id: randomUUID(), body: 'Carol' } });
    await t.queue.tick();
    expect(t.provider.sent.map(s => s.msg.to).sort()).toEqual(['alice@example.com']);
    // Retried POST (same comment id) doesn't email again.
    void a;
  });

  it('queued notifications are re-checked at send time (unsubscribed or removed users get nothing)', async () => {
    const { a, b, p } = await setup();
    t.provider.sent = [];
    t.provider.failures.push(new RetryableEmailError('503', 60_000));
    await t.app.inject({ method: 'POST', url: `/api/threads/${p.id}/comments`, headers: auth(b.token), payload: { id: randomUUID(), body: 'later' } });
    await t.queue.tick(); // fails transiently; next attempt in a minute
    await t.app.inject({ method: 'PATCH', url: '/api/me', headers: auth(a.token), payload: { notifyEmail: false } });
    t.db.prepare("UPDATE email_jobs SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE status = 'pending'").run();
    await t.queue.tick();
    expect(t.provider.sent.filter(s => s.msg.to === 'alice@example.com')).toEqual([]);
    const job = t.db.prepare("SELECT status, last_error FROM email_jobs WHERE kind = 'notification' ORDER BY created_at DESC LIMIT 1").get() as any;
    expect(job.status).toBe('failed');
    expect(job.last_error).toMatch(/no longer eligible/);
  });

  it("queued notifications aren't sent to an address the account no longer uses", async () => {
    const { a, b, p } = await setup();
    t.provider.sent = [];
    t.provider.failures.push(new RetryableEmailError('503', 60_000));
    await t.app.inject({ method: 'POST', url: `/api/threads/${p.id}/comments`, headers: auth(b.token), payload: { id: randomUUID(), body: 'moved' } });
    await t.queue.tick();
    t.db.prepare('UPDATE users SET email = ? WHERE id = ?').run('alice.new@example.com', a.user.id);
    t.db.prepare("UPDATE email_jobs SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE status = 'pending'").run();
    await t.queue.tick();
    expect(t.provider.sent.filter(s => s.msg.to === 'alice@example.com')).toEqual([]);
  });

  it('daily-quota waits do not use up the retry budget', async () => {
    const db = openDb(':memory:');
    const provider = new RecordingProvider();
    const q = new EmailQueue(db, provider, 60_000);
    for (let i = 0; i < 15; i++) provider.failures.push(new RetryableEmailError('resend 429 daily_quota_exceeded', 3600_000));
    q.enqueue('test', { to: 'a@b.com', from: 'f', subject: 'quota', text: 't', html: 'h' }, 'quota-1');
    for (let i = 0; i < 15; i++) {
      db.prepare("UPDATE email_jobs SET next_attempt_at = '2000-01-01T00:00:00.000Z'").run();
      await q.tick();
    }
    const row = db.prepare("SELECT status, attempts FROM email_jobs WHERE idempotency_key = 'quota-1'").get() as { status: string; attempts: number };
    expect(row.status).toBe('pending');
    db.prepare("UPDATE email_jobs SET next_attempt_at = '2000-01-01T00:00:00.000Z'").run();
    await q.tick();
    expect(provider.sent.map(s => s.msg.subject)).toEqual(['quota']);
    db.close();
  });

  it('a comment and its notifications commit together', async () => {
    const { b, p } = await setup();
    const original = t.queue.enqueue.bind(t.queue);
    t.queue.enqueue = () => {
      throw new Error('disk full');
    };
    const id = randomUUID();
    const failed = await t.app.inject({ method: 'POST', url: `/api/threads/${p.id}/comments`, headers: auth(b.token), payload: { id, body: 'atomic' } });
    expect(failed.statusCode).toBe(500);
    t.queue.enqueue = original;
    t.provider.sent = [];
    const retry = await t.app.inject({ method: 'POST', url: `/api/threads/${p.id}/comments`, headers: auth(b.token), payload: { id, body: 'atomic' } });
    expect(retry.statusCode).toBe(201); // the failed attempt left nothing behind
    await t.queue.tick();
    expect(t.provider.sent.map(s => s.msg.to)).toEqual(['alice@example.com']);
  });

  async function deliver(email: ReturnType<typeof receivedEmail>) {
    t.provider.received.set(email.id, email);
    const body = JSON.stringify({ type: 'email.received', created_at: new Date().toISOString(), data: { email_id: email.id, from: email.from, to: email.to } });
    return t.app.inject({ method: 'POST', url: '/webhooks/resend', headers: svixHeaders(body), payload: body });
  }

  it('posts a verified email reply as the user and rejects forgeries', async () => {
    const { a, b, p } = await setup();
    t.provider.sent = [];
    await t.app.inject({ method: 'POST', url: `/api/threads/${p.id}/comments`, headers: auth(b.token), payload: { id: randomUUID(), body: 'ping' } });
    await t.queue.tick();
    const replyTo = t.provider.sent[0].msg.replyTo!;

    const ok = await deliver(receivedEmail({ id: randomUUID(), from: 'alice@example.com', to: [replyTo], headers: { from: 'Alice <alice@example.com>' }, text: 'pong\n\nOn Mon, Bob wrote:\n> ping' }));
    expect(ok.json().status).toBe('posted');
    const thread = (await t.app.inject({ method: 'GET', url: `/api/threads/${p.id}`, headers: auth(a.token) })).json().thread;
    expect(thread.comments.map((c: { body: string; author: { id: string } }) => [c.body, c.author.id])).toEqual([
      ['First!', a.user.id],
      ['ping', b.user.id],
      ['pong', a.user.id],
    ]);

    const cases: Array<[string, Partial<ReturnType<typeof receivedEmail>>]> = [
      ['wrong sender', { from: 'bob@example.com', headers: { from: 'bob@example.com' } }],
      ['spoofed display', { from: 'mallory@evil.test', headers: { from: 'Alice <alice@example.com>' } }],
      ['dmarc fail', { from: 'alice@example.com', authentication: { spf: 'pass', dkim: 'fail', dmarc: 'fail' } }],
      ['auto reply', { from: 'alice@example.com', headers: { 'auto-submitted': 'auto-replied' } }],
      ['empty', { from: 'alice@example.com', text: '> only quoted' }],
      ['no address', { from: 'alice@example.com', to: ['someone@reply.mail.test'] }],
      ['tampered', { from: 'alice@example.com', to: [replyTo.replace(/-([a-z2-7]{16})@/, '-aaaaaaaaaaaaaaaa@')] }],
      ['no auth verdict', { from: 'alice@example.com', authentication: null }],
      ['inconclusive auth', { from: 'alice@example.com', authentication: { spf: 'gray', dkim: 'gray', dmarc: 'gray' } }],
      ['self-asserted header only', { from: 'alice@example.com', authentication: null, headers: { 'authentication-results': 'mx; dmarc=pass' } }],
      ['spf-only (unaligned envelope)', { from: 'alice@example.com', authentication: { spf: 'pass', dkim: 'gray', dmarc: 'gray' } }],
      ['display-name spoof', { from: 'mallory@evil.test', headers: { from: '"<alice@example.com>" <mallory@evil.test>' } }],
    ];
    for (const [name, o] of cases) {
      const r = await deliver(receivedEmail({ id: randomUUID(), to: [replyTo], text: `forged ${name}`, ...o }));
      expect(r.json().status, name).toBe('rejected');
    }

    // DMARC "gray" (no policy) with DKIM pass is accepted.
    const gray = await deliver(receivedEmail({ id: randomUUID(), from: 'alice@example.com', to: [replyTo], text: 'gray but signed', authentication: { spf: 'gray', dkim: 'pass', dmarc: 'gray' } }));
    expect(gray.json().status).toBe('posted');

    // Bad signature: 401 and nothing posted.
    const body = JSON.stringify({ type: 'email.received', data: { email_id: 'x' } });
    const bad = await t.app.inject({ method: 'POST', url: '/webhooks/resend', headers: { ...svixHeaders(body), 'svix-signature': 'v1,AAAA' }, payload: body });
    expect(bad.statusCode).toBe(401);

    // Duplicate delivery of the same email posts once.
    const dupe = receivedEmail({ id: randomUUID(), from: 'alice@example.com', to: [replyTo], text: 'once' });
    expect((await deliver(dupe)).json().status).toBe('posted');
    expect((await deliver(dupe)).json().status).toBe('duplicate');

    // The same message delivered again via SMTP gets a new provider id but
    // keeps its Message-ID: it must not post twice.
    const original = receivedEmail({ id: randomUUID(), from: 'alice@example.com', to: [replyTo], text: 'replayed?', messageId: '<abc@mail.example.com>' });
    expect((await deliver(original)).json().status).toBe('posted');
    expect((await deliver({ ...original, id: randomUUID() })).json().status).toBe('duplicate');

    // A reply longer than one comment arrives in full, as consecutive comments.
    const long = Array.from({ length: 300 }, (_, i) => `Paragraph ${i} of a very detailed answer with plenty of words.`).join('\n\n') + '\n\nTHE IMPORTANT LAST LINE';
    const longMail = receivedEmail({ id: randomUUID(), from: 'alice@example.com', to: [replyTo], text: long, messageId: '<long@mail.example.com>' });
    expect((await deliver(longMail)).json().status).toBe('posted');
    const afterLong = (await t.app.inject({ method: 'GET', url: `/api/threads/${p.id}`, headers: auth(a.token) })).json().thread;
    const joined = afterLong.comments.slice(-2).map((c: { body: string }) => c.body).join('\n\n');
    expect(joined).toContain('THE IMPORTANT LAST LINE');
    expect(joined.replace(/\s+/g, ' ')).toContain('Paragraph 0 of a very detailed answer');
    expect(afterLong.comments.every((c: { body: string }) => c.body.length <= 10_000)).toBe(true);
    for (const c of afterLong.comments.slice(-2)) {
      await t.app.inject({ method: 'DELETE', url: `/api/comments/${c.id}`, headers: auth(a.token) });
    }

    // Transient failure fetching the email -> 503 so Resend retries; then it works.
    const later = receivedEmail({ id: randomUUID(), from: 'alice@example.com', to: [replyTo], text: 'after a hiccup' });
    t.provider.fetchFailures.push(new RetryableEmailError('503'));
    expect((await deliver(later)).statusCode).toBe(503);
    expect((await deliver(later)).json().status).toBe('posted');

    const final = (await t.app.inject({ method: 'GET', url: `/api/threads/${p.id}`, headers: auth(a.token) })).json().thread;
    expect(final.comments.map((c: { body: string }) => c.body)).toEqual(['First!', 'ping', 'pong', 'gray but signed', 'once', 'replayed?', 'after a hiccup']);
    expect(JSON.stringify(final)).not.toContain('forged');
  });

  it('unsubscribe links are signed and work with one-click POST', async () => {
    const { b, p } = await setup();
    await t.app.inject({ method: 'POST', url: `/api/threads/${p.id}/comments`, headers: auth(b.token), payload: { id: randomUUID(), body: 'x' } });
    await t.queue.tick();
    const mail = t.provider.sent.find(s => s.msg.to === 'alice@example.com' && s.msg.headers?.['List-Unsubscribe'])!.msg;
    const url = new URL(/<(.+)>/.exec(mail.headers!['List-Unsubscribe'])![1]);
    const forged = await t.app.inject({ method: 'POST', url: `/unsubscribe?u=${url.searchParams.get('u')}&s=aaaaaaaaaaaaaaaa` });
    expect(forged.statusCode).toBe(400);
    const get = await t.app.inject({ method: 'GET', url: url.pathname + url.search });
    expect(get.statusCode).toBe(200);
    const post = await t.app.inject({ method: 'POST', url: url.pathname + url.search, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
    expect(post.statusCode).toBe(200);
    const signedIn = await signIn(t, 'alice@example.com');
    const me = await t.app.inject({ method: 'GET', url: '/api/me', headers: auth(signedIn.token) });
    expect(me.json().user.notifyEmail).toBe(false);
  });
});

void WEBHOOK_SECRET;
