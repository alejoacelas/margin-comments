/**
 * URL normalization shared by the extension and the server.
 *
 * Threads are keyed by a "page key": a scheme-less, tracking-free form of the
 * page URL. A page can have two keys (its <link rel=canonical> and its own
 * location); threads are stored under the first and found by either, so a
 * canonical tag that appears late or disagrees with the address bar never
 * hides existing threads.
 */

/** Exact query parameter names that only carry tracking/attribution data. */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'igsh',
  'yclid',
  'twclid',
  'ttclid',
  'li_fat_id',
  '_hsenc',
  '_hsmi',
  '__hssc',
  '__hstc',
  '__hsfp',
  'hsctatracking',
  'mkt_tok',
  'oly_anon_id',
  'oly_enc_id',
  'vero_conv',
  'vero_id',
  'wickedid',
  'rb_clickid',
  's_cid',
  '_ga',
  '_gl',
  'ref_src',
  'ref_url',
  'ncid',
  'cmpid',
  'spm',
  'scid',
  'sref',
  'triedredirect',
  'share_id',
  '__s',
]);

/** Parameter name prefixes that only carry tracking data. */
const TRACKING_PREFIXES = ['utm_', 'pk_', 'mtm_', 'hsa_', 'oly_', 'ga_'];

/** Hosts where a short referral parameter is pure tracking. */
const HOST_SPECIFIC_PARAMS: Array<[RegExp, string[]]> = [
  [/(^|\.)substack\.com$/, ['r', 's']],
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/, ['si', 'feature', 'pp']],
  [/(^|\.)twitter\.com$|(^|\.)x\.com$/, ['s', 't']],
  [/(^|\.)medium\.com$/, ['source', 'sk']],
  [/(^|\.)linkedin\.com$/, ['trk', 'trackingid', 'lipi']],
];

export function isTrackingParam(name: string, host = ''): boolean {
  const lower = name.toLowerCase();
  if (TRACKING_PARAMS.has(lower)) return true;
  if (TRACKING_PREFIXES.some(p => lower.startsWith(p))) return true;
  for (const [pattern, names] of HOST_SPECIFIC_PARAMS) {
    if (pattern.test(host) && names.includes(lower)) return true;
  }
  return false;
}

/** Fragments that encode a client-side route (hash routing) are kept. */
function isRouteFragment(hash: string): boolean {
  return /^#!?\//.test(hash) || /^#!/.test(hash);
}

/**
 * Clean a URL: http(s) only, no credentials, no tracking parameters, sorted
 * query, no fragment (unless it is a hash route). Returns null for URLs that
 * can't carry threads (chrome://, about:, data:, etc.).
 */
export function normalizeUrl(raw: string, base?: string): string | null {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.username = '';
  url.password = '';
  url.hostname = url.hostname.replace(/\.$/, '');

  const kept: Array<[string, string]> = [];
  for (const [k, v] of url.searchParams) {
    if (!isTrackingParam(k, url.hostname)) kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  url.search = '';
  for (const [k, v] of kept) url.searchParams.append(k, v);

  if (!isRouteFragment(url.hash)) url.hash = '';
  return url.toString();
}

/**
 * Page key: host + path (+ query, + hash route), without scheme or trailing
 * slash. `http://Example.com/a/?utm_source=x#top` -> `example.com/a`.
 */
export function pageKey(raw: string, base?: string): string | null {
  const normalized = normalizeUrl(raw, base);
  if (!normalized) return null;
  const url = new URL(normalized);
  let path = url.pathname;
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path === '') path = '/';
  const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  return `${host}${path}${url.search}${url.hash}`;
}

export type PageIdentity = {
  /** Cleaned URL of the page as the user sees it (used for links back). */
  url: string;
  /** Cleaned canonical URL, if the page declares a usable one. */
  canonicalUrl: string | null;
  /** Page keys to query, most authoritative first (1 or 2 entries). */
  keys: string[];
};

/**
 * Decide which keys identify a page, given its location and the href of its
 * `<link rel=canonical>` (if any). Broken canonicals that point every page at
 * the site root are ignored.
 */
export function pageIdentity(
  locationHref: string,
  canonicalHref?: string | null,
): PageIdentity | null {
  const url = normalizeUrl(locationHref);
  const locationKey = pageKey(locationHref);
  if (!url || !locationKey) return null;

  let canonicalUrl: string | null = null;
  let canonicalKey: string | null = null;
  if (canonicalHref) {
    const c = normalizeUrl(canonicalHref, locationHref);
    const k = c ? pageKey(c) : null;
    if (c && k) {
      const cPath = new URL(c).pathname;
      const lPath = new URL(url).pathname;
      const pointsAtRoot = (cPath === '/' || cPath === '') && lPath !== '/' && lPath !== '';
      if (!pointsAtRoot) {
        canonicalUrl = c;
        canonicalKey = k;
      }
    }
  }

  const keys = canonicalKey && canonicalKey !== locationKey ? [canonicalKey, locationKey] : [locationKey];
  return { url, canonicalUrl, keys };
}

/** Max length of a page key we accept (keys longer than this are truncated by clients). */
export const MAX_PAGE_KEY_LENGTH = 2048;

export function isValidPageKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= MAX_PAGE_KEY_LENGTH && !/\s/.test(key);
}

/** Fragment used in email links to open a thread on page load. */
export const THREAD_FRAGMENT_PREFIX = 'margin-comments=';

export function threadLink(pageUrl: string, threadId: string): string {
  const url = new URL(pageUrl);
  if (url.hash && isRouteFragment(url.hash)) return url.toString();
  url.hash = THREAD_FRAGMENT_PREFIX + threadId;
  return url.toString();
}

export function threadIdFromHash(hash: string): string | null {
  const m = /^#margin-comments=([0-9a-f-]{36})$/i.exec(hash);
  return m ? m[1].toLowerCase() : null;
}
