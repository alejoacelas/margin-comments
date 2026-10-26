import { randomUUID } from 'node:crypto';
import { buildApp } from '../../src/server/app';
import { type Config, loadConfig } from '../../src/server/config';
import { type EmailProvider, type OutgoingEmail, PermanentEmailError, type ReceivedEmail, RetryableEmailError } from '../../src/server/email/provider';
import { signSvix } from '../../src/server/email/inbound';

export const WEBHOOK_SECRET = 'whsec_' + Buffer.from('unit-test-webhook-secret-123456').toString('base64');

/** An email provider that records what it sends and serves canned inbound mail. */
export class RecordingProvider implements EmailProvider {
  readonly name = 'resend' as const;
  sent: Array<{ msg: OutgoingEmail; key: string; id: string }> = [];
  received = new Map<string, ReceivedEmail>();
  failures: Array<Error> = [];
  fetchFailures: Array<Error> = [];

  async send(msg: OutgoingEmail, key: string) {
    const f = this.failures.shift();
    if (f) throw f;
    const existing = this.sent.find(s => s.key === key);
    if (existing) return { id: existing.id };
    const id = randomUUID();
    this.sent.push({ msg, key, id });
    return { id };
  }

  async getReceived(id: string) {
    const f = this.fetchFailures.shift();
    if (f) throw f;
    const e = this.received.get(id);
    if (!e) throw new PermanentEmailError('resend 404 not_found');
    return e;
  }

  to(email: string) {
    return this.sent.filter(s => s.msg.to === email).map(s => s.msg);
  }
}

export { PermanentEmailError, RetryableEmailError };

export async function makeApp(overrides: Partial<Config> = {}, opts: { liveHeartbeatMs?: number } = {}) {
  const base = loadConfig();
  const config: Config = {
    ...base,
    databasePath: ':memory:',
    publicUrl: 'https://mc.test',
    appSecret: 'unit-test-secret',
    adminToken: 'admin-pass',
    extensionIds: ['abcdefghijklmnopabcdefghijklmnop'],
    trustProxy: false,
    email: {
      ...base.email,
      resendApiKey: 're_test',
      domain: 'mail.test',
      replyDomain: 'reply.mail.test',
      from: 'Margin Comments <notifications@mail.test>',
      resendWebhookSecret: WEBHOOK_SECRET,
      workerIntervalMs: 60_000,
    },
    ...overrides,
  };
  const provider = new RecordingProvider();
  const built = await buildApp({ config, provider, liveHeartbeatMs: opts.liveHeartbeatMs });
  return { ...built, provider, config };
}

export type TestApp = Awaited<ReturnType<typeof makeApp>>;

/** Sign in through the email-code flow; returns the bearer token and user. */
export async function signIn(t: TestApp, email: string) {
  const start = await t.app.inject({ method: 'POST', url: '/api/auth/email/start', payload: { email } });
  if (start.statusCode !== 200) throw new Error(`start failed: ${start.body}`);
  const { requestId } = start.json();
  await t.queue.tick();
  const mail = t.provider.to(email.toLowerCase()).at(-1)!;
  const code = /(\d{6})/.exec(mail.subject)![1];
  const res = await t.app.inject({ method: 'POST', url: '/api/auth/email/verify', payload: { requestId, code } });
  if (res.statusCode !== 200) throw new Error(`verify failed: ${res.body}`);
  const body = res.json();
  return { token: body.token as string, user: body.user as { id: string; email: string; name: string } };
}

export function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

export function threadPayload(overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  return {
    id,
    pageKeys: ['example.com/article'],
    url: 'https://example.com/article?utm_source=x',
    title: 'An Article',
    quote: 'the quick brown fox',
    selectors: [
      { type: 'TextQuoteSelector', exact: 'the quick brown fox', prefix: 'once upon a time ', suffix: ' jumped over' },
      { type: 'TextPositionSelector', start: 10, end: 29 },
    ],
    comment: { id: randomUUID(), body: 'First!' },
    ...overrides,
  };
}

export function svixHeaders(body: string, secret = WEBHOOK_SECRET, ts = Math.floor(Date.now() / 1000)) {
  const id = `msg_${randomUUID()}`;
  return { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${signSvix(secret, id, ts, body)}` };
}

export function receivedEmail(overrides: Partial<ReceivedEmail> & { id: string }): ReceivedEmail {
  return {
    from: '',
    to: [],
    cc: [],
    receivedFor: [],
    subject: 'Re: hello',
    text: null,
    html: null,
    headers: {},
    authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    ...overrides,
  };
}
