import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Me } from '../../../shared/types';
import type { Draft } from '../../messages';
import { hueIndexFor, OTHER_HUES } from '../highlights';
import { isMine, type State, type Store, useStore, viewThreads, type ViewThread } from '../store';
import type { Actions } from './actions';
import { Composer, ThreadView } from './thread';
import { Avatar, Icons, Layer, timeAgo } from './util';

const CARD_WIDTH = 248;
const SIDEBAR_WIDTH = 320;
const GAP = 15;

/**
 * Where to put a card for a highlight: in the right margin next to it when
 * there's room (like Curius and Google Docs), else just below it, flipped
 * above when it would leave the viewport.
 */
function placeCard(rects: DOMRect[] | null, height: number, sidebarOpen: boolean): { left: number; top: number } | null {
  if (!rects || rects.length === 0) return null;
  const vw = window.innerWidth - (sidebarOpen ? SIDEBAR_WIDTH : 0);
  const vh = window.innerHeight;
  const first = rects[0];
  const last = rects[rects.length - 1];
  const right = Math.max(...rects.map(r => r.right));
  let left: number;
  let top: number;
  if (vw - right - GAP >= CARD_WIDTH + 8) {
    left = right + GAP;
    top = first.top - 6;
  } else {
    left = Math.min(Math.max(8, last.left), vw - CARD_WIDTH - 8);
    top = last.bottom + 8;
    if (top + height > vh - 8 && first.top - height - 8 > 8) top = first.top - height - 8;
  }
  left = Math.max(8, left);
  return { left, top };
}

function highlightColor(thread: ViewThread, user: Me | null): string {
  if (isMine(thread, user)) return 'rgba(255, 230, 0, 0.42)';
  return `hsl(${OTHER_HUES[hueIndexFor(thread.author.name)]} 55% 71% / 0.32)`;
}

function Card(props: { rects: DOMRect[] | null; sidebarOpen: boolean; children: preact.ComponentChildren; testId: string }) {
  const [height, setHeight] = useState(160);
  const elRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const h = elRef.current?.offsetHeight;
    if (h && Math.abs(h - height) > 2) setHeight(h);
  });
  const pos = placeCard(props.rects, height, props.sidebarOpen) ?? {
    left: Math.max(8, window.innerWidth - (props.sidebarOpen ? SIDEBAR_WIDTH : 0) - CARD_WIDTH - 24),
    top: 96,
  };
  return (
    <Layer class="card" style={{ left: `${pos.left}px`, top: `${pos.top}px` }} layerRef={el => (elRef.current = el)} role="dialog" label="Comment thread">
      <div data-testid={props.testId}>{props.children}</div>
    </Layer>
  );
}

function SignIn({ state, actions, compact }: { state: State; actions: Actions; compact?: boolean }) {
  const [email, setEmail] = useState('');
  const [request, setRequest] = useState<{ requestId: string; email: string; emailMode: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="signin" data-testid="signin">
      <h3>{compact ? 'Sign in to comment' : 'Sign in to see and add comments'}</h3>
      {!request ? (
        <>
          <p>We'll email you a sign-in link and code.</p>
          <form
            onSubmit={e => {
              e.preventDefault();
              void run(async () => {
                const r = await actions.startEmail(email);
                setRequest({ ...r, email });
              });
            }}
          >
            <input
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              aria-label="Email address"
              data-testid="signin-email"
              onInput={e => setEmail((e.currentTarget as HTMLInputElement).value)}
            />
            <button class="primary-btn" type="submit" disabled={busy || !email.trim()} data-testid="signin-send">
              {busy ? 'Sending…' : 'Email me a link'}
            </button>
          </form>
          {state.config?.googleEnabled ? (
            <>
              <div class="or">or</div>
              <button class="secondary-btn" style={{ width: '100%' }} disabled={busy} onClick={() => void run(() => actions.googleSignIn())}>
                {Icons.google} Continue with Google
              </button>
            </>
          ) : null}
        </>
      ) : (
        <>
          <p>
            We sent a link and a 6-digit code to <strong>{request.email}</strong>. Open the link here in Chrome, or enter the code.
          </p>
          <form
            onSubmit={e => {
              e.preventDefault();
              void run(() => actions.verifyCode(request.requestId, code));
            }}
          >
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              class="code-input"
              maxLength={7}
              placeholder="123456"
              value={code}
              aria-label="Sign-in code"
              data-testid="signin-code"
              onInput={e => setCode((e.currentTarget as HTMLInputElement).value)}
            />
            <button class="primary-btn" type="submit" disabled={busy || code.replace(/\D/g, '').length !== 6} data-testid="signin-verify">
              {busy ? 'Checking…' : 'Sign in'}
            </button>
          </form>
          {request.emailMode === 'outbox' ? (
            <div class="hint">
              This server isn't sending real email yet. Its admin can see your code in the{' '}
              <a href={`${actions.apiUrl}/admin/outbox`} target="_blank" rel="noopener noreferrer">
                outbox
              </a>
              .
            </div>
          ) : null}
          <div class="row-end">
            <button
              class="cancel-link"
              onClick={() => {
                setRequest(null);
                setCode('');
                setError(null);
              }}
            >
              use a different email
            </button>
          </div>
        </>
      )}
      {error ? (
        <div class="error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function Account({ user, actions }: { user: Me; actions: Actions }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.name);
  return (
    <div>
      <div class="me">
        <Avatar name={user.name} own />
        <div class="who">
          {editing ? (
            <form
              onSubmit={e => {
                e.preventDefault();
                if (name.trim()) void actions.updateMe({ name: name.trim() }).then(() => setEditing(false));
              }}
            >
              <input type="text" value={name} maxLength={80} aria-label="Display name" onInput={e => setName((e.currentTarget as HTMLInputElement).value)} />
            </form>
          ) : (
            <div class="n" title="Click to change your display name" style={{ cursor: 'pointer' }} onClick={() => setEditing(true)}>
              {user.name}
            </div>
          )}
          <div>{user.email}</div>
        </div>
        <button class="link-btn muted" data-testid="signout" onClick={() => void actions.signOut()}>
          Sign out
        </button>
      </div>
      <label class="toggle">
        <input type="checkbox" checked={user.notifyEmail} onChange={e => void actions.updateMe({ notifyEmail: (e.currentTarget as HTMLInputElement).checked })} />
        Email me when someone replies
      </label>
    </div>
  );
}

function ThreadRow(props: { thread: ViewThread; state: State; actions: Actions; selected: boolean; orphan: boolean }) {
  const { thread, state, actions } = props;
  const first = thread.comments[0];
  const replies = thread.comments.length - 1;
  return (
    <div
      class={`row${props.selected ? ' selected' : ''}`}
      data-testid="sidebar-thread"
      data-thread-id={thread.id}
      onClick={() => {
        if (!props.selected) actions.openThread(thread.id, { scroll: true, fromSidebar: true });
      }}
    >
      <div class="row-quote" style={{ background: props.orphan ? '#f4f4f4' : highlightColor(thread, state.user) }}>
        {thread.quote}
      </div>
      <div class="row-meta">
        <span class="name">{thread.author.name}</span>
        <span>{timeAgo(thread.createdAt)}</span>
        {replies > 0 ? <span>{replies === 1 ? '1 reply' : `${replies} replies`}</span> : null}
        {props.orphan ? <span class="tag warn">Text not found</span> : null}
        {thread.pending ? <span class="tag">{thread.failedOp ? 'Not saved' : 'Saving…'}</span> : null}
      </div>
      {props.selected ? (
        <div class="thread-inline" onClick={e => e.stopPropagation()}>
          {props.orphan ? <div class="hint" style={{ padding: '0 6px 4px' }}>The highlighted text can't be found on this page anymore.</div> : null}
          <ThreadView thread={thread} user={state.user} drafts={state.drafts} actions={actions} showHeader />
        </div>
      ) : first ? (
        <div class="row-first">{first.body}</div>
      ) : null}
    </div>
  );
}

function DraftRow({ draft, actions }: { draft: Draft; actions: Actions }) {
  return (
    <div class="row" data-testid="draft-row">
      <div class="row-quote" style={{ background: '#f4f4f4' }}>
        {draft.anchor?.quote}
      </div>
      <div class="row-first">{draft.text}</div>
      <div class="row-end" style={{ justifyContent: 'flex-start' }}>
        <button class="link-btn" onClick={() => actions.resumeDraft(draft)}>
          Continue
        </button>
        <button class="link-btn muted" onClick={() => actions.copy(draft.text)}>
          Copy text
        </button>
        <button class="link-btn muted" onClick={() => actions.deleteDraft(draft.key)}>
          Discard
        </button>
      </div>
    </div>
  );
}

function Sidebar({ state, actions }: { state: State; actions: Actions }) {
  const threads = viewThreads(state);
  const open = threads.filter(t => !t.resolved);
  const resolved = threads.filter(t => t.resolved);
  const filter = state.ui.sidebarFilter;
  const shown = filter === 'open' ? open : resolved;
  const anchored = shown.filter(t => !actions.isOrphan(t.id));
  const orphans = shown.filter(t => actions.isOrphan(t.id));
  // Document order for anchored threads.
  anchored.sort((a, b) => {
    const ra = actions.anchorRect(a.id)?.[0];
    const rb = actions.anchorRect(b.id)?.[0];
    if (!ra || !rb) return 0;
    return ra.top + window.scrollY - (rb.top + window.scrollY) || ra.left - rb.left;
  });
  const newDrafts = state.drafts.filter(d => d.key.startsWith('new:') && d.anchor);

  return (
    <Layer class="sidebar" role="complementary" label="Comments on this page">
      <div class="sb-head">
        <div class="sb-title">Comments</div>
        <button class="icon-btn" title="Close" aria-label="Close sidebar" data-testid="sidebar-close" onClick={() => actions.toggleSidebar(false)}>
          {Icons.close}
        </button>
      </div>
      {state.user ? (
        <div class="chips">
          <button class={`chip${filter === 'open' ? ' on' : ''}`} data-testid="filter-open" onClick={() => actions.setFilter('open')}>
            Open {open.length}
          </button>
          <button class={`chip${filter === 'resolved' ? ' on' : ''}`} data-testid="filter-resolved" onClick={() => actions.setFilter('resolved')}>
            Resolved {resolved.length}
          </button>
        </div>
      ) : null}
      <div class="sb-body" data-testid="sidebar">
        {!state.user ? (
          <SignIn state={state} actions={actions} />
        ) : (
          <>
            {newDrafts.length ? (
              <>
                <div class="sb-section">Unsent drafts</div>
                {newDrafts.map(d => (
                  <DraftRow key={d.key} draft={d} actions={actions} />
                ))}
              </>
            ) : null}
            {anchored.map(t => (
              <ThreadRow key={t.id} thread={t} state={state} actions={actions} selected={state.ui.activeThreadId === t.id} orphan={false} />
            ))}
            {orphans.length ? <div class="sb-section">Not found on this page</div> : null}
            {orphans.map(t => (
              <ThreadRow key={t.id} thread={t} state={state} actions={actions} selected={state.ui.activeThreadId === t.id} orphan />
            ))}
            {shown.length === 0 && newDrafts.length === 0 ? (
              <div class="empty">
                {!state.loaded && state.loadError ? (
                  <>Can't reach the server right now. Comments will appear when it's back.</>
                ) : filter === 'open' ? (
                  <>
                    <strong>No comments yet.</strong> Select text on the page and click <strong>Comment</strong> to start a thread.
                  </>
                ) : (
                  <>No resolved threads.</>
                )}
              </div>
            ) : null}
          </>
        )}
      </div>
      {state.user ? (
        <div class="sb-foot">
          {state.connection !== 'online' ? (
            <div class="status" data-testid="offline-status">
              {state.ops.some(o => o.status === 'pending') ? 'Offline. Your changes are saved and will sync when you reconnect.' : 'Offline. Reconnecting…'}
            </div>
          ) : null}
          <Account user={state.user} actions={actions} />
        </div>
      ) : null}
    </Layer>
  );
}

function Launcher({ state, actions, count }: { state: State; actions: Actions; count: number }) {
  const threads = viewThreads(state).filter(t => !t.resolved);
  const authors: Array<{ name: string; own: boolean }> = [];
  for (const t of threads) {
    if (authors.length >= 3) break;
    if (!authors.some(a => a.name === t.author.name)) authors.push({ name: t.author.name, own: t.author.id === state.user?.id });
  }
  return (
    <Layer class="launcher" label="Open comments sidebar">
      <button
        style={{ all: 'unset', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}
        data-testid="launcher"
        title="Comments on this page"
        onClick={() => actions.toggleSidebar(true)}
      >
        <span class="count">{count}</span>
        {authors.map(a => (
          <Avatar key={a.name} name={a.name} own={a.own} />
        ))}
      </button>
    </Layer>
  );
}

export function App({ store, actions }: { store: Store; actions: Actions }) {
  const state = useStore(store);
  const ui = state.ui;
  if (state.invalidated) return null;
  const threads = viewThreads(state);
  const active = ui.activeThreadId ? threads.find(t => t.id === ui.activeThreadId) : null;
  const openCount = threads.filter(t => !t.resolved).length;
  // The floating card is for highlights; orphans open inside the sidebar.
  const showActiveCard = !!active && !ui.composer && !(ui.sidebarOpen && actions.isOrphan(active.id));
  void ui.layoutTick; // re-render (re-position) on scroll/resize

  return (
    <div class="root">
      {ui.adder && !ui.composer ? (
        <Layer class="adder-layer" style={{ left: `${ui.adder.rect.left}px`, top: `${ui.adder.rect.top}px` }}>
          <button class="adder" data-testid="adder" onMouseDown={e => e.preventDefault()} onClick={() => actions.clickAdder()}>
            Comment
          </button>
        </Layer>
      ) : null}

      {ui.composer ? (
        <Card rects={actions.draftRect()} sidebarOpen={ui.sidebarOpen} testId="composer-card">
          {state.user ? (
            <Composer quote={ui.composer.quote} draftKey={ui.composer.draftKey} drafts={state.drafts} actions={actions} />
          ) : (
            <>
              <SignIn state={state} actions={actions} compact />
              <div class="row-end" style={{ padding: '0 8px 6px' }}>
                <button class="cancel-link" onClick={() => actions.cancelComposer()}>
                  cancel
                </button>
              </div>
            </>
          )}
        </Card>
      ) : null}

      {showActiveCard && active ? (
        <Card rects={actions.anchorRect(active.id)} sidebarOpen={ui.sidebarOpen} testId="thread-card">
          <ThreadView thread={active} user={state.user} drafts={state.drafts} actions={actions} showHeader />
        </Card>
      ) : null}

      {ui.sidebarOpen ? <Sidebar state={state} actions={actions} /> : null}

      {!ui.sidebarOpen && state.user && openCount > 0 ? <Launcher state={state} actions={actions} count={openCount} /> : null}

      {ui.toast ? (
        <Layer class="toast" role="status">
          {ui.toast}
        </Layer>
      ) : null}
    </div>
  );
}
