import { describe, expect, it } from 'vitest';
import type { Op } from '../../src/extension/messages';
import { viewThreads } from '../../src/extension/content/store';
import type { Thread } from '../../src/shared/types';

const thread: Thread = {
  id: 't1',
  groupId: 'public',
  pageKey: 'example.com/a',
  altPageKey: null,
  url: 'https://example.com/a',
  title: 'A',
  quote: 'q',
  selectors: [{ type: 'TextQuoteSelector', exact: 'q' }],
  author: { id: 'u1', name: 'U' },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  resolved: false,
  resolvedAt: null,
  resolvedBy: null,
  version: 3,
  comments: [{ id: 'c1', threadId: 't1', author: { id: 'u1', name: 'U' }, body: 'server text', createdAt: '2026-01-01T00:00:00Z', editedAt: null }],
};

describe('viewThreads', () => {
  it('applies unsent ops without mutating server state', () => {
    const threads = new Map([[thread.id, thread]]);
    const edit: Op = { kind: 'editComment', opId: 'o1', userId: 'u1', pageKeys: ['example.com/a'], threadId: 't1', commentId: 'c1', body: 'local text', createdAt: 0, attempts: 0, status: 'failed', error: 'nope' };
    const view = viewThreads({ threads, ops: [edit], user: { id: 'u1', name: 'U', email: 'u@x', notifyEmail: true } });
    expect(view[0].comments[0].body).toBe('local text');
    expect(thread.comments[0].body).toBe('server text');
    expect((thread.comments[0] as any).pending).toBeUndefined();
    // Discarding the op restores the server text.
    expect(viewThreads({ threads, ops: [], user: null })[0].comments[0].body).toBe('server text');
  });
});
