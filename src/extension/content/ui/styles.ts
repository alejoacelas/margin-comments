/**
 * Styles for everything inside our shadow root. Tokens follow Curius
 * (docs/design/curius-notes.md): Source Sans UI type, verdana comment
 * bodies, Lora quotes, white cards with the Google-Docs shadow, a blue
 * "Comment" chip, yellow for your threads and a pastel per author.
 */
export const CSS_TEXT = `
/* The host is a plain <div> in the page, so page rules like div { … } match
   it: reset everything with !important (a shadow tree's important rules beat
   the page's), then set what we need, also !important. */
:host {
  all: initial !important;
  -webkit-user-select: none !important;
  user-select: none !important;
  --mc-font-ui: "MC Source Sans", "Source Sans 3", "Source Sans Pro", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mc-font-comment: verdana, "MC Source Sans", sans-serif;
  --mc-font-quote: "MC Lora", Lora, Georgia, serif;
  --mc-text: rgb(33,37,41);
  --mc-text-button: #505050;
  --mc-muted: #808080;
  --mc-faint: #aaa;
  --mc-icon-idle: #c8c8c8;
  --mc-icon-hover: rgb(241,200,87);
  --mc-bg: #fff;
  --mc-bg-hover: #eee;
  --mc-bg-row-hover: #fcfcfc;
  --mc-border: lightgrey;
  --mc-border-input: #ccc;
  --mc-border-row: #f3f4f6;
  --mc-blue: #409FFF;
  --mc-send-idle: #C4C4C4;
  --mc-send-active: #007bff;
  --mc-goldenrod: rgb(240,187,0);
  --mc-danger: #c0392b;
  --mc-shadow-card: 0 2px 6px 2px rgb(60 64 67 / 15%);
  --mc-shadow-overlay: 0 0 10px 2px rgb(0 0 0 / 8%);
  --mc-card-width: 248px;
  --mc-sidebar-width: 320px;
  display: block !important;
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  width: 0 !important;
  height: 0 !important;
  overflow: visible !important;
  z-index: 2147483647 !important;
  contain: none !important;
  pointer-events: none !important;
}
*, *::before, *::after { box-sizing: border-box; }
.root { font-family: var(--mc-font-ui); font-size: 14px; line-height: 1.4; color: var(--mc-text); -webkit-font-smoothing: antialiased; }

/* Floating layers use the popover top layer when available: no host z-index or transform can cover or displace them. */
.layer {
  position: fixed; inset: auto; margin: 0; border: 0; padding: 0;
  background: transparent; overflow: visible; color: var(--mc-text);
  font-family: var(--mc-font-ui); font-size: 14px; line-height: 1.4;
  pointer-events: auto; max-width: none; max-height: none;
}
.layer:not(:popover-open):not(.no-popover) { display: none; }

button { font-family: inherit; cursor: pointer; }
button:focus-visible, textarea:focus-visible, input:focus-visible, a:focus-visible { outline: 2px solid rgb(64 159 255 / 55%); outline-offset: 1px; }

/* ---- Adder ("Comment" chip) ---- */
.adder {
  background: var(--mc-blue); color: #fff; border: 0; border-radius: 3px;
  font: 700 12px/1.4 var(--mc-font-ui); padding: 6px 10px; letter-spacing: .1px;
  box-shadow: 0 1px 2px rgb(0 0 0 / 12%);
}
.adder:hover { background: #2f93ff; }

/* ---- Cards ---- */
.card {
  width: var(--mc-card-width); background: var(--mc-bg); border-radius: 8px; padding: 6px;
  box-shadow: var(--mc-shadow-card); max-height: min(70vh, 560px); overflow: auto;
  overscroll-behavior: contain;
}
.card-head { display: flex; align-items: center; gap: 2px; height: 22px; padding: 0 2px 0 4px; }
.card-head .spacer { flex: 1; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--mc-goldenrod); flex: none; }
.icon-btn {
  width: 22px; height: 22px; border-radius: 50%; border: 0; background: transparent; color: var(--mc-icon-idle);
  display: inline-flex; align-items: center; justify-content: center; padding: 0;
}
.card:hover .icon-btn, .sidebar .icon-btn { color: var(--mc-muted); }
.icon-btn:hover { background: var(--mc-bg-hover); color: var(--mc-icon-hover) !important; }
.icon-btn svg { width: 15px; height: 15px; }
.resolved-note { font-size: 12px; color: var(--mc-muted); padding: 0 6px 4px; }

/* ---- Comments ---- */
.comment { padding: 4px 4px 2px; }
.comment + .comment { padding-left: 20px; }
.c-head { display: flex; align-items: baseline; gap: 5px; padding: 2px 6px 0; font-size: 13px; flex-wrap: wrap; }
.c-name { font-weight: 600; color: #000; }
.c-time { color: var(--mc-muted); font-size: 13px; }
.c-body {
  font: 12px/1.38 var(--mc-font-comment); white-space: pre-wrap; overflow-wrap: anywhere;
  padding: 4px 6px; color: var(--mc-text);
}
/* Only public text (comments, quotes) can be selected: anything selectable can
   be read by the page (window.find + selectAll). Private text: see Private(). */
.c-body, .row-quote, .row-first, .resolved-note { -webkit-user-select: text; user-select: text; }
.pv::before { content: attr(data-t); }
.c-body a { color: var(--mc-send-active); text-decoration: underline; }
.c-actions { display: flex; gap: 10px; padding: 0 6px 2px; height: 18px; opacity: 0; transition: opacity .1s; }
.comment:hover .c-actions, .comment:focus-within .c-actions { opacity: 1; }
.link-btn { border: 0; background: none; padding: 0; font: 600 12px var(--mc-font-ui); color: #000; }
.link-btn.muted { color: var(--mc-muted); font-weight: 400; }
.link-btn:hover { text-decoration: underline; }
.link-btn.danger { color: var(--mc-danger); }
.c-status { font-size: 11px; color: var(--mc-muted); padding: 0 6px 2px; }
.c-status.failed { color: var(--mc-danger); }
.c-status .link-btn { font-size: 11px; margin-left: 6px; }
.c-status .window-field { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; font-size: 12px; color: var(--mc-muted); border: 1px dashed var(--mc-border-input); border-radius: 4px; padding: 6px 8px; }
.window-field .link-btn { color: var(--mc-send-active); }
.copy-frame { margin-left: 6px; vertical-align: middle; }
.confirm { font-size: 12px; padding: 4px 6px; background: #fff7f5; border-radius: 4px; margin: 2px 6px; }
.confirm .confirm-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 4px; }

/* ---- Inputs ---- */
textarea, input[type=text], input[type=email] {
  width: 100%; font: 12px/1.4 var(--mc-font-comment); color: var(--mc-text); background: #fff;
  border: 1px solid var(--mc-border-input); border-radius: 4px; padding: 5px 6px; resize: none; margin: 0;
}
input[type=text], input[type=email] { font-family: var(--mc-font-ui); font-size: 14px; padding: 6px 8px; }
textarea::placeholder, input::placeholder { color: #a8a8a8; }
textarea:focus, input:focus { outline: none; border-color: #9ec9ff; }
.reply { padding: 4px 4px 2px 24px; }
.reply textarea { border-color: var(--mc-border); }
.composer { padding: 4px; }
.row-end { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 5px; }
.text-btn { border: 0; background: none; font: 600 14px var(--mc-font-ui); color: var(--mc-text-button); padding: 2px 4px; }
.text-btn:hover { color: #000; }
.pill-btn {
  border: 1px solid var(--mc-border); background: #fff; border-radius: 15px; padding: 2px 10px;
  font: 600 14px var(--mc-font-ui); color: var(--mc-text-button);
}
.pill-btn:hover:not(:disabled) { background: var(--mc-bg-hover); }
.pill-btn:disabled { opacity: .45; cursor: default; }
.cancel-link { border: 0; background: none; font: 12px var(--mc-font-ui); color: var(--mc-muted); padding: 0; }
.cancel-link:hover { text-decoration: underline; }
.send-btn {
  width: 20px; height: 20px; border-radius: 50%; border: 0; padding: 0; background: var(--mc-send-idle); color: #fff;
  display: inline-flex; align-items: center; justify-content: center;
}
.send-btn.ready { background: var(--mc-send-active); }
.send-btn svg { width: 12px; height: 12px; }
.primary-btn {
  border: 0; background: var(--mc-blue); color: #fff; border-radius: 3px; font: 700 13px/1.4 var(--mc-font-ui); padding: 6px 12px;
}
.primary-btn:disabled { opacity: .5; cursor: default; }
.secondary-btn {
  border: 1px solid var(--mc-border); background: #fff; color: var(--mc-text); border-radius: 3px; font: 600 13px/1.4 var(--mc-font-ui); padding: 5px 12px;
  display: inline-flex; gap: 8px; align-items: center; justify-content: center;
}
.secondary-btn:hover { background: #f7f7f7; }
.error { color: var(--mc-danger); font-size: 12px; margin-top: 6px; }
.hint { color: var(--mc-muted); font-size: 12px; margin-top: 6px; }
.hint a { color: var(--mc-blue); }

/* ---- Sign in ---- */
.signin { padding: 8px; }
.sidebar .signin { padding: 8px 20px 16px; }
.signin h3 { font: 600 14px var(--mc-font-ui); margin: 0 0 4px; color: #000; }
.signin p { font-size: 13px; color: var(--mc-muted); margin: 0 0 10px; }
.signin form, .signin .form { display: flex; flex-direction: column; gap: 8px; }
/* Text fields live in extension-origin frames (see SecureField). */
.field-frame { display: block; width: 100%; border: 0; margin: 0; padding: 0; background: transparent; color-scheme: light; overflow: hidden; }
.copy-frame { display: inline-block; vertical-align: baseline; border: 0; margin: 0; padding: 0; background: transparent; color-scheme: light; overflow: hidden; }
.code-input { letter-spacing: 4px; font-size: 18px !important; text-align: center; }
.or { text-align: center; font-size: 12px; color: var(--mc-faint); margin: 10px 0; }

/* ---- Sidebar ---- */
.sidebar {
  top: 0; right: 0; height: 100vh; width: var(--mc-sidebar-width); background: #fff;
  border-left: 1px solid var(--mc-border-row); box-shadow: var(--mc-shadow-overlay);
  display: flex; flex-direction: column;
}
.sb-head { display: flex; align-items: center; gap: 6px; padding: 12px 12px 8px 20px; }
.sb-title { font: 600 14px var(--mc-font-ui); color: #000; flex: 1; }
.chips { display: flex; gap: 6px; padding: 0 20px 10px; border-bottom: 1px solid var(--mc-border-row); }
.chip {
  border: 0; border-radius: 6px; background: #f1f1f1; color: var(--mc-text-button); padding: 3px 8px;
  font: 600 10px var(--mc-font-ui); text-transform: uppercase; letter-spacing: .4px;
}
.chip:hover { background: #dedede; }
.chip.on { background: var(--mc-text); color: #fff; }
.sb-body { flex: 1; overflow: auto; overscroll-behavior: contain; }
.sb-section { font: 600 10px var(--mc-font-ui); text-transform: uppercase; letter-spacing: .4px; color: var(--mc-faint); padding: 12px 20px 4px; }
.row { padding: 8px 20px; border-bottom: 1px solid var(--mc-border-row); cursor: pointer; }
.row:hover { background: var(--mc-bg-row-hover); }
.row.selected { background: #fff; box-shadow: inset 0 0 0 1px rgb(108 133 199 / 33%); cursor: default; }
.row-quote {
  font: 12px/1.6 var(--mc-font-quote); color: rgba(0,0,0,.6); border-radius: 3px; padding: 1px 4px; margin-left: -4px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere;
}
.row.selected .row-quote { -webkit-line-clamp: 6; }
.row-meta { font-size: 12px; color: var(--mc-faint); margin-top: 3px; display: flex; gap: 6px; flex-wrap: wrap; align-items: baseline; }
.row-meta .name { font-size: 13px; color: rgba(0,0,0,.55); }
.row-first { font: 12px/1.38 var(--mc-font-comment); color: var(--mc-text); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tag { display: inline-block; background: #f1f1f1; color: var(--mc-muted); border-radius: 6px; font: 600 10px var(--mc-font-ui); text-transform: uppercase; padding: 1px 6px; letter-spacing: .3px; }
.tag.warn { background: #fff4d6; color: #8a6d00; }
.row .thread-inline { margin: 6px -6px 0; }
.empty { padding: 24px 20px; color: var(--mc-muted); font-size: 13px; }
.empty strong { color: var(--mc-text); font-weight: 600; }
.sb-foot { border-top: 1px solid var(--mc-border-row); padding: 10px 20px 12px; font-size: 12px; color: var(--mc-muted); }
.me { display: flex; align-items: center; gap: 8px; }
.me .who { flex: 1; min-width: 0; }
.me .who div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.me .who .n { color: #000; font-size: 13px; font-weight: 600; }
.toggle { display: flex; align-items: center; gap: 6px; margin-top: 8px; cursor: pointer; }
.toggle input { margin: 0; }
.status { margin-bottom: 8px; padding: 6px 8px; border-radius: 4px; background: #fff9e0; color: #6b5800; font-size: 12px; }

/* ---- Avatars / launcher ---- */
.avatar {
  width: 22px; height: 22px; border-radius: 50%; color: #fff; font: 700 11px/22px var(--mc-font-ui); text-align: center;
  flex: none; display: inline-block; text-transform: uppercase;
}
.launcher {
  top: 84px; right: 14px; display: flex; align-items: center; gap: 4px; background: #fff; border-radius: 18px;
  padding: 3px 5px 3px 11px; box-shadow: var(--mc-shadow-card); border: 0; cursor: pointer;
}
.launcher:hover { box-shadow: 0 2px 8px 3px rgb(60 64 67 / 20%); }
.launcher .count { font: 600 12px var(--mc-font-ui); color: var(--mc-text-button); margin: 0 3px 0 1px; min-width: 8px; text-align: center; }
.launcher .avatar { width: 24px; height: 24px; line-height: 24px; border: 1px solid #000; box-shadow: 1px 1px 0 #000; margin-left: -6px; }
.launcher .avatar:first-of-type { margin-left: 0; }

/* ---- Toast ---- */
.toast { bottom: 20px; left: 50%; transform: translateX(-50%); background: rgb(33,37,41); color: #fff; font-size: 13px; padding: 8px 14px; border-radius: 6px; box-shadow: var(--mc-shadow-card); max-width: 420px; }
`;
