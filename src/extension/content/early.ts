/**
 * Runs at document_start, before any page script, so its window capture
 * listeners fire first. Events that originate inside our UI (the shadow host)
 * are stopped before the page sees them — typing "j" in a comment box must
 * not trigger the site's keyboard shortcuts, and a site's mousedown handler
 * must not be able to cancel focusing our textarea. A non-composed copy of
 * each event is re-dispatched at its original target, so it reaches our own
 * handlers inside the shadow root and nothing outside it. Default actions
 * (typing, focusing) come from the original trusted event, and
 * preventDefault() on the copy is forwarded to it.
 *
 * Clicks are different: a dispatched click has activation behavior of its own
 * (toggling a checkbox, submitting a form, following a link), so replaying it
 * while the original also activates would activate twice. The original click
 * is therefore stopped *and* cancelled (no activation), and a single
 * non-composed copy is dispatched in a later task, after the original's
 * dispatch (including a checkbox's cancelled-activation revert) has finished.
 * The copy activates exactly once and still reaches our handlers, even on
 * pages whose capture-phase listeners stop every click.
 */

export type Shield = {
  host: Element | null;
  /**
   * Finds the real target inside our UI. Needed because with a closed shadow
   * root `composedPath()` seen from the window stops at the host; the content
   * script (which holds the root) resolves pointer events by position and
   * keyboard/input events by the focused element.
   */
  resolve: ((e: Event) => Node | null) | null;
};

declare global {
  interface Window {
    __marginCommentsShield?: Shield;
  }
}

const SHIELDED = [
  'keydown',
  'keyup',
  'keypress',
  'beforeinput',
  'input',
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'mousedown',
  'mouseup',
  'contextmenu',
  'pointerdown',
  'pointerup',
  'touchstart',
  'touchend',
  'focusin',
  'focusout',
  'copy',
  'cut',
  'paste',
  'selectstart',
  'dragstart',
];

// Only stopped (default action kept, nothing replayed): scrolling inside our
// panels, and middle/double clicks (native middle-click opens links in a new
// tab, which a replayed copy can't do; we have no handlers for either).
const STOP_ONLY = ['wheel', 'auxclick', 'dblclick'];

// Activation-bearing events: replayed later instead of synchronously.
const DEFERRED = ['click'];

function clone(e: Event): Event | null {
  const Ctor = e.constructor as { new (type: string, init: object): Event };
  try {
    // Event init dictionaries read properties by name, so the original event
    // works as its own init (key, code, clientX, relatedTarget, data, …).
    const init: Record<string, unknown> = {};
    for (const k in e) init[k] = (e as unknown as Record<string, unknown>)[k];
    init.bubbles = e.bubbles;
    init.cancelable = e.cancelable;
    init.composed = false;
    return new Ctor(e.type, init);
  } catch {
    return null;
  }
}

if (!window.__marginCommentsShield) {
  const shield: Shield = { host: null, resolve: null };
  window.__marginCommentsShield = shield;

  const onEvent = (e: Event) => {
    const host = shield.host;
    if (!host || e.target !== host) return;
    e.stopImmediatePropagation();
    // Browser-generated follow-ups from our replayed events (e.g. the click a
    // <label> sends to its checkbox) are composed and untrusted: hide them
    // from the page but let them run their default action untouched.
    if (!e.isTrusted) return;
    if (STOP_ONLY.includes(e.type)) return;
    const inner = shield.resolve?.(e) ?? e.composedPath()[0];
    if (!(inner instanceof Node) || inner === host) return;
    const copy = clone(e);
    if (!copy) return;
    if (DEFERRED.includes(e.type)) {
      e.preventDefault();
      setTimeout(() => inner.isConnected && inner.dispatchEvent(copy), 0);
      return;
    }
    const notCancelled = inner.dispatchEvent(copy);
    if (!notCancelled && e.cancelable) e.preventDefault();
  };

  for (const type of [...SHIELDED, ...DEFERRED]) window.addEventListener(type, onEvent, { capture: true });
  for (const type of STOP_ONLY) window.addEventListener(type, onEvent, { capture: true, passive: type === 'wheel' });
}

export {};
