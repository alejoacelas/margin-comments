import { useRef, useState } from 'preact/hooks';
import type { Me } from '../../../shared/types';
import { LIMITS } from '../../../shared/types';
import type { Draft, Op } from '../../messages';
import type { ViewComment, ViewThread } from '../store';
import { isMine } from '../store';
import type { Actions } from './actions';
import { CopyButton, Icons, Linkified, newId, Private, SecureField, timeAgo } from './util';

function OpStatus({ op, text, actions }: { op?: Op; text?: string; actions: Actions }) {
  if (!op) return null;
  return (
    <div class="c-status failed" role="alert">
      Not saved{op.error ? `: ${op.error}` : ''}.
      <button class="link-btn" onClick={() => actions.retryOp(op.opId)}>
        Retry
      </button>
      {text ? <CopyButton text={text} small actions={actions} /> : null}
      <button class="link-btn muted" onClick={() => actions.discardOp(op.opId)}>
        Discard
      </button>
    </div>
  );
}

function Editor(props: {
  initial: string;
  placeholder: string;
  draftKey: string;
  submitLabel: string;
  onSubmit: (text: string) => Promise<void>;
  /** Called with the texts to discard: what the editor started with and what it holds now. */
  onCancel: (texts: string[]) => void;
  /** Escape key; defaults to onCancel. */
  onEscape?: () => void;
  actions: Actions;
  autoFocus?: boolean;
  pill?: boolean;
  testId?: string;
}) {
  const [text, setText] = useState(props.initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef(text);
  textRef.current = text;

  const submit = async (value = textRef.current) => {
    const body = value.trim();
    if (!body || busy) return;
    if (body.length > LIMITS.commentBody) {
      setError(`Too long (max ${LIMITS.commentBody.toLocaleString()} characters).`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.onSubmit(body);
      setText('');
    } catch (err) {
      // The text stays in the box (and in the saved draft).
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <SecureField
        kind="textarea"
        rows={props.pill ? 1 : 3}
        value={text}
        readOnly={busy}
        placeholder={props.placeholder}
        label={props.placeholder}
        testId={props.testId}
        autoFocus={props.autoFocus}
        actions={props.actions}
        onChange={v => {
          setText(v);
          props.actions.saveDraft(props.draftKey, v);
        }}
        // The field's own value: what's on screen is what gets sent.
        onSubmit={v => void submit(v)}
        onEscape={v => {
          if (props.onEscape) props.onEscape();
          else props.onCancel([props.initial, v]);
        }}
      />
      {error ? <div class="error">{error}</div> : null}
      {props.pill ? (
        text.trim() ? (
          <div class="row-end">
            <button class="text-btn" onClick={() => props.onCancel([props.initial, text])}>
              Cancel
            </button>
            <button class="pill-btn" disabled={busy} onClick={() => void submit()}>
              {props.submitLabel}
            </button>
          </div>
        ) : null
      ) : (
        <div class="row-end">
          <button class="cancel-link" onClick={() => props.onCancel([props.initial, text])}>
            cancel
          </button>
          <button
            class={`send-btn${text.trim() ? ' ready' : ''}`}
            disabled={busy}
            aria-label={props.submitLabel}
            title={props.submitLabel}
            onClick={() => void submit()}
          >
            {Icons.up}
          </button>
        </div>
      )}
    </div>
  );
}

function CommentItem(props: {
  thread: ViewThread;
  comment: ViewComment;
  isFirst: boolean;
  user: Me | null;
  drafts: Draft[];
  actions: Actions;
}) {
  const { thread, comment, isFirst, user, actions } = props;
  const editKey = `edit:${comment.id}`;
  const editDraft = actions.draftText(editKey);
  const [editing, setEditing] = useState(editDraft !== undefined && editDraft.trim() !== '');
  const [confirming, setConfirming] = useState(false);
  const own = !!user && comment.author.id === user.id;

  return (
    <div class="comment" data-comment-id={comment.id} data-testid="comment">
      <div class="c-head">
        {/* Not yet published: the name is yours, and still private. */}
        <span class="c-name">{comment.pending || comment.failedOp ? <Private text={comment.author.name} /> : comment.author.name}</span>
        <span class="c-time" title={new Date(comment.createdAt).toLocaleString()}>
          {timeAgo(comment.createdAt)}
          {comment.editedAt ? ' · edited' : ''}
        </span>
      </div>
      {editing ? (
        <div class="reply" style={{ paddingLeft: '4px' }}>
          <Editor
            initial={editDraft ?? comment.body}
            placeholder="Edit comment"
            draftKey={editKey}
            submitLabel="Save"
            pill
            autoFocus
            actions={actions}
            testId="edit-input"
            onSubmit={async body => {
              await actions.edit(thread, comment.id, body, editKey);
              setEditing(false);
            }}
            onCancel={texts => {
              actions.deleteDraft(editKey, texts);
              setEditing(false);
            }}
          />
        </div>
      ) : (
        <div class="c-body" data-testid="comment-body">
          {comment.pending || comment.failedOp ? <Private text={comment.body} block /> : <Linkified text={comment.body} />}
        </div>
      )}
      {comment.failedOp ? (
        <OpStatus op={comment.failedOp} text={comment.body} actions={actions} />
      ) : comment.pending ? (
        <div class="c-status">Saving…</div>
      ) : null}
      {confirming ? (
        <div class="confirm">
          <Private text={isFirst ? 'Delete this comment and its whole thread?' : 'Delete this comment?'} />
          <div class="confirm-actions">
            <button class="link-btn muted" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              class="link-btn danger"
              data-testid="confirm-delete"
              onClick={() => {
                setConfirming(false);
                void actions.remove(thread, comment.id);
              }}
            >
              <Private text="Delete" />
            </button>
          </div>
        </div>
      ) : own && !editing && !comment.failedOp ? (
        // Only your own comments have these, so their labels are private:
        // the page could otherwise find which comments are yours.
        <div class="c-actions">
          <button class="link-btn" data-testid="edit" aria-label="Edit" onClick={() => setEditing(true)}>
            <Private text="edit" />
          </button>
          <button class="link-btn" data-testid="delete" aria-label="Delete" onClick={() => setConfirming(true)}>
            <Private text="delete" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function ReplyBox({ thread, drafts, actions }: { thread: ViewThread; drafts: Draft[]; actions: Actions }) {
  const key = `reply:${thread.id}`;
  void drafts;
  // One id per distinct submission: retrying the same text reuses it (so a
  // retry can't double-post), different text always gets a new one.
  const attemptRef = useRef<{ id: string; body: string } | null>(null);
  const [resetKey, setResetKey] = useState(0);
  return (
    <div class="reply">
      <Editor
        key={resetKey}
        initial={actions.draftText(key) ?? ''}
        placeholder="Reply"
        draftKey={key}
        submitLabel="Save"
        pill
        actions={actions}
        testId="reply-input"
        onSubmit={async body => {
          if (!attemptRef.current || attemptRef.current.body !== body) attemptRef.current = { id: newId(), body };
          await actions.reply(thread, attemptRef.current.id, body, key);
          attemptRef.current = null;
        }}
        onCancel={texts => {
          actions.deleteDraft(key, texts);
          setResetKey(k => k + 1);
        }}
        onEscape={() => actions.closeCard()}
      />
    </div>
  );
}

export function ThreadView(props: {
  thread: ViewThread;
  user: Me | null;
  drafts: Draft[];
  actions: Actions;
  showHeader: boolean;
}) {
  const { thread, user, actions } = props;
  const own = isMine(thread, user);
  return (
    <div data-thread-id={thread.id} data-testid="thread">
      {props.showHeader ? (
        <div class="card-head">
          {own ? <span class="dot" aria-hidden="true" /> : null}
          <span class="spacer" />
          {!thread.pending ? (
            thread.resolved ? (
              <button class="icon-btn" title="Reopen" aria-label="Reopen" data-testid="reopen" onClick={() => void actions.setResolved(thread, false)}>
                {Icons.reopen}
              </button>
            ) : (
              <button class="icon-btn" title="Resolve" aria-label="Resolve" data-testid="resolve" onClick={() => void actions.setResolved(thread, true)}>
                {Icons.check}
              </button>
            )
          ) : null}
          <button class="icon-btn" title="Close" aria-label="Close" onClick={() => actions.closeCard()}>
            {Icons.close}
          </button>
        </div>
      ) : null}
      {thread.resolved ? (
        <div class="resolved-note" data-testid="resolved-note">
          Resolved{thread.resolvedBy ? ` by ${thread.resolvedBy.name}` : ''}
          {thread.resolvedAt ? ` · ${timeAgo(thread.resolvedAt)}` : ''}
        </div>
      ) : null}
      {thread.comments.map((c, i) => (
        <CommentItem key={c.id} thread={thread} comment={c} isFirst={i === 0} user={user} drafts={props.drafts} actions={actions} />
      ))}
      {user ? <ReplyBox key={thread.id} thread={thread} drafts={props.drafts} actions={actions} /> : null}
    </div>
  );
}

export function Composer(props: { quote: string; draftKey: string; drafts: Draft[]; actions: Actions; initialText?: string }) {
  return (
    <div class="composer" data-testid="composer">
      <Editor
        initial={props.initialText ?? props.actions.draftText(props.draftKey) ?? ''}
        placeholder="Add a comment"
        draftKey={props.draftKey}
        submitLabel="Comment"
        autoFocus
        actions={props.actions}
        testId="composer-input"
        onSubmit={body => props.actions.createThread(body)}
        onCancel={() => props.actions.cancelComposer()}
      />
    </div>
  );
}
