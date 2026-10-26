/** Messages between content scripts and the background service worker. */
import type { CreateThreadRequest, Me, Selector, ServerConfig, Thread } from '../shared/types';

export type OpBase = {
  opId: string;
  /** User who created the op; never sent under another account. */
  userId: string;
  pageKeys: string[];
  threadId: string;
  createdAt: number;
  attempts: number;
  status: 'pending' | 'failed';
  error?: string;
  /** Server error code of a failed op (e.g. id_conflict). */
  errorCode?: string;
};

export type Op = OpBase &
  (
    | { kind: 'createThread'; payload: CreateThreadRequest }
    | { kind: 'addComment'; commentId: string; body: string }
    | { kind: 'editComment'; commentId: string; body: string }
    | { kind: 'deleteComment'; commentId: string }
    | { kind: 'resolve'; resolved: boolean }
  );

export type NewOp = Op extends infer T ? (T extends Op ? Omit<T, 'opId' | 'userId' | 'createdAt' | 'attempts' | 'status' | 'error' | 'errorCode'> : never) : never;

export type Draft = {
  key: string;
  text: string;
  updatedAt: number;
  /** For new-thread drafts: where the comment was going. */
  anchor?: { pageKeys: string[]; selectors: Selector[]; quote: string };
  /** Page the draft belongs to (reply and edit drafts). */
  pageKeys?: string[];
  /** Account that wrote it (set by the background). */
  userId?: string;
};

export type Connection = 'online' | 'connecting' | 'offline';

export type RpcMethods = {
  startEmail: { params: { email: string }; result: { requestId: string; emailMode: string } };
  verifyCode: { params: { requestId: string; code: string }; result: { user: Me } };
  consumeLink: { params: { token: string }; result: { user: Me } };
  googleSignIn: { params: Record<string, never>; result: { user: Me } };
  signOut: { params: Record<string, never>; result: { ok: true } };
  updateMe: { params: { name?: string; notifyEmail?: boolean }; result: { user: Me } };
  mutate: { params: { op: NewOp; draftKey?: string; draftText?: string }; result: { opId: string } };
  retryOp: { params: { opId: string }; result: { ok: true } };
  discardOp: { params: { opId: string }; result: { ok: true } };
  saveDraft: { params: { draft: Draft }; result: { ok: true } };
  deleteDraft: { params: { key: string }; result: { ok: true } };
  refresh: { params: Record<string, never>; result: { ok: true } };
};

export type RpcMethod = keyof RpcMethods;

export type ToBackground =
  | { t: 'hello'; pageKeys: string[]; url: string }
  | { t: 'rpc'; id: number; method: RpcMethod; params: unknown };

export type ToContent =
  | { t: 'rpc-result'; id: number; ok: true; result: unknown }
  | { t: 'rpc-result'; id: number; ok: false; error: string; code?: string }
  | {
      t: 'state';
      user: Me | null;
      config: ServerConfig | null;
      connection: Connection;
      ops: Op[];
      drafts: Draft[];
    }
  | { t: 'threads'; threads: Thread[]; loaded: boolean; error?: string }
  | { t: 'thread'; thread: Thread }
  | { t: 'thread-deleted'; id: string }
  | { t: 'toggle-sidebar' };

export const PORT_NAME = 'margin-comments';
