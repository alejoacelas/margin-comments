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
 * (toggling a checkbox, submitting a form, following a link), so replaying one
 * would activate twice. Clicks are left alone here and stopped at the shadow
 * host instead (see index.tsx), which hides them from the page's bubbling
 * listeners while the browser activates the target exactly once.
 */

declare global {
  interface Window {
    __marginCommentsShield?: { host: Element | null };
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

// Scrolling inside our panels must not be hijacked by page wheel handlers;
// there's nothing of ours to re-dispatch to, so these are only stopped.
const STOP_ONLY = ['wheel'];

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
  const shield: { host: Element | null } = { host: null };
  window.__marginCommentsShield = shield;

  const onEvent = (e: Event) => {
    const host = shield.host;
    if (!host || !e.isTrusted || e.target !== host) return;
    e.stopImmediatePropagation();
    if (STOP_ONLY.includes(e.type)) return;
    const inner = e.composedPath()[0];
    if (!(inner instanceof Node) || inner === host) return;
    const copy = clone(e);
    if (!copy) return;
    const notCancelled = inner.dispatchEvent(copy);
    if (!notCancelled && e.cancelable) e.preventDefault();
  };

  for (const type of SHIELDED) window.addEventListener(type, onEvent, { capture: true });
  for (const type of STOP_ONLY) window.addEventListener(type, onEvent, { capture: true, passive: true });
}

export {};
