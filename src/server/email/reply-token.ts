import { base32Encode, base32ToUuid, hmac, safeEqual, uuidToBase32 } from '../crypto';

/**
 * Per-user, per-thread reply addresses:
 *
 *   r-<thread id, base32>-<user id>-<signature>@<reply domain>
 *
 * The signature is HMAC-SHA256(APP_SECRET, "reply:v1:<thread>:<user>"),
 * truncated to 80 bits and base32-encoded. Only the server can mint a valid
 * address, and each address is only ever sent to that one user, so a reply to
 * it proves the sender received our notification. Lowercase base32 survives
 * mail systems that lowercase local parts; the local part stays under 64
 * characters (2 + 26 + 1 + 12 + 1 + 16 = 58).
 */

const SIG_CHARS = 16;

function signature(secret: string, threadId: string, userId: string): string {
  return base32Encode(hmac(secret, `reply:v1:${threadId}:${userId}`).subarray(0, 10)).slice(0, SIG_CHARS);
}

export function replyAddress(secret: string, domain: string, threadId: string, userId: string): string {
  return `r-${uuidToBase32(threadId)}-${userId}-${signature(secret, threadId, userId)}@${domain}`;
}

export type ReplyTarget = { threadId: string; userId: string };

/** Extract the bare address from `"Name" <addr@x>` or `addr@x`. */
export function bareAddress(raw: string): string {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(raw);
  return (m ? m[1] : raw).trim().replace(/^mailto:/i, '').toLowerCase();
}

/** Verify a reply address; returns null for anything not minted by us. */
export function parseReplyAddress(secret: string, domain: string, raw: string): ReplyTarget | null {
  const address = bareAddress(raw);
  const at = address.lastIndexOf('@');
  if (at < 0) return null;
  const local = address.slice(0, at);
  const host = address.slice(at + 1);
  if (!domain || host !== domain.toLowerCase()) return null;
  const m = /^r-([a-z2-7]{26})-([a-z2-7]{12})-([a-z2-7]{16})$/.exec(local);
  if (!m) return null;
  const threadId = base32ToUuid(m[1]);
  if (!threadId) return null;
  const userId = m[2];
  if (!safeEqual(signature(secret, threadId, userId), m[3])) return null;
  return { threadId, userId };
}
