import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PUBLIC_GROUP_ID } from '../shared/types';

export type DB = DatabaseSync;

/**
 * Schema migrations, applied in order. Never edit a shipped migration; add a
 * new one. `user_version` records how many have been applied.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    notify_email INTEGER NOT NULL DEFAULT 1,
    google_sub TEXT UNIQUE,
    created_at TEXT NOT NULL
  );

  -- Groups: v1 has a single shared space ('public'). Private groups later add
  -- rows here plus memberships; threads already carry a group_id.
  CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE group_members (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE login_requests (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    link_hash TEXT NOT NULL UNIQUE,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
  );
  CREATE INDEX login_requests_email ON login_requests(email, created_at);

  CREATE TABLE oauth_states (
    state_hash TEXT PRIMARY KEY,
    redirect_uri TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id),
    page_key TEXT NOT NULL,
    alt_page_key TEXT,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    quote TEXT NOT NULL,
    selectors TEXT NOT NULL,
    author_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    resolved_at TEXT,
    resolved_by TEXT REFERENCES users(id),
    version INTEGER NOT NULL DEFAULT 1,
    deleted_at TEXT
  );
  CREATE INDEX threads_page ON threads(group_id, page_key);
  CREATE INDEX threads_alt_page ON threads(group_id, alt_page_key);

  CREATE TABLE comments (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    author_id TEXT NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'email')),
    created_at TEXT NOT NULL,
    edited_at TEXT,
    deleted_at TEXT
  );
  CREATE INDEX comments_thread ON comments(thread_id, created_at);

  -- Outgoing email queue: survives restarts, retried with backoff.
  CREATE TABLE email_jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    to_email TEXT NOT NULL,
    message TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT,
    provider_id TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT
  );
  CREATE INDEX email_jobs_due ON email_jobs(status, next_attempt_at);

  -- Emails "delivered" by the outbox provider (no real email configured).
  CREATE TABLE outbox_emails (
    id TEXT PRIMARY KEY,
    to_email TEXT NOT NULL,
    from_email TEXT NOT NULL,
    reply_to TEXT,
    subject TEXT NOT NULL,
    text TEXT NOT NULL,
    html TEXT NOT NULL,
    headers TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Inbound emails seen (dedupe webhook redeliveries) and what we did.
  CREATE TABLE inbound_emails (
    id TEXT PRIMARY KEY,
    received_at TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT,
    comment_id TEXT
  );
  `,
];

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  let version = row.user_version;
  while (version < MIGRATIONS.length) {
    tx(db, () => {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
    version++;
  }
  db.prepare(
    `INSERT OR IGNORE INTO groups (id, name, visibility, created_at) VALUES (?, 'Everyone', 'public', ?)`,
  ).run(PUBLIC_GROUP_ID, new Date().toISOString());
}

/**
 * Run `fn` in a transaction (synchronous; node:sqlite is synchronous). Nested
 * calls join the outer transaction.
 */
export function tx<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
