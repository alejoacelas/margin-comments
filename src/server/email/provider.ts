import { randomUUID } from 'node:crypto';
import { type DB, nowIso } from '../db';

export type OutgoingEmail = {
  /** Who/what a notification is about, so eligibility is rechecked at send time. Not sent. */
  meta?: { userId: string; threadId: string };
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
};

/** A received email, as fetched from the provider. Header keys are lowercase. */
export type ReceivedEmail = {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  receivedFor: string[];
  subject: string;
  text: string | null;
  html: string | null;
  headers: Record<string, string>;
  authentication: { spf?: string; dkim?: string; dmarc?: string } | null;
  /** RFC 5322 Message-ID of the received message, if known. */
  messageId?: string;
};

/** Sending failed and retrying the same request will not help. */
export class PermanentEmailError extends Error {}

/** Sending failed transiently; retry later (optionally after `retryAfterMs`). */
export class RetryableEmailError extends Error {
  constructor(
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

export interface EmailProvider {
  readonly name: 'resend' | 'outbox';
  send(msg: OutgoingEmail, idempotencyKey: string): Promise<{ id: string }>;
  /** Fetch a received email's content (inbound replies). */
  getReceived?(emailId: string): Promise<ReceivedEmail>;
}

const USER_AGENT = 'margin-comments/1.0';

/**
 * Resend (https://resend.com/docs/api-reference). Sending uses POST /emails
 * with an Idempotency-Key; inbound content comes from
 * GET /emails/receiving/{id} (needs a full-access key).
 */
export class ResendProvider implements EmailProvider {
  readonly name = 'resend' as const;

  constructor(
    private apiKey: string,
    private base = 'https://api.resend.com',
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new RetryableEmailError(`network: ${(err as Error).message}`);
    }
    let text: string;
    try {
      text = await readCapped(res, MAX_RESPONSE_BYTES);
    } catch (err) {
      if (err instanceof PermanentEmailError) throw err;
      // The connection dropped (or timed out) after the headers: try again.
      throw new RetryableEmailError(`network (body): ${(err as Error).message}`);
    }
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON error page
    }
    if (res.ok) return json;
    const name = json?.name ?? 'unknown';
    const message = `resend ${res.status} ${name}: ${json?.message ?? text.slice(0, 200)}`;
    if (res.status === 429) {
      // Quota errors won't clear for hours; rate limits clear in seconds.
      const retryAfter = Number(res.headers.get('retry-after'));
      const quota = name === 'daily_quota_exceeded' || name === 'monthly_quota_exceeded';
      throw new RetryableEmailError(message, quota ? 3600_000 : Number.isFinite(retryAfter) ? retryAfter * 1000 : 2000);
    }
    if (res.status === 409 && name === 'concurrent_idempotent_requests') throw new RetryableEmailError(message, 2000);
    if (res.status >= 500) throw new RetryableEmailError(message);
    throw new PermanentEmailError(message);
  }

  async send(msg: OutgoingEmail, idempotencyKey: string): Promise<{ id: string }> {
    const json = await this.request(
      'POST',
      '/emails',
      {
        from: msg.from,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
        ...(msg.headers && Object.keys(msg.headers).length ? { headers: msg.headers } : {}),
      },
      { 'Idempotency-Key': idempotencyKey.slice(0, 256) },
    );
    if (!json || typeof json.id !== 'string') throw new RetryableEmailError('resend: response without id');
    return { id: json.id };
  }

  async getReceived(emailId: string): Promise<ReceivedEmail> {
    const j = await this.request('GET', `/emails/receiving/${encodeURIComponent(emailId)}`);
    return parseReceived(j, emailId);
  }
}

function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') return [v];
  return [];
}

/** Parse Resend's received-email JSON defensively (fields may be null/missing). */
export function parseReceived(j: any, fallbackId: string): ReceivedEmail {
  const headers: Record<string, string> = {};
  if (j?.headers && typeof j.headers === 'object') {
    for (const [k, v] of Object.entries(j.headers)) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v;
      else if (Array.isArray(v)) headers[k.toLowerCase()] = v.filter(x => typeof x === 'string').join(', ');
    }
  }
  const auth = j?.authentication && typeof j.authentication === 'object' ? j.authentication : null;
  return {
    id: typeof j?.id === 'string' ? j.id : fallbackId,
    from: typeof j?.from === 'string' ? j.from : '',
    to: strList(j?.to),
    cc: strList(j?.cc),
    receivedFor: strList(j?.received_for),
    subject: typeof j?.subject === 'string' ? j.subject : '',
    text: typeof j?.text === 'string' ? j.text : null,
    html: typeof j?.html === 'string' ? j.html : null,
    headers,
    messageId: typeof j?.message_id === 'string' ? j.message_id : headers['message-id'],
    authentication: auth
      ? {
          spf: typeof auth.spf === 'string' ? auth.spf : undefined,
          dkim: typeof auth.dkim === 'string' ? auth.dkim : undefined,
          dmarc: typeof auth.dmarc === 'string' ? auth.dmarc : undefined,
        }
      : null,
  };
}

/**
 * Used until real email is configured: messages are stored in the database
 * and shown at /admin/outbox (password-protected) instead of being sent.
 */
export class OutboxProvider implements EmailProvider {
  readonly name = 'outbox' as const;

  constructor(private db: DB) {}

  async send(msg: OutgoingEmail): Promise<{ id: string }> {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO outbox_emails (id, to_email, from_email, reply_to, subject, text, html, headers, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, msg.to, msg.from, msg.replyTo ?? null, msg.subject, msg.text, msg.html, JSON.stringify(msg.headers ?? {}), nowIso());
    return { id };
  }
}

/** Responses (a received email with its body) above this are refused, not buffered. */
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

/** Read a response body, stopping (and cancelling) once it exceeds `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new PermanentEmailError(`response too large (${declared} bytes)`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new PermanentEmailError(`response too large (over ${max} bytes)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

