/**
 * A single text field rendered in an extension-origin iframe (input.html).
 *
 * Text the user types into Margin Comments never lives in the host page's
 * document: a page can read a focused field's text through its own Selection
 * API even inside a closed shadow root, and could see keystrokes. Here the
 * field is in a cross-origin frame the page can neither read nor script.
 * The frame talks only to the background worker, which relays to the content
 * script that opened it (identified by an unguessable session id).
 */
import type { InputCommand, InputEventType, InputInit } from '../messages';

const sid = location.hash.slice(1);
let field: HTMLTextAreaElement | HTMLInputElement | null = null;
let lastHeight = 0;
/** Attached to the content script (we got `init` on the current port). */
let attached = false;
/** Enter/Escape pressed while the worker was restarting; sent once re-attached. */
let held: { t: 'event'; type: InputEventType; value: string }[] = [];
let port = connect();

function send(msg: { t: 'event'; type: InputEventType; value: string }) {
  if (!attached) {
    // Typing is resent as the field's whole value on re-attach; keys aren't.
    if (msg.type === 'submit' || msg.type === 'escape') held.push(msg);
    return;
  }
  try {
    port.postMessage({ ...msg, sid });
  } catch {
    attached = false;
    if (msg.type === 'submit' || msg.type === 'escape') held.push(msg);
  }
}

function reportHeight() {
  if (!field) return;
  let h: number;
  if (field instanceof HTMLTextAreaElement) {
    field.style.height = 'auto';
    h = Math.min(field.scrollHeight + 2, Number(field.dataset.max) || 220);
    field.style.height = `${h}px`;
  } else {
    h = field.getBoundingClientRect().height;
  }
  if (Math.abs(h - lastHeight) > 0.5) {
    lastHeight = h;
    send({ t: 'event', type: 'height', value: String(Math.ceil(h)) });
  }
}

/** The text a `copy` button copies (kept current by `set`). */
let copyText = '';

function buildCopy(init: InputInit) {
  copyText = init.value;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = ['copy', init.muted ? 'muted' : '', init.small ? 'small' : ''].filter(Boolean).join(' ');
  b.textContent = init.label;
  if (init.testId) b.dataset.testid = init.testId;
  b.addEventListener('click', async () => {
    // Copied from this extension page: the host page never holds the text
    // (no selection, no copy event it could observe), and it works on plain
    // HTTP pages, where content scripts have no clipboard API.
    let ok = false;
    try {
      await navigator.clipboard.writeText(copyText);
      ok = true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = copyText;
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    }
    send({ t: 'event', type: 'copied', value: ok ? 'ok' : 'failed' });
  });
  document.body.appendChild(b);
  // The frame is sized to the button; re-measure once the web font is in.
  const size = () => {
    const r = b.getBoundingClientRect();
    send({ t: 'event', type: 'width', value: String(Math.ceil(r.width) + 1) });
    send({ t: 'event', type: 'height', value: String(Math.ceil(r.height)) });
  };
  size();
  new ResizeObserver(size).observe(b);
  void document.fonts.ready.then(size);
  send({ t: 'event', type: 'ready', value: '' });
}

let built = false;

function build(init: InputInit) {
  built = true;
  if (init.kind === 'copy') return buildCopy(init);
  const el = init.kind === 'textarea' ? document.createElement('textarea') : document.createElement('input');
  if (el instanceof HTMLInputElement) {
    el.type = init.kind === 'email' ? 'email' : 'text';
    if (init.kind === 'code') {
      el.inputMode = 'numeric';
      el.autocomplete = 'one-time-code';
      el.className = 'code';
    }
    if (init.kind === 'email') el.autocomplete = 'email';
  } else {
    el.rows = init.rows ?? 3;
    el.dataset.max = '220';
  }
  el.placeholder = init.placeholder;
  el.setAttribute('aria-label', init.label);
  if (init.testId) el.dataset.testid = init.testId;
  if (init.maxLength) el.maxLength = init.maxLength;
  el.value = init.value;
  el.addEventListener('input', () => {
    send({ t: 'event', type: 'input', value: el.value });
    reportHeight();
  });
  (el as HTMLElement).addEventListener('keydown', (e: KeyboardEvent) => {
    const composing = e.isComposing || e.keyCode === 229;
    const submit = e.key === 'Enter' && !composing && (el instanceof HTMLInputElement || !e.shiftKey || e.metaKey || e.ctrlKey);
    if (submit) {
      e.preventDefault();
      // Lock right away (the parent confirms or lifts it): keys typed while
      // the comment is being sent must not land in the text being sent.
      el.readOnly = true;
      send({ t: 'event', type: 'submit', value: el.value });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      send({ t: 'event', type: 'escape', value: el.value });
    }
  });
  document.body.appendChild(el);
  field = el;
  new ResizeObserver(reportHeight).observe(document.body);
  reportHeight();
  send({ t: 'event', type: 'ready', value: el.value });
}

function run(cmd: InputCommand) {
  if (cmd.cmd === 'set') copyText = cmd.value ?? '';
  if (!field) return;
  if (cmd.cmd === 'set') {
    field.value = cmd.value ?? '';
    reportHeight();
  } else if (cmd.cmd === 'focus') {
    field.focus({ preventScroll: true });
    const len = field.value.length;
    try {
      field.setSelectionRange(len, len);
    } catch {
      // email inputs don't support selection ranges
    }
  } else if (cmd.cmd === 'readonly') {
    field.readOnly = !!cmd.on;
  }
}

/** Connect to the worker; reconnect (keeping the field and its text) if it restarts. */
function connect(): chrome.runtime.Port {
  const p = chrome.runtime.connect({ name: 'mc-input' });
  p.onMessage.addListener((msg: { t: 'init'; init: InputInit } | { t: 'cmd'; cmd: InputCommand }) => {
    if (msg.t === 'init') {
      attached = true;
      if (!built) build(msg.init);
      else if (field) {
        // Re-attached after the worker restarted: the field is the source of
        // truth for what was typed meanwhile.
        send({ t: 'event', type: 'input', value: field.value });
        for (const m of held.splice(0)) send({ ...m, value: field.value });
      }
    } else if (msg.t === 'cmd') run(msg.cmd);
  });
  p.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    attached = false;
    setTimeout(() => {
      try {
        port = connect();
      } catch {
        // extension reloaded: this frame is orphaned
      }
    }, 250);
  });
  p.postMessage({ t: 'hello', sid });
  return p;
}
// When the frame itself gets focus (e.g. the parent focuses the iframe), pass it on.
window.addEventListener('focus', () => field?.focus({ preventScroll: true }));
// The session id is read once at load; a reused frame with a new hash must start over.
window.addEventListener('hashchange', () => location.reload());
