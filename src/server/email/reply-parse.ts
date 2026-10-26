import EmailReplyParser from 'email-reply-parser';
import { convert } from 'html-to-text';

/**
 * Extract just the new text from an email reply: drop quoted history
 * ("On … wrote:", Outlook headers, "> " lines) and signatures.
 *
 * Layered: our own cut rules first (they know our reply-address format and
 * the common client separators), then crisp-oss/email-reply-parser for
 * signatures and localized quote headers.
 */
export function extractReply(text: string | null, html: string | null): string {
  let body = text && text.trim() ? text : html ? htmlToText(html) : '';
  body = body.replace(/\r\n?/g, '\n').replace(/ /g, ' ');
  body = cutQuotedHistory(body);
  let visible: string;
  try {
    visible = new EmailReplyParser().read(body).getVisibleText();
  } catch {
    visible = body;
  }
  // The parser can be overeager on single-paragraph replies; never return
  // empty when our own cut left real text.
  if (!visible.trim() && body.trim()) visible = body;
  visible = stripSignatureLines(visible);
  visible = stripSignOff(visible);
  return visible.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

const SIGN_OFF = /^(best|best wishes|best regards|kind regards|warm regards|regards|thanks|thanks so much|many thanks|thank you|cheers|sincerely|all the best|warmly|talk soon|xo|xx)[,.!]?$/i;

/**
 * Drop a trailing sign-off block ("Thanks,\nBob" / "Best regards,\nBob\nAcme"):
 * a closing phrase on its own line followed by at most 3 short lines. Never
 * removes the whole message.
 */
function stripSignOff(text: string): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  for (let i = lines.length - 1; i >= Math.max(1, lines.length - 4); i--) {
    if (!SIGN_OFF.test(lines[i].trim())) continue;
    const after = lines.slice(i + 1).filter(l => l.trim());
    if (after.length > 3 || after.some(l => l.trim().length > 40)) continue;
    const before = lines.slice(0, i).join('\n').trim();
    if (before) return before;
  }
  return text;
}

function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'blockquote', format: 'skip' },
      { selector: 'div.gmail_quote', format: 'skip' },
      { selector: 'div.gmail_signature', format: 'skip' },
      { selector: 'div.gmail_extra', format: 'skip' },
      { selector: 'div#divRplyFwdMsg', format: 'skip' },
      { selector: 'div#appendonsend', format: 'skip' },
      { selector: 'div.yahoo_quoted', format: 'skip' },
      { selector: 'div.moz-cite-prefix', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'head', format: 'skip' },
    ],
  });
}

const REPLY_HEADER_PATTERNS: RegExp[] = [
  // Gmail / Apple Mail / Thunderbird: "On Mon, 26 Oct 2026 at 15:00, X <y> wrote:"
  /^\s*On\b.{0,400}\bwrote:\s*$/i,
  /^\s*Le\b.{0,400}\ba écrit\s*:\s*$/i,
  /^\s*El\b.{0,400}\bescribió:\s*$/i,
  /^\s*Am\b.{0,400}\bschrieb\b.{0,200}:\s*$/i,
  /^\s*Em\b.{0,400}\bescreveu:\s*$/i,
  /^\s*Il\b.{0,400}\bha scritto:\s*$/i,
  // Outlook
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$/i,
  /^\s*_{10,}\s*$/,
  // Our own notification footer, if a client pasted it unquoted.
  /^\s*Reply to this email to respond in the thread/i,
  /^\s*You're receiving this because you (started|replied)/i,
];

function cutQuotedHistory(body: string): string {
  const lines = body.split('\n');
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const joined = i + 1 < lines.length ? `${line} ${lines[i + 1]}` : line;
    if (REPLY_HEADER_PATTERNS.some(re => re.test(line))) {
      cut = i;
      break;
    }
    // Header split across two lines by the client's wrapping.
    if (/^\s*On\b/i.test(line) && !/wrote:\s*$/i.test(line) && /\bwrote:\s*$/i.test(joined) && joined.length < 500) {
      cut = i;
      break;
    }
    // Outlook-style block: "From: …" followed shortly by "Sent:"/"Date:"/"To:".
    if (/^\s*\*?From:\*?\s+\S/i.test(line)) {
      const next = lines.slice(i + 1, i + 5).join('\n');
      if (/^\s*\*?(Sent|Date|To|Subject):\*?\s/im.test(next)) {
        cut = i;
        break;
      }
    }
    // A line that mentions one of our reply addresses is part of a quote header.
    if (/\br-[a-z2-7]{26}-[a-z2-7]{12}-[a-z2-7]{16}@/i.test(line)) {
      cut = i;
      break;
    }
  }
  return lines
    .slice(0, cut)
    .filter(l => !/^\s*>/.test(l))
    .join('\n');
}

const SIGNATURE_LINES = [
  /^\s*Sent from my (iPhone|iPad|Android|mobile device|BlackBerry|Galaxy|Pixel)\b.*$/i,
  /^\s*Sent from (Mail|Outlook|Yahoo Mail|Gmail) for .*$/i,
  /^\s*Sent from (Outlook|Yahoo Mail|Proton Mail|ProtonMail|Superhuman|Spark|Front)\b.*$/i,
  /^\s*Get Outlook for (iOS|Android).*$/i,
  /^\s*Sent with (Proton Mail|ProtonMail|Spark|Superhuman).*$/i,
  /^\s*Enviado desde mi (iPhone|iPad|Android).*$/i,
];

function stripSignatureLines(text: string): string {
  const lines = text.split('\n');
  // "-- " (RFC 3676) starts a signature block.
  const dash = lines.findIndex(l => l === '-- ' || l === '--');
  const kept = dash >= 0 ? lines.slice(0, dash) : lines;
  return kept.filter(l => !SIGNATURE_LINES.some(re => re.test(l))).join('\n');
}
