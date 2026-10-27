import { createHmac } from 'node:crypto';
import { LIMITS, stripControlChars } from '../../shared/types';
import { safeEqual, uuidFrom } from '../crypto';
import { type DB, nowIso } from '../db';
import type { ReceivedEmail } from './provider';
import { extractReplyChecked } from './reply-parse';
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
  | {
      status: 'rejected';
      reason: string;
      /** A verified sender's reply that couldn't be posted: tell them, with their text. */
      returnToSender?: { to: string; threadId: string; reason: string; text: string };
    };

export type InboundDeps = {
  db: DB;
  secret: string;
  replyDomain: string;
  getUser: (id: string) => { id: string; email: string } | null;
  /** Room left in the thread after adding comments with these ids (already-posted ids take none); negative: they don't fit. */
  commentRoom?: (threadId: string, ids: string[]) => number;
  /** Reject replies whose sender authentication is missing or inconclusive. */
  requireSenderAuth: boolean;
  /** Post a comment as `userId`; false if it already existed. Throws on failure. */
  postComment: (userId: string, threadId: string, commentId: string, body: string) => boolean;
};

/** Find our signed reply address among the recipients (to, cc, envelope). */
export function findReplyTarget(secret: string, domain: string, email: ReceivedEmail): ReplyTarget | null {
  for (const addr of [...email.to, ...email.cc, ...email.receivedFor]) {
    const target = parseReplyAddress(secret, domain, addr);
    if (target) return target;
  }
  return null;
}

/**
 * Sender authentication as judged by the receiving server (Resend's
 * `authentication` field; the message's own Authentication-Results header is
 * sender-controlled and ignored). Accepted:
 *  - DMARC pass (aligned with From by definition), or
 *  - DKIM pass, which Resend only reports when the signing domain matches
 *    the From domain ("gray" otherwise) — this covers domains with p=none
 *    (e.g. gmail.com), whose DMARC result is reported as "gray".
 * SPF alone is not enough: it authenticates the envelope sender, which an
 * attacker can set to their own domain while forging From.
 */
export function senderVerdict(email: ReceivedEmail): 'pass' | 'fail' | 'unknown' {
  const a = email.authentication;
  if (!a) return 'unknown';
  if (a.dmarc === 'fail') return 'fail';
  if (a.dmarc === 'pass') return 'pass';
  if (a.dkim === 'pass') return 'pass';
  if (a.spf === 'fail' && a.dkim === 'fail') return 'fail';
  return 'unknown';
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

  // The sender must be the account the address was minted for: exactly one
  // From mailbox, matching both the header and Resend's parsed sender.
  const account = user.email.toLowerCase();
  const fromHeader = email.headers['from'] ?? email.from;
  const from = bareAddress(fromHeader);
  const parsedFrom = bareAddress(email.from);
  if (!from || from !== account || (email.from && parsedFrom !== account)) {
    return { status: 'rejected', reason: 'sender does not match account' };
  }
  const verdict = senderVerdict(email);
  if (verdict === 'fail') return { status: 'rejected', reason: 'sender failed SPF/DKIM/DMARC' };
  if (verdict === 'unknown' && deps.requireSenderAuth) return { status: 'rejected', reason: 'sender not authenticated' };

  // Ignore auto-replies (vacation responders, bounces).
  const autoSubmitted = (email.headers['auto-submitted'] ?? '').toLowerCase();
  if ((autoSubmitted && autoSubmitted !== 'no') || /^(auto|bulk|junk|list)$/i.test(email.headers['precedence'] ?? '')) {
    return { status: 'rejected', reason: 'auto-reply' };
  }

  const extracted = extractReplyChecked(email.text, email.html);
  const body = stripControlChars(extracted.text);
  // Never post part of a reply: too long to read in full is refused, and a
  // verified sender is told (with the beginning of their text).
  if (extracted.truncated) {
    return {
      status: 'rejected',
      reason: 'email too long',
      returnToSender:
        verdict === 'pass'
          ? {
              to: user.email,
              threadId: target.threadId,
              reason: body
                ? 'The email was too long to post (more than 2 MB of text).'
                : 'The email was too long to read (an HTML-only email over 200 KB). Sending it as plain text works better.',
              text: body.slice(0, 100_000),
            }
          : undefined,
    };
  }
  if (!body) return { status: 'rejected', reason: 'empty reply' };

  // Deterministic ids: a redelivered webhook, or the same message delivered
  // again (same Message-ID from the same account), can never post twice.
  const messageId = (email.messageId ?? '').trim().toLowerCase();
  const baseId = messageId ? `${user.id}:${messageId}` : `email:${email.id}`;
  // A reply longer than one comment is posted as consecutive comments, so
  // nothing the sender wrote is dropped.
  const parts = splitLongText(body, LIMITS.commentBody);
  const commentId = uuidFrom('inbound-message', baseId);
  const ids = parts.map((_, i) => (i === 0 ? commentId : uuidFrom('inbound-message', `${baseId}#${i}`)));
  const returnToSender = (reason: string) =>
    verdict === 'pass' ? { to: user.email, threadId: target.threadId, reason, text: body } : undefined;
  // All of a reply or none of it: never a silently cut-off tail.
  if (deps.commentRoom && deps.commentRoom(target.threadId, ids) < 0) {
    return { status: 'rejected', reason: 'thread is full', returnToSender: returnToSender('The thread is full (it has the maximum number of comments).') };
  }
  try {
    let created = false;
    parts.forEach((part, i) => {
      if (deps.postComment(user.id, target.threadId, ids[i], part)) created = true;
    });
    if (!created) return { status: 'duplicate' };
  } catch (err) {
    // Permanent API outcomes (thread deleted, no access) are recorded; anything
    // else propagates so the webhook answers 500 and Resend redelivers.
    if (typeof (err as { status?: unknown }).status === 'number') {
      return {
        status: 'rejected',
        reason: `could not post: ${(err as Error).message}`,
        returnToSender: returnToSender((err as Error).message || 'The thread is no longer available.'),
      };
    }
    throw err;
  }
  return { status: 'posted', threadId: target.threadId, commentId, userId: user.id, body };
}

/** Split text into chunks of at most `max` characters, preferring paragraph, line and word breaks. */
export function splitLongText(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut < max * 0.5) cut = window.lastIndexOf('\n');
    if (cut < max * 0.5) cut = window.lastIndexOf(' ');
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
