import { createHmac } from 'node:crypto';
import { LIMITS } from '../../shared/types';
import { safeEqual, uuidFrom } from '../crypto';
import { type DB, nowIso } from '../db';
import type { ReceivedEmail } from './provider';
import { extractReply } from './reply-parse';
import { bareAddress, parseReplyAddress, type ReplyTarget } from './reply-token';

// ---------------------------------------------------------------------------
// Svix webhook signatures (Resend webhooks are delivered by Svix).
// signed content = `${svix-id}.${svix-timestamp}.${raw body}`
// key = base64-decode(secret without "whsec_"); signature = base64(HMAC-SHA256)
// header "svix-signature" = space-separated "v1,<sig>" entries
// ---------------------------------------------------------------------------

const TOLERANCE_S = 300;

export function signSvix(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}

export function verifySvix(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  nowS = Math.floor(Date.now() / 1000),
): boolean {
  const h = (name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const id = h('svix-id') ?? h('webhook-id');
  const ts = h('svix-timestamp') ?? h('webhook-timestamp');
  const sigHeader = h('svix-signature') ?? h('webhook-signature');
  if (!secret || !id || !ts || !sigHeader) return false;
  const timestamp = Number(ts);
  if (!Number.isInteger(timestamp) || Math.abs(nowS - timestamp) > TOLERANCE_S) return false;
  const expected = signSvix(secret, id, timestamp, rawBody);
  for (const part of sigHeader.split(' ')) {
    const [version, sig] = part.split(',', 2);
    if (version === 'v1' && sig && safeEqual(sig, expected)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Turning a received email into a comment.
// ---------------------------------------------------------------------------

export type InboundOutcome =
  | { status: 'posted'; threadId: string; commentId: string; userId: string; body: string }
  | { status: 'duplicate' }
  | { status: 'rejected'; reason: string };

export type InboundDeps = {
  db: DB;
  secret: string;
  replyDomain: string;
  getUser: (id: string) => { id: string; email: string } | null;
  /** Post a comment as `userId`; throws on failure. */
  postComment: (userId: string, threadId: string, commentId: string, body: string) => void;
};

/** Find our signed reply address among the recipients (to, cc, envelope). */
export function findReplyTarget(secret: string, domain: string, email: ReceivedEmail): ReplyTarget | null {
  for (const addr of [...email.to, ...email.cc, ...email.receivedFor]) {
    const target = parseReplyAddress(secret, domain, addr);
    if (target) return target;
  }
  return null;
}

/** True when the receiving server saw the sender fail authentication. */
function failedAuthentication(email: ReceivedEmail): boolean {
  const a = email.authentication;
  if (!a) return false;
  if (a.dmarc === 'fail') return true;
  return a.spf === 'fail' && a.dkim === 'fail';
}

export function processInbound(deps: InboundDeps, email: ReceivedEmail): InboundOutcome {
  const { db } = deps;
  const seen = db.prepare('SELECT status FROM inbound_emails WHERE id = ?').get(email.id) as { status: string } | undefined;
  if (seen) return { status: 'duplicate' };

  const outcome = decide(deps, email);
  db.prepare('INSERT OR IGNORE INTO inbound_emails (id, received_at, status, detail, comment_id) VALUES (?, ?, ?, ?, ?)').run(
    email.id,
    nowIso(),
    outcome.status,
    outcome.status === 'rejected' ? outcome.reason : null,
    outcome.status === 'posted' ? outcome.commentId : null,
  );
  return outcome;
}

function decide(deps: InboundDeps, email: ReceivedEmail): InboundOutcome {
  const target = findReplyTarget(deps.secret, deps.replyDomain, email);
  if (!target) return { status: 'rejected', reason: 'no valid reply address' };
  const user = deps.getUser(target.userId);
  if (!user) return { status: 'rejected', reason: 'unknown user' };

  // The sender must be the account the address was minted for.
  const from = bareAddress(email.headers['from'] || email.from);
  const envelopeFrom = bareAddress(email.from);
  if (from !== user.email.toLowerCase() || (envelopeFrom && envelopeFrom !== user.email.toLowerCase())) {
    return { status: 'rejected', reason: 'sender does not match account' };
  }
  if (failedAuthentication(email)) return { status: 'rejected', reason: 'sender failed SPF/DKIM/DMARC' };

  // Ignore auto-replies (vacation responders, bounces).
  const autoSubmitted = (email.headers['auto-submitted'] ?? '').toLowerCase();
  if ((autoSubmitted && autoSubmitted !== 'no') || /^(auto|bulk|junk|list)$/i.test(email.headers['precedence'] ?? '')) {
    return { status: 'rejected', reason: 'auto-reply' };
  }

  let body = extractReply(email.text, email.html);
  if (!body) return { status: 'rejected', reason: 'empty reply' };
  if (body.length > LIMITS.commentBody) body = `${body.slice(0, LIMITS.commentBody - 1)}…`;

  // Deterministic id: a redelivered webhook can never post twice.
  const commentId = uuidFrom('inbound-email', email.id);
  try {
    deps.postComment(user.id, target.threadId, commentId, body);
  } catch (err) {
    // Permanent API outcomes (thread deleted, no access) are recorded; anything
    // else propagates so the webhook answers 500 and Resend redelivers.
    if (typeof (err as { status?: unknown }).status === 'number') {
      return { status: 'rejected', reason: `could not post: ${(err as Error).message}` };
    }
    throw err;
  }
  return { status: 'posted', threadId: target.threadId, commentId, userId: user.id, body };
}
