import type { Comment, PublicUser, Selector, Thread } from '../shared/types';
import { LIMITS, PUBLIC_GROUP_ID } from '../shared/types';
import { type DB, nowIso, tx } from './db';
import type { UserRow } from './users';

type ThreadRow = {
  id: string;
  group_id: string;
  page_key: string;
  alt_page_key: string | null;
  url: string;
  title: string;
  quote: string;
  selectors: string;
  author_id: string;
  created_at: string;
  updated_at: string;
  resolved: number;
  resolved_at: string | null;
  resolved_by: string | null;
  version: number;
  deleted_at: string | null;
};

type CommentRow = {
  id: string;
  thread_id: string;
  author_id: string;
  body: string;
  source: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** v1: one shared space. Later: check group_members for private groups. */
export function canAccessGroup(db: DB, user: UserRow, groupId: string): boolean {
  if (groupId === PUBLIC_GROUP_ID) return true;
  const row = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, user.id);
  return !!row;
}

function usersById(db: DB, ids: Iterable<string>): Map<string, PublicUser> {
  const unique = [...new Set(ids)];
  const map = new Map<string, PublicUser>();
  if (unique.length === 0) return map;
  const rows = db
    .prepare(`SELECT id, name FROM users WHERE id IN (${unique.map(() => '?').join(',')})`)
    .all(...unique) as Array<{ id: string; name: string }>;
  for (const r of rows) map.set(r.id, { id: r.id, name: r.name });
  return map;
}

function serialize(db: DB, rows: ThreadRow[]): Thread[] {
  if (rows.length === 0) return [];
  const ids = rows.map(r => r.id);
  const comments = db
    .prepare(
      `SELECT * FROM comments WHERE thread_id IN (${ids.map(() => '?').join(',')}) AND deleted_at IS NULL ORDER BY rowid`,
    )
    .all(...ids) as CommentRow[];
  const users = usersById(db, [
    ...rows.map(r => r.author_id),
    ...rows.map(r => r.resolved_by).filter((x): x is string => !!x),
    ...comments.map(c => c.author_id),
  ]);
  const unknown: PublicUser = { id: '', name: 'Someone' };
  const byThread = new Map<string, Comment[]>();
  for (const c of comments) {
    const list = byThread.get(c.thread_id) ?? [];
    list.push({
      id: c.id,
      threadId: c.thread_id,
      author: users.get(c.author_id) ?? unknown,
      body: c.body,
      createdAt: c.created_at,
      editedAt: c.edited_at,
    });
    byThread.set(c.thread_id, list);
  }
  return rows.map(r => ({
    id: r.id,
    groupId: r.group_id,
    pageKey: r.page_key,
    altPageKey: r.alt_page_key,
    url: r.url,
    title: r.title,
    quote: r.quote,
    selectors: JSON.parse(r.selectors) as Selector[],
    author: users.get(r.author_id) ?? unknown,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolved: !!r.resolved,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by ? (users.get(r.resolved_by) ?? unknown) : null,
    version: r.version,
    comments: byThread.get(r.id) ?? [],
  }));
}

function threadRow(db: DB, id: string): ThreadRow | null {
  return (db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRow | undefined) ?? null;
}

export function getThread(db: DB, id: string): Thread | null {
  const row = threadRow(db, id);
  if (!row || row.deleted_at) return null;
  return serialize(db, [row])[0];
}

/** Thread plus the info needed for notifications, regardless of access. */
export function getThreadRow(db: DB, id: string) {
  return threadRow(db, id);
}

export function listThreads(db: DB, groupId: string, pageKeys: string[]): Thread[] {
  if (pageKeys.length === 0) return [];
  const ph = pageKeys.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM threads WHERE group_id = ? AND deleted_at IS NULL AND (page_key IN (${ph}) OR alt_page_key IN (${ph}))
       ORDER BY rowid LIMIT 1000`,
    )
    .all(groupId, ...pageKeys, ...pageKeys) as ThreadRow[];
  return serialize(db, rows);
}

export type CreateThreadInput = {
  id: string;
  groupId: string;
  pageKeys: string[];
  url: string;
  title: string;
  quote: string;
  selectors: Selector[];
  comment: { id: string; body: string };
};

export type CreateResult = { thread: Thread; created: boolean; commentId: string };

export function createThread(db: DB, user: UserRow, input: CreateThreadInput): CreateResult {
  return tx(db, () => {
    const existing = threadRow(db, input.id);
    if (existing) {
      // Idempotent retry of the same create.
      if (existing.author_id !== user.id) throw new ApiError(409, 'id_conflict');
      if (existing.deleted_at) throw new ApiError(410, 'thread_deleted');
      return { thread: serialize(db, [existing])[0], created: false, commentId: input.comment.id };
    }
    const commentClash = db.prepare('SELECT 1 FROM comments WHERE id = ?').get(input.comment.id);
    if (commentClash) throw new ApiError(409, 'id_conflict');
    const now = nowIso();
    db.prepare(
      `INSERT INTO threads (id, group_id, page_key, alt_page_key, url, title, quote, selectors, author_id, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      input.id,
      input.groupId,
      input.pageKeys[0],
      input.pageKeys[1] ?? null,
      input.url,
      input.title,
      input.quote,
      JSON.stringify(input.selectors),
      user.id,
      now,
      now,
    );
    db.prepare('INSERT INTO comments (id, thread_id, author_id, body, source, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      input.comment.id,
      input.id,
      user.id,
      input.comment.body,
      'web',
      now,
    );
    return { thread: getThread(db, input.id)!, created: true, commentId: input.comment.id };
  });
}

type ResolvedState = { resolved: boolean; by: string | null; at: string | null };

/** Record a change: bump version/updated_at, optionally set the resolved state. */
function bump(db: DB, threadId: string, resolved?: ResolvedState) {
  if (resolved) {
    db.prepare(
      'UPDATE threads SET version = version + 1, updated_at = ?, resolved = ?, resolved_at = ?, resolved_by = ? WHERE id = ?',
    ).run(nowIso(), resolved.resolved ? 1 : 0, resolved.at, resolved.by, threadId);
  } else {
    db.prepare('UPDATE threads SET version = version + 1, updated_at = ? WHERE id = ?').run(nowIso(), threadId);
  }
}

const UNRESOLVED: ResolvedState = { resolved: false, by: null, at: null };

function liveThreadRow(db: DB, user: UserRow, threadId: string): ThreadRow {
  const row = threadRow(db, threadId);
  if (!row || !canAccessGroup(db, user, row.group_id)) throw new ApiError(404, 'thread_not_found');
  if (row.deleted_at) throw new ApiError(410, 'thread_deleted');
  return row;
}

export type AddCommentResult = { thread: Thread; created: boolean; commentId: string };

export function addComment(
  db: DB,
  user: UserRow,
  threadId: string,
  comment: { id: string; body: string },
  source: 'web' | 'email' = 'web',
): AddCommentResult {
  return tx(db, () => {
    const existing = db.prepare('SELECT * FROM comments WHERE id = ?').get(comment.id) as CommentRow | undefined;
    if (existing) {
      if (existing.author_id !== user.id || existing.thread_id !== threadId) throw new ApiError(409, 'id_conflict');
      const thread = getThread(db, threadId);
      if (!thread) throw new ApiError(410, 'thread_deleted');
      return { thread, created: false, commentId: comment.id };
    }
    const row = liveThreadRow(db, user, threadId);
    db.prepare('INSERT INTO comments (id, thread_id, author_id, body, source, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      comment.id,
      threadId,
      user.id,
      comment.body,
      source,
      nowIso(),
    );
    // Like Google Docs: replying to a resolved thread reopens it.
    bump(db, threadId, row.resolved ? UNRESOLVED : undefined);
    return { thread: getThread(db, threadId)!, created: true, commentId: comment.id };
  });
}

function ownComment(db: DB, user: UserRow, commentId: string): CommentRow {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId) as CommentRow | undefined;
  if (!c) throw new ApiError(404, 'comment_not_found');
  const t = threadRow(db, c.thread_id);
  if (!t || !canAccessGroup(db, user, t.group_id)) throw new ApiError(404, 'comment_not_found');
  if (c.author_id !== user.id) throw new ApiError(403, 'not_your_comment');
  return c;
}

export function editComment(db: DB, user: UserRow, commentId: string, body: string): Thread {
  return tx(db, () => {
    const c = ownComment(db, user, commentId);
    if (c.deleted_at) throw new ApiError(410, 'comment_deleted');
    liveThreadRow(db, user, c.thread_id);
    if (c.body !== body) {
      db.prepare('UPDATE comments SET body = ?, edited_at = ? WHERE id = ?').run(body, nowIso(), commentId);
      bump(db, c.thread_id);
    }
    return getThread(db, c.thread_id)!;
  });
}

export type DeleteResult =
  | { kind: 'comment'; thread: Thread }
  | { kind: 'thread'; threadId: string; pageKey: string; altPageKey: string | null; groupId: string }
  | { kind: 'noop' };

/**
 * Delete one of your comments. Deleting the first comment deletes the whole
 * thread (as in Google Docs). Repeating a delete is a no-op.
 */
export function deleteComment(db: DB, user: UserRow, commentId: string): DeleteResult {
  return tx(db, () => {
    const c = ownComment(db, user, commentId);
    const t = threadRow(db, c.thread_id)!;
    if (c.deleted_at || t.deleted_at) return { kind: 'noop' } as const;
    const first = db
      .prepare('SELECT id FROM comments WHERE thread_id = ? ORDER BY rowid LIMIT 1')
      .get(c.thread_id) as { id: string };
    const now = nowIso();
    if (first.id === c.id) {
      db.prepare('UPDATE threads SET deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ?').run(now, now, t.id);
      db.prepare('UPDATE comments SET deleted_at = ? WHERE thread_id = ? AND deleted_at IS NULL').run(now, t.id);
      return { kind: 'thread', threadId: t.id, pageKey: t.page_key, altPageKey: t.alt_page_key, groupId: t.group_id } as const;
    }
    db.prepare('UPDATE comments SET deleted_at = ? WHERE id = ?').run(now, c.id);
    bump(db, c.thread_id);
    return { kind: 'comment', thread: getThread(db, c.thread_id)! } as const;
  });
}

export function setResolved(db: DB, user: UserRow, threadId: string, resolved: boolean): Thread {
  return tx(db, () => {
    const row = liveThreadRow(db, user, threadId);
    if (!!row.resolved !== resolved) {
      bump(db, threadId, resolved ? { resolved: true, by: user.id, at: nowIso() } : UNRESOLVED);
    }
    return getThread(db, threadId)!;
  });
}

/** Everyone who wrote a live comment in the thread (thread author included). */
export function participants(db: DB, threadId: string): UserRow[] {
  return db
    .prepare(
      `SELECT DISTINCT u.* FROM comments c JOIN users u ON u.id = c.author_id
       WHERE c.thread_id = ? AND c.deleted_at IS NULL`,
    )
    .all(threadId) as UserRow[];
}

export function getComment(db: DB, id: string): CommentRow | null {
  return (db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as CommentRow | undefined) ?? null;
}

export function clampTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, LIMITS.title);
}
