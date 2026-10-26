/** Email templates. Every interpolated value goes through `esc`. */

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1).trimEnd()}…` : flat;
}

/** Only http(s) URLs are ever placed in href attributes. */
function safeHref(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : '#';
  } catch {
    return '#';
  }
}

const FONT = `-apple-system, BlinkMacSystemFont, 'Source Sans 3', 'Source Sans Pro', 'Segoe UI', Helvetica, Arial, sans-serif`;
const SERIF = `Lora, Georgia, 'Times New Roman', serif`;
const TEXT = '#212529';
const MUTED = '#808080';

function layout(inner: string, footer: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#ffffff;">
<div style="max-width:560px;margin:0 auto;padding:28px 20px;font-family:${FONT};font-size:15px;line-height:1.5;color:${TEXT};">
${inner}
<div style="margin-top:28px;padding-top:14px;border-top:1px solid #f3f4f6;font-size:12px;color:#aaaaaa;">${footer}</div>
</div></body></html>`;
}

export type LoginEmailInput = { code: string; link: string; minutes: number };

export function loginEmail(input: LoginEmailInput) {
  const subject = `Your Margin Comments sign-in code: ${input.code}`;
  const text = [
    `Your sign-in code is ${input.code}`,
    '',
    `Or open this link in the Chrome where Margin Comments is installed:`,
    input.link,
    '',
    `The code and link expire in ${input.minutes} minutes. If you didn't ask to sign in, you can ignore this email.`,
  ].join('\n');
  const html = layout(
    `<div style="font-size:13px;color:${MUTED};margin-bottom:6px;">Margin Comments</div>
<div style="font-size:17px;margin-bottom:18px;">Your sign-in code</div>
<div style="font-size:30px;letter-spacing:6px;font-weight:600;margin-bottom:22px;">${esc(input.code)}</div>
<div style="margin-bottom:22px;"><a href="${esc(safeHref(input.link))}" style="display:inline-block;background:#409FFF;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:8px 16px;border-radius:3px;">Sign in</a></div>
<div style="font-size:13px;color:${MUTED};">Open the link in the Chrome where Margin Comments is installed, or type the code into the extension.</div>`,
    `The code and link expire in ${input.minutes} minutes. If you didn't ask to sign in, ignore this email.`,
  );
  return { subject, text, html };
}

export type NotificationInput = {
  threadId: string;
  pageTitle: string;
  pageUrl: string;
  threadLink: string;
  quote: string;
  replyAuthor: string;
  replyBody: string;
  /** The comment just before the new one, for context (optional). */
  previous?: { author: string; body: string } | null;
  recipientStartedThread: boolean;
  unsubscribeLink: string;
  canReplyByEmail: boolean;
};

export function notificationEmail(n: NotificationInput) {
  const title = truncate(n.pageTitle || hostOf(n.pageUrl), 80);
  const quoteShort = truncate(n.quote, 50);
  const subject = `“${quoteShort}” on ${title}`;
  const quote = truncate(n.quote, 500);
  const why = n.recipientStartedThread
    ? "You're receiving this because you started this thread."
    : "You're receiving this because you replied in this thread.";
  const replyHint = n.canReplyByEmail ? 'Reply to this email to respond in the thread.' : 'Open the thread to reply.';

  const text = [
    `${n.replyAuthor} replied on "${title}"`,
    '',
    `> ${quote}`,
    '',
    ...(n.previous ? [`${n.previous.author}: ${truncate(n.previous.body, 300)}`, ''] : []),
    `${n.replyAuthor}:`,
    n.replyBody,
    '',
    `Open the thread: ${n.threadLink}`,
    '',
    replyHint,
    why,
    `Turn off email notifications: ${n.unsubscribeLink}`,
  ].join('\n');

  const html = layout(
    `<div style="font-size:13px;color:${MUTED};margin-bottom:14px;"><strong style="color:${TEXT};font-weight:600;">${esc(n.replyAuthor)}</strong> replied on <a href="${esc(safeHref(n.threadLink))}" style="color:${TEXT};">${esc(title)}</a></div>
<div style="font-family:${SERIF};font-size:14px;line-height:1.6;color:#505050;background:#FFF9C4;border-left:3px solid #F1C857;padding:8px 12px;border-radius:4px;margin-bottom:18px;">${esc(quote)}</div>
${
  n.previous
    ? `<div style="margin-bottom:12px;color:${MUTED};font-size:14px;"><span style="font-weight:600;">${esc(n.previous.author)}</span><br>${multiline(truncate(n.previous.body, 300))}</div>`
    : ''
}
<div style="margin-bottom:22px;font-size:15px;"><span style="font-weight:600;">${esc(n.replyAuthor)}</span><br>${multiline(n.replyBody)}</div>
<div><a href="${esc(safeHref(n.threadLink))}" style="display:inline-block;color:#409FFF;text-decoration:none;font-weight:600;font-size:14px;">Open thread →</a></div>`,
    `${esc(replyHint)}<br>${esc(why)} <a href="${esc(safeHref(n.unsubscribeLink))}" style="color:#aaaaaa;">Turn off email notifications</a>`,
  );
  return { subject, text, html };
}

function multiline(s: string): string {
  return esc(s).replace(/\n/g, '<br>');
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'a page';
  }
}
