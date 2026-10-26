import type { Me, PublicUser } from '../shared/types';
import { LIMITS } from '../shared/types';
import { hmac, newCode, newToken, newUserId, safeEqual, sha256 } from './crypto';
import { type DB, nowIso, tx } from './db';

export type UserRow = {
  id: string;
  email: string;
  name: string;
  notify_email: number;
  google_sub: string | null;
  created_at: string;
};

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length > LIMITS.email || !EMAIL_RE.test(email)) return null;
  return email;
}

export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Strip control characters and collapse whitespace.
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  return name.slice(0, LIMITS.name);
}

export function defaultName(email: string): string {
  const local = email.split('@')[0].split('+')[0];
  const words = local.split(/[._-]+/).filter(Boolean);
  const name = words.map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  return cleanName(name) ?? 'Someone';
}

export function publicUser(u: Pick<UserRow, 'id' | 'name'>): PublicUser {
  return { id: u.id, name: u.name };
}

export function meOf(u: UserRow): Me {
  return { id: u.id, name: u.name, email: u.email, notifyEmail: !!u.notify_email };
}

export function getUser(db: DB, id: string): UserRow | null {
  return (db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined) ?? null;
}

export function getUserByEmail(db: DB, email: string): UserRow | null {
  return (db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined) ?? null;
}

export function upsertUser(db: DB, email: string, opts: { name?: string | null; googleSub?: string | null } = {}): UserRow {
  return tx(db, () => {
    if (opts.googleSub) {
      // A Google identity is its stable subject; the email can change.
      const bySub = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(opts.googleSub) as UserRow | undefined;
      if (bySub) {
        if (bySub.email !== email) {
          const taken = getUserByEmail(db, email);
          if (!taken) {
            db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, bySub.id);
          } else {
            // The (verified) new address already has its own account: use
            // that one, and move the Google identity to it.
            db.prepare('UPDATE users SET google_sub = NULL WHERE id = ?').run(bySub.id);
            db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(opts.googleSub, taken.id);
            return getUser(db, taken.id)!;
          }
        }
        return getUser(db, bySub.id)!;
      }
    }
    const existing = getUserByEmail(db, email);
    if (existing) {
      if (opts.googleSub && existing.google_sub !== opts.googleSub) {
        db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(opts.googleSub, existing.id);
      }
      return getUser(db, existing.id)!;
    }
    const id = newUserId();
    const name = cleanName(opts.name) ?? defaultName(email);
    db.prepare(
      'INSERT INTO users (id, email, name, notify_email, google_sub, created_at) VALUES (?, ?, ?, 1, ?, ?)',
    ).run(id, email, name, opts.googleSub ?? null, nowIso());
    return getUser(db, id)!;
  });
}

export function updateUser(db: DB, id: string, patch: { name?: string; notifyEmail?: boolean }): UserRow {
  if (patch.name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(patch.name, id);
  if (patch.notifyEmail !== undefined)
    db.prepare('UPDATE users SET notify_email = ? WHERE id = ?').run(patch.notifyEmail ? 1 : 0, id);
  return getUser(db, id)!;
}

// ---------------------------------------------------------------------------
// Sessions: random bearer tokens, stored hashed.
// ---------------------------------------------------------------------------

export function createSession(db: DB, userId: string, days: number): string {
  const token = newToken();
  const now = new Date();
  const expires = new Date(now.getTime() + days * 86400_000);
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    sha256(token),
    userId,
    now.toISOString(),
    now.toISOString(),
    expires.toISOString(),
  );
  return token;
}

export function userForToken(db: DB, token: string | undefined | null, days: number): UserRow | null {
  if (!token || token.length > 200) return null;
  const hash = sha256(token);
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hash) as
    | { user_id: string; last_used_at: string; expires_at: string }
    | undefined;
  if (!row) return null;
  const now = Date.now();
  if (Date.parse(row.expires_at) < now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  // Sliding expiry, written at most hourly.
  if (now - Date.parse(row.last_used_at) > 3600_000) {
    db.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?').run(
      new Date(now).toISOString(),
      new Date(now + days * 86400_000).toISOString(),
      hash,
    );
  }
  return getUser(db, row.user_id);
}

export function deleteSession(db: DB, token: string) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

// ---------------------------------------------------------------------------
// Email sign-in: one request = a 6-digit code + a link token, both one-time.
// ---------------------------------------------------------------------------

const LOGIN_TTL_MS = 20 * 60_000;
const MAX_CODE_ATTEMPTS = 5;

export type LoginStart = { requestId: string; code: string; linkToken: string };

export function startEmailLogin(db: DB, secret: string, email: string): LoginStart {
  const requestId = newToken(16);
  const code = newCode();
  const linkToken = newToken();
  const now = Date.now();
  db.prepare(
    'INSERT INTO login_requests (id, email, code_hash, link_hash, attempts, created_at, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
  ).run(
    requestId,
    email,
    codeHash(secret, requestId, code),
    sha256(linkToken),
    new Date(now).toISOString(),
    new Date(now + LOGIN_TTL_MS).toISOString(),
  );
  return { requestId, code, linkToken };
}

/** Number of sign-in emails requested for an address in the last `ms`. */
export function recentLoginCount(db: DB, email: string, ms: number): number {
  const since = new Date(Date.now() - ms).toISOString();
  const row = db.prepare('SELECT COUNT(*) AS n FROM login_requests WHERE email = ? AND created_at > ?').get(email, since) as {
    n: number;
  };
  return row.n;
}

function codeHash(secret: string, requestId: string, code: string): string {
  return hmac(secret, `login-code:${requestId}:${code}`).toString('hex');
}

type LoginRow = {
  id: string;
  email: string;
  code_hash: string;
  attempts: number;
  expires_at: string;
  consumed_at: string | null;
};

export type VerifyResult = { ok: true; email: string } | { ok: false; error: 'invalid' | 'expired' | 'too_many_attempts' };

export function verifyEmailCode(db: DB, secret: string, requestId: string, code: string): VerifyResult {
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM login_requests WHERE id = ?').get(requestId) as LoginRow | undefined;
    if (!row || row.consumed_at) return { ok: false, error: 'invalid' } as const;
    if (Date.parse(row.expires_at) < Date.now()) return { ok: false, error: 'expired' } as const;
    if (row.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, error: 'too_many_attempts' } as const;
    db.prepare('UPDATE login_requests SET attempts = attempts + 1 WHERE id = ?').run(requestId);
    const cleaned = code.replace(/\D/g, '');
    if (!safeEqual(codeHash(secret, requestId, cleaned), row.code_hash)) {
      return { ok: false, error: row.attempts + 1 >= MAX_CODE_ATTEMPTS ? 'too_many_attempts' : 'invalid' } as const;
    }
    db.prepare('UPDATE login_requests SET consumed_at = ? WHERE id = ?').run(nowIso(), requestId);
    return { ok: true, email: row.email } as const;
  });
}

export function verifyEmailLink(db: DB, token: string): VerifyResult {
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM login_requests WHERE link_hash = ?').get(sha256(token)) as LoginRow | undefined;
    if (!row || row.consumed_at) return { ok: false, error: 'invalid' } as const;
    if (Date.parse(row.expires_at) < Date.now()) return { ok: false, error: 'expired' } as const;
    db.prepare('UPDATE login_requests SET consumed_at = ? WHERE id = ?').run(nowIso(), row.id);
    return { ok: true, email: row.email } as const;
  });
}

/** Housekeeping: drop expired sign-in requests, OAuth states and sessions. */
export function purgeExpired(db: DB) {
  const now = nowIso();
  const dayAgo = new Date(Date.now() - 86400_000).toISOString();
  db.prepare('DELETE FROM login_requests WHERE expires_at < ?').run(dayAgo);
  db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
}
