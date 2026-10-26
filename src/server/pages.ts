import { esc } from './email/templates';

/** Small server-rendered pages. No scripts; every value is escaped. */

export const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(title)}</title>
<style>
:root{color-scheme:light;}
body{margin:0;background:#fff;color:#212529;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Source Sans 3','Source Sans Pro','Segoe UI',Helvetica,Arial,sans-serif;}
main{max-width:640px;margin:0 auto;padding:48px 20px;}
h1{font-size:20px;font-weight:600;margin:0 0 10px;}
p{margin:0 0 12px;color:#505050;}
.muted{color:#808080;font-size:13px;}
a{color:#409FFF;}
button{font:inherit;font-weight:600;font-size:14px;background:#409FFF;color:#fff;border:0;border-radius:3px;padding:7px 14px;cursor:pointer;}
.mail{border-top:1px solid #f3f4f6;padding:14px 0;}
.mail pre{white-space:pre-wrap;word-break:break-word;font:13px/1.45 ui-monospace,Menlo,monospace;background:#fafafa;border-radius:4px;padding:10px;margin:8px 0 0;}
.banner{background:#FFF9C4;border-radius:4px;padding:10px 12px;margin-bottom:18px;font-size:14px;}
</style></head><body><main>${body}</main></body></html>`;
}

export function homePage(): string {
  return page(
    'Margin Comments',
    `<h1>Margin Comments</h1>
<p>Google Docs-style comment threads on any web page. This is the backend for the Chrome extension.</p>
<p class="muted"><a href="https://github.com/alejoacelas/margin-comments">Source and setup instructions</a></p>`,
  );
}

export function verifyPage(): string {
  return page(
    'Signing in · Margin Comments',
    `<div id="mc-verify" data-state="waiting">
<h1 id="mc-verify-title">Signing you in…</h1>
<p id="mc-verify-message">If Margin Comments is installed in this Chrome, you'll be signed in automatically in a moment.
Otherwise, type the 6-digit code from the email into the extension.</p>
<p><button id="mc-verify-confirm" type="button" hidden>Sign in</button></p>
</div>`,
  );
}

export function messagePage(title: string, message: string): string {
  return page(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`);
}

export function unsubscribePage(userId: string, sig: string, done: boolean): string {
  if (done) {
    return page(
      'Notifications off',
      `<h1>Email notifications are off</h1><p>You won't get emails about replies anymore. You can turn them back on from the extension's sidebar.</p>`,
    );
  }
  return page(
    'Turn off notifications',
    `<h1>Turn off email notifications?</h1>
<p>You'll stop getting emails when someone replies in threads you're part of.</p>
<form method="post" action="/unsubscribe?u=${encodeURIComponent(userId)}&amp;s=${encodeURIComponent(sig)}"><button type="submit">Turn off</button></form>`,
  );
}

type OutboxRow = { to_email: string; subject: string; text: string; created_at: string; reply_to: string | null };

function linkify(text: string): string {
  return esc(text).replace(/https?:\/\/[^\s<>"']+/g, url => `<a href="${url}">${url}</a>`);
}

export function outboxPage(rows: OutboxRow[], mode: string): string {
  const items = rows
    .map(
      r => `<div class="mail"><div><strong>${esc(r.subject)}</strong></div>
<div class="muted">to ${esc(r.to_email)} · ${esc(r.created_at)}${r.reply_to ? ` · reply-to ${esc(r.reply_to)}` : ''}</div>
<pre>${linkify(r.text)}</pre></div>`,
    )
    .join('\n');
  return page(
    'Outbox · Margin Comments',
    `<h1>Outbox</h1>
<div class="banner">Email mode: <strong>${esc(mode)}</strong>. ${
      mode === 'outbox'
        ? 'Real email is off, so sign-in links and notifications are kept here instead of being sent.'
        : 'Real email is on; this page only shows messages stored before it was turned on.'
    }</div>
${items || '<p class="muted">No messages yet.</p>'}`,
  );
}
