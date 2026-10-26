import { useLayoutEffect, useReducer } from 'preact/hooks';
import type { Comment, Me, ServerConfig, Thread } from '../../shared/types';
import type { Connection, Draft, Op } from '../messages';

/** A thread as displayed: server state with unsent local changes applied. */
export type ViewComment = Comment & { pending?: boolean; failedOp?: Op };
export type ViewThread = Omit<Thread, 'comments'> & {
  comments: ViewComment[];
  /** Created locally, not yet confirmed by the server. */
  pending?: boolean;
  failedOp?: Op;
};

export type AnchorStatus = 'anchored' | 'orphan' | 'pending';

export type ComposerTarget = {
  /** Id the new thread will get (stable across retries). */
  threadId: string;
  commentId: string;
  draftKey: string;
  quote: string;
  selectors: import('../../shared/types').Selector[];
  range: Range;
};

export type UiState = {
  sidebarOpen: boolean;
  sidebarFilter: 'open' | 'resolved';
  /** Thread whose card is open next to its highlight. */
  activeThreadId: string | null;
  hoverThreadId: string | null;
  composer: ComposerTarget | null;
  adder: { rect: DOMRect } | null;
  /** Bumped to force re-positioning on scroll/resize. */
  layoutTick: number;
  toast: string | null;
};

export type State = {
  user: Me | null;
  config: ServerConfig | null;
  connection: Connection;
  loaded: boolean;
  loadError: string | null;
  threads: Map<string, Thread>;
  ops: Op[];
  drafts: Draft[];
  anchors: Map<string, AnchorStatus>;
  pageKeys: string[];
  pageUrl: string;
  ui: UiState;
  invalidated: boolean;
};

type Listener = () => void;

export class Store {
  state: State;
  private listeners = new Set<Listener>();
  private scheduled = false;

  constructor(initial: State) {
    this.state = initial;
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  setUi(patch: Partial<UiState>) {
    this.state = { ...this.state, ui: { ...this.state.ui, ...patch } };
    this.emit();
  }

  private emit() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      for (const l of this.listeners) l();
    });
  }
}

export function useStore(store: Store): State {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const rendered = store.state;
  useLayoutEffect(() => {
    const unsubscribe = store.subscribe(() => force(0));
    // State may have changed between render and subscribe; don't miss it.
    if (store.state !== rendered) force(0);
    return () => {
      unsubscribe();
    };
  }, [store]);
  return store.state;
}

/** Merge server threads with the outbox to get what the user should see. */
export function viewThreads(state: Pick<State, 'threads' | 'ops' | 'user'>): ViewThread[] {
  const out = new Map<string, ViewThread>();
  for (const t of state.threads.values()) out.set(t.id, { ...t, comments: t.comments.slice() });
  const me = state.user ? { id: state.user.id, name: state.user.name } : { id: '', name: 'You' };

  for (const op of state.ops) {
    const failed = op.status === 'failed' ? op : undefined;
    const t = out.get(op.threadId);
    switch (op.kind) {
      case 'createThread': {
        if (t) break; // already confirmed
        const p = op.payload;
        const now = new Date(op.createdAt).toISOString();
        out.set(p.id, {
          id: p.id,
          groupId: p.groupId ?? 'public',
          pageKey: p.pageKeys[0],
          altPageKey: p.pageKeys[1] ?? null,
          url: p.url,
          title: p.title,
          quote: p.quote,
          selectors: p.selectors,
          author: me,
          createdAt: now,
          updatedAt: now,
          resolved: false,
          resolvedAt: null,
          resolvedBy: null,
          version: 0,
          pending: true,
          failedOp: failed,
          comments: [
            {
              id: p.comment.id,
              threadId: p.id,
              author: me,
              body: p.comment.body,
              createdAt: now,
              editedAt: null,
              pending: true,
              failedOp: failed,
            },
          ],
        });
        break;
      }
      case 'addComment': {
        if (!t || t.comments.some(c => c.id === op.commentId)) break;
        t.comments.push({
          id: op.commentId,
          threadId: op.threadId,
          author: me,
          body: op.body,
          createdAt: new Date(op.createdAt).toISOString(),
          editedAt: null,
          pending: true,
          failedOp: failed,
        });
        if (t.resolved) t.resolved = false;
        break;
      }
      case 'editComment': {
        const c = t?.comments.find(x => x.id === op.commentId);
        if (c) {
          c.body = op.body;
          c.editedAt = new Date(op.createdAt).toISOString();
          c.pending = true;
          c.failedOp = failed;
        }
        break;
      }
      case 'deleteComment': {
        if (!t || failed) break;
        if (t.comments[0]?.id === op.commentId) out.delete(op.threadId);
        else t.comments = t.comments.filter(c => c.id !== op.commentId);
        break;
      }
      case 'resolve': {
        if (t && !failed) t.resolved = op.resolved;
        break;
      }
    }
  }
  return [...out.values()];
}

/** Threads this user started or replied in get the "own" highlight color. */
export function isMine(thread: ViewThread, user: Me | null): boolean {
  if (!user) return false;
  return thread.comments.some(c => c.author.id === user.id) || thread.author.id === user.id;
}
