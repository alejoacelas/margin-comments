import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { InputInit } from '../../messages';
import type { Actions } from './actions';
import { hueIndexFor, OTHER_HUES } from '../highlights';
import { uuid } from '../../../shared/id';

export function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`;
  const date = new Date(t);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/g;

/** Plain text with http(s) links made clickable. Never interprets HTML. */
export function Linkified({ text }: { text: string }) {
  const parts: ComponentChildren[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0];
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    let ok = false;
    try {
      const u = new URL(url);
      ok = u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      ok = false;
    }
    parts.push(
      ok ? (
        <a href={url} target="_blank" rel="noopener noreferrer nofollow ugc">
          {url}
        </a>
      ) : (
        url
      ),
    );
    last = at + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

export function avatarColor(name: string, own: boolean): string {
  if (own) return 'rgb(240,187,0)';
  return `hsl(${OTHER_HUES[hueIndexFor(name)]} 55% 62%)`;
}

export function Avatar({ name, own }: { name: string; own: boolean }) {
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  return (
    <span class="avatar" style={{ background: avatarColor(name, own) }} aria-hidden="true">
      {initial}
    </span>
  );
}

/**
 * "Copy text" for private text (drafts, unsaved comments). The button lives
 * in the extension frame and copies from there, so the text never has to be
 * selected in the page, and it works on plain-HTTP pages too.
 */
export function CopyButton({ text, muted, small, actions }: { text: string; muted?: boolean; small?: boolean; actions: Actions }) {
  return (
    <SecureField
      kind="copy"
      value={text}
      onChange={() => {}}
      placeholder=""
      label="Copy text"
      testId="copy-text"
      muted={muted}
      small={small}
      actions={actions}
      onCopied={ok => actions.toast(ok ? 'Copied to clipboard' : "Couldn't copy the text.")}
    />
  );
}

declare const __OPEN_SHADOW__: boolean;
const TEST_BUILD = typeof __OPEN_SHADOW__ !== 'undefined' && __OPEN_SHADOW__;

/**
 * Text the host page must not be able to read: your email and name, drafts,
 * unsaved comments, and labels only your own comments have. A closed shadow
 * root doesn't hide text from the page's `window.find()` and Selection API
 * (find, then `selectAll`), so this is drawn as CSS generated content, which
 * neither can see. Test builds (open shadow root, driven by Playwright) use a
 * plain text node; the production-build e2e tests check the real thing.
 */
export function Private({ text, block }: { text: string; block?: boolean }) {
  if (TEST_BUILD) return block ? <div class="pv-test">{text}</div> : <span class="pv-test">{text}</span>;
  return block ? <div class="pv" data-t={text} /> : <span class="pv" data-t={text} />;
}

export const supportsPopover = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

/** A floating layer in the browser's top layer (popover API). */
export function Layer(props: {
  class: string;
  style?: Record<string, string | number>;
  children: ComponentChildren;
  layerRef?: (el: HTMLDivElement | null) => void;
  label?: string;
  role?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    props.layerRef?.(el);
    if (!el || !supportsPopover) return;
    try {
      el.showPopover();
    } catch {
      // already open
    }
    return () => {
      try {
        el.hidePopover();
      } catch {
        // detached
      }
    };
  }, []);
  return (
    <div
      ref={ref}
      popover={supportsPopover ? 'manual' : undefined}
      class={`layer ${props.class}${supportsPopover ? '' : ' no-popover'}`}
      style={props.style}
      role={props.role as preact.AriaRole | undefined}
      aria-label={props.label}
    >
      {props.children}
    </div>
  );
}

/** Grow a textarea with its content (up to a max). */
export function autosize(el: HTMLTextAreaElement | null, max = 220) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(max, el.scrollHeight + 2)}px`;
}

export const Icons = {
  check: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 8.5l3.2 3.2L13 4.8" />
    </svg>
  ),
  reopen: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 8a5 5 0 1 0 1.5-3.6" />
      <path d="M3 2.5v3h3" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  ),
  up: (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M6 10V2.5M2.5 5.5L6 2l3.5 3.5" />
    </svg>
  ),
  google: (
    <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
      <path fill="#4285F4" d="M17.6 9.2c0-.6-.1-1.2-.2-1.8H9v3.4h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.5z" />
      <path fill="#34A853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.5-1.9.9-3.1.9-2.4 0-4.4-1.6-5.1-3.7H.9v2.3A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.9 10.8a5.4 5.4 0 0 1 0-3.5V5H.9a9 9 0 0 0 0 8.1l3-2.3z" />
      <path fill="#EA4335" d="M9 3.6c1.3 0 2.5.5 3.5 1.4l2.6-2.6A9 9 0 0 0 .9 5l3 2.3C4.6 5.2 6.6 3.6 9 3.6z" />
    </svg>
  ),
};

/** Is this keyboard event "submit" (Enter without Shift, not mid-IME)? */
export function isSubmitKey(e: KeyboardEvent): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229;
}

export function newId(): string {
  return uuid();
}

/**
 * A text field that lives in an extension-origin iframe (input.html), so the
 * host page can't read what's typed (not even through its Selection API) or
 * see the keystrokes. Behaves like a controlled input: `value` in,
 * `onChange` out.
 */
export function SecureField(props: {
  kind: InputInit['kind'];
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  onEscape?: (value: string) => void;
  placeholder: string;
  label: string;
  rows?: number;
  maxLength?: number;
  autoFocus?: boolean;
  readOnly?: boolean;
  testId?: string;
  muted?: boolean;
  small?: boolean;
  /** `copy` buttons: whether the copy worked. */
  onCopied?: (ok: boolean) => void;
  actions: Actions;
}) {
  // A new session (and frame) per mount; if the page ever navigates our frame
  // away, `generation` bumps and a fresh one replaces it. The key also covers
  // a different field rendered in the same place (e.g. sign-in email -> code):
  // reusing the iframe would only change its URL's hash, which doesn't reload it.
  const [generation, setGeneration] = useState(0);
  return <SecureFrame key={`${generation}:${props.kind}:${props.testId ?? ''}`} {...props} onHijack={() => setGeneration(g => g + 1)} />;
}

function SecureFrame(props: Parameters<typeof SecureField>[0] & { onHijack: () => void }) {
  const sid = useMemo(() => `${uuid()}${uuid()}`.replace(/-/g, ''), []);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const latest = useRef(props);
  latest.current = props;
  // Values the frame reported that our props may not have caught up with yet.
  // A render can lag a keystroke behind; pushing that older value back would
  // drop what was just typed, so only values we didn't get from the frame are sent.
  const fromFrame = useRef<string[]>([props.value]);
  const loads = useRef(0);
  const [height, setHeight] = useState(
    props.kind === 'textarea' ? (props.rows ?? 3) * 17 + 12 : props.kind === 'code' ? 40 : props.kind === 'copy' ? 16 : 32,
  );
  const [width, setWidth] = useState(56);

  useLayoutEffect(() => {
    const p = latest.current;
    p.actions.openField(
      sid,
      { kind: p.kind, value: p.value, placeholder: p.placeholder, label: p.label, rows: p.rows, maxLength: p.maxLength, testId: p.testId, muted: p.muted, small: p.small },
      (type, value) => {
        const cur = latest.current;
        const changed = () => {
          fromFrame.current.push(value);
          if (fromFrame.current.length > 200) fromFrame.current.splice(0, 100);
          cur.onChange(value);
        };
        if (type === 'input') changed();
        else if (type === 'submit') {
          // Carries the field's value; make sure we have it (and its draft) first.
          if (fromFrame.current[fromFrame.current.length - 1] !== value) changed();
          cur.onSubmit?.(value);
          // The field locked itself on Enter; once the submit handler has
          // rendered (busy -> readOnly, or ignored), tell it the real state.
          setTimeout(() => latest.current.actions.fieldCommand(sid, { cmd: 'readonly', on: !!latest.current.readOnly }), 0);
        } else if (type === 'escape') cur.onEscape?.(value);
        else if (type === 'height') setHeight(Math.max(cur.kind === 'copy' ? 10 : 20, Number(value) || 0));
        else if (type === 'width') setWidth(Math.max(10, Number(value) || 0));
        else if (type === 'copied') cur.onCopied?.(value === 'ok');
        else if (type === 'ready') {
          if (cur.readOnly) cur.actions.fieldCommand(sid, { cmd: 'readonly', on: true });
          if (cur.autoFocus) {
            frameRef.current?.focus();
            cur.actions.fieldCommand(sid, { cmd: 'focus' });
          }
        }
      },
      () => latest.current.value,
    );
    return () => latest.current.actions.closeField(sid);
  }, []);

  // Value changes made by our UI (e.g. cleared after sending).
  useEffect(() => {
    const seen = fromFrame.current.lastIndexOf(props.value);
    if (seen >= 0) {
      fromFrame.current.splice(0, seen);
    } else {
      fromFrame.current = [props.value];
      props.actions.fieldCommand(sid, { cmd: 'set', value: props.value });
    }
  }, [props.value]);
  useEffect(() => {
    props.actions.fieldCommand(sid, { cmd: 'readonly', on: !!props.readOnly });
  }, [props.readOnly]);

  return (
    <iframe
      key={sid}
      ref={frameRef}
      class={props.kind === 'copy' ? 'copy-frame' : 'field-frame'}
      src={`${props.actions.inputUrl}#${sid}`}
      title={props.label}
      allow={props.kind === 'copy' ? 'clipboard-write' : undefined}
      data-testid={props.testId ? `${props.testId}-frame` : undefined}
      style={props.kind === 'copy' ? { height: `${height}px`, width: `${width}px` } : { height: `${height}px` }}
      onLoad={() => {
        // Our input page never navigates itself: a second load means the page
        // navigated the frame somewhere else. Replace it.
        loads.current++;
        if (loads.current > 1) props.onHijack();
      }}
    />
  );
}
