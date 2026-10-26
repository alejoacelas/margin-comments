/** Types and limits shared by the extension and the server. */

// W3C Web Annotation selectors (https://www.w3.org/TR/annotation-model/#selectors)
export type TextQuoteSelector = {
  type: 'TextQuoteSelector';
  exact: string;
  prefix?: string;
  suffix?: string;
};

export type TextPositionSelector = {
  type: 'TextPositionSelector';
  start: number;
  end: number;
};

/** Hypothesis-style XPath range; an extra hint, never required. */
export type RangeSelector = {
  type: 'RangeSelector';
  startContainer: string;
  startOffset: number;
  endContainer: string;
  endOffset: number;
};

export type Selector = TextQuoteSelector | TextPositionSelector | RangeSelector;

/** What other users may see about a user. Emails are never exposed. */
export type PublicUser = {
  id: string;
  name: string;
};

export type Me = PublicUser & {
  email: string;
  notifyEmail: boolean;
};

export type Comment = {
  id: string;
  threadId: string;
  author: PublicUser;
  body: string;
  createdAt: string;
  editedAt: string | null;
};

export type Thread = {
  id: string;
  groupId: string;
  pageKey: string;
  altPageKey: string | null;
  url: string;
  title: string;
  quote: string;
  selectors: Selector[];
  author: PublicUser;
  createdAt: string;
  updatedAt: string;
  resolved: boolean;
  resolvedAt: string | null;
  resolvedBy: PublicUser | null;
  /** Increases on every change; clients keep the highest version they saw. */
  version: number;
  comments: Comment[];
};

export const PUBLIC_GROUP_ID = 'public';

export const LIMITS = {
  commentBody: 10_000,
  quote: 100_000,
  title: 500,
  url: 4096,
  name: 80,
  email: 254,
  selectorsJson: 300_000,
};

// ---- REST payloads ----

export type CreateThreadRequest = {
  id: string;
  groupId?: string;
  pageKeys: string[];
  url: string;
  title: string;
  quote: string;
  selectors: Selector[];
  comment: { id: string; body: string };
};

export type AddCommentRequest = { id: string; body: string };
export type EditCommentRequest = { body: string };
export type ResolveRequest = { resolved: boolean };

export type ServerConfig = {
  googleEnabled: boolean;
  emailMode: 'resend' | 'outbox';
};

// ---- Live (WebSocket) protocol ----

export type ClientLiveMessage =
  | { type: 'auth'; token: string }
  | { type: 'subscribe'; groupId?: string; pageKeys: string[] }
  | { type: 'unsubscribe'; groupId?: string; pageKeys: string[] }
  | { type: 'ping' };

export type ServerLiveMessage =
  | { type: 'ready'; user: PublicUser }
  | { type: 'thread'; thread: Thread }
  | { type: 'thread-deleted'; id: string; pageKey: string; altPageKey: string | null }
  | { type: 'pong' }
  | { type: 'error'; error: string };

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
