import { convert } from 'html-to-text';

/** Longer emails are cut (a reply posts at most a few comments' worth). */
const MAX_INPUT = 200_000;

/**
 * Extract just the new text from an email reply: drop quoted history
 * ("On … wrote:", Outlook headers, "> " lines) and signatures.
 *
 * All our own rules, each linear in the input: an earlier version also ran
 * email-reply-parser, whose regular expressions are quadratic on some inputs
 * (a long run of digits blocked the server for seconds) and which dropped
 * everything below a "---" line as a signature.
 */
export function extractReply(text: string | null, html: string | null): string {
  let body = text && text.trim() ? text.slice(0, MAX_INPUT) : html ? htmlToText(html.slice(0, MAX_INPUT * 5)) : '';
  body = body.slice(0, MAX_INPUT).replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
  body = cutQuotedHistory(body);
  let visible = cutSignatureDelimiter(body);
  visible = stripSignatureLines(visible);
  visible = stripSignOff(visible);
  return visible.split('\n').map(trimLineEnd).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Trailing spaces and tabs off a line, in a loop: `/[ \t]+$/` backtracks quadratically on long runs of spaces. */
function trimLineEnd(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  return line.slice(0, end);
}

/** RFC 3676: a line of exactly "-- " (or "--") starts the signature. */
function cutSignatureDelimiter(text: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex(l => /^--\s?$/.test(l));
  if (at <= 0) return text;
  const above = lines.slice(0, at).join('\n');
  return above.trim() ? above : text;
}

const SIGN_OFF = /^(best|best wishes|best regards|kind regards|warm regards|regards|thanks|thanks so much|many thanks|thank you|cheers|sincerely|all the best|warmly|talk soon|xo|xx)[,.!]?$/i;

/**
 * Drop a trailing sign-off block ("Thanks,\nBob" / "Best regards,\nBob\nAcme"):
 * a closing phrase on its own line followed by at most 3 short lines. Never
 * removes the whole message.
 */
function stripSignOff(text: string): string {
  const lines = text.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= Math.max(1, lines.length - 4); i--) {
    if (!SIGN_OFF.test(lines[i].trim())) continue;
    const after = lines.slice(i + 1).filter(l => l.trim());
    if (after.length > 3 || after.some(l => l.trim().length > 40)) continue;
    const before = lines.slice(0, i).join('\n').trim();
    if (before) return before;
  }
  return text;
}

// Tags where Outlook's quoted history starts in HTML (web, desktop, new
// Outlook): everything from there on is old content. Its history isn't inside
// one element, so skipping the header element alone would leave the previous
// message (our notification) behind. Bounded quotes (<blockquote>, as Apple
// Mail and Thunderbird use) aren't cut: they become "> " lines, so answers
// written below or between them are kept like in plain text. Tested against
// one tag at a time (bounded), never against the whole document.
const HTML_HISTORY_MARKERS: RegExp[] = [
  /^<div\b[^>]*\bid=["']?appendonsend\b/i,
  /^<div\b[^>]*\bid=["']?divRplyFwdMsg\b/i,
  /^<hr\b[^>]*\bid=["']?stopSpelling\b/i,
  /^<div\b[^>]*\bid=["']?mail-editor-reference-message-container\b/i,
  /^<div\b[^>]*\bclass=["']?[^"'>]*\bOutlookMessageHeader\b/i,
  /^<div\b[^>]*style=["'][^"']*border-top:\s*solid\s+#E1E1E1/i,
  /^<div\b[^>]*\bclass=["']?[^"'>]*\byahoo_quoted\b/i,
];

/**
 * One linear pass over the tags: cut at Outlook's history marker, and drop
 * document wrappers (doctype, html, head, body): a quoted message can be a
 * whole HTML document nested inside a <blockquote>, and nested wrappers make
 * the converter lift its content out of the quote. (Whole-document regexes
 * here were quadratic on malformed HTML.)
 */
function prepareHtml(html: string): string {
  const out: string[] = [];
  let inHead = false;
  // Quote nesting beyond a few levels is dropped (its text stays): each level
  // prefixes every line below it, so deep nesting multiplies the output.
  let quoteDepth = 0;
  const MAX_QUOTE_DEPTH = 8;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      if (!inHead) out.push(html.slice(i));
      break;
    }
    if (!inHead) out.push(html.slice(i, lt));
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) {
      if (!inHead) out.push(html.slice(lt));
      break;
    }
    const tag = html.slice(lt, Math.min(gt + 1, lt + 2000));
    if (HTML_HISTORY_MARKERS.some(re => re.test(tag))) break;
    const name = /^<\/?\s*([!a-z][a-z0-9-]*)/i.exec(tag)?.[1]?.toLowerCase();
    const closing = tag[1] === '/';
    if (name === 'head') inHead = !closing;
    else if (name === 'blockquote') {
      const depth = closing ? quoteDepth-- : ++quoteDepth;
      if (depth <= MAX_QUOTE_DEPTH && depth > 0 && !inHead) out.push(html.slice(lt, gt + 1));
      if (quoteDepth < 0) quoteDepth = 0;
    } else if (name !== '!doctype' && name !== 'html' && name !== 'body' && !inHead) out.push(html.slice(lt, gt + 1));
    i = gt + 1;
  }
  return out.join('');
}

function htmlToText(html: string): string {
  return convert(prepareHtml(html), {
    wordwrap: false,
    // Bounded work and output for hostile HTML (deep nesting, huge fan-out).
    limits: { maxDepth: 40, maxChildNodes: 5000, maxInputLength: MAX_INPUT * 5 },
    selectors: [
      // Keep where a link goes ("my proposal [https://…]"), unless the text is the URL.
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'div.gmail_signature', format: 'skip' },
      { selector: 'div#divRplyFwdMsg', format: 'skip' },
      { selector: 'div#appendonsend', format: 'skip' },
      { selector: 'div.yahoo_quoted', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'head', format: 'skip' },
    ],
  });
}

// "On … wrote:" headers (Gmail, Apple Mail, Thunderbird): the history below
// is quoted with ">", so unquoted lines among it are the sender's answers.
const WROTE_PATTERNS: RegExp[] = [
  // "On Mon, 26 Oct 2026 at 15:00, X <y> wrote:"
  /^\s*On\b.{0,400}\bwrote:\s*$/i,
  /^\s*Le\b.{0,400}\ba écrit\s*:\s*$/i,
  /^\s*El\b.{0,400}\bescribió:\s*$/i,
  /^\s*Am\b.{0,400}\bschrieb\b.{0,200}:\s*$/i,
  /^\s*Em\b.{0,400}\bescreveu:\s*$/i,
  /^\s*Il\b.{0,400}\bha scritto:\s*$/i,
];

// Separators after which everything is old content (Outlook and forwards
// include the previous message unquoted, and our notification contains a
// "> quote" line that mustn't be mistaken for quoting).
const SEPARATOR_PATTERNS: RegExp[] = [
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$/i,
  /^\s*_{10,}\s*$/,
  // Our own notification footer, if a client pasted it unquoted.
  /^\s*Reply to this email to respond in the thread/i,
  /^\s*You're receiving this because you (started|replied)/i,
];

function cutQuotedHistory(body: string): string {
  const lines = body.split('\n');
  const { cut, wrote } = findQuoteHeader(lines);
  const top = lines.slice(0, cut).filter(l => !/^\s*>/.test(l));
  if (cut === lines.length || !wrote) return top.join('\n');
  // After an "On … wrote:" header, text counts only when the history really
  // is quoted with ">": then unquoted lines among/after it are bottom-posted
  // or inline answers. Without ">" quoting (an unquoted forward) the text
  // after the header is old content.
  const after = lines.slice(cut + 1);
  const firstQuoted = after.findIndex(l => /^\s*>/.test(l));
  const answers = firstQuoted < 0 ? '' : cutQuotedHistory(after.slice(firstQuoted).filter(l => !/^\s*>/.test(l)).join('\n'));
  return [top.join('\n').trim(), answers.trim()].filter(Boolean).join('\n\n');
}

/** Where the quoted history starts, and whether it's an "On … wrote:" header. */
function findQuoteHeader(lines: string[]): { cut: number; wrote: boolean } {
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const joined = i + 1 < lines.length ? `${line} ${lines[i + 1]}` : line;
    if (WROTE_PATTERNS.some(re => re.test(line))) return { cut: i, wrote: true };
    // Header split across two lines by the client's wrapping.
    if (/^\s*On\b/i.test(line) && !/wrote:\s*$/i.test(line) && /\bwrote:\s*$/i.test(joined) && joined.length < 500) return { cut: i, wrote: true };
    if (SEPARATOR_PATTERNS.some(re => re.test(line))) {
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
  return { cut, wrote: false };
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
