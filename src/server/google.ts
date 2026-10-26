import { createHash } from 'node:crypto';
import type { Config } from './config';
import { newToken, sha256 } from './crypto';
import type { DB } from './db';

/**
 * Google sign-in (OAuth 2 authorization code + PKCE, server side).
 *
 * The extension opens /api/auth/google/start via chrome.identity.launchWebAuthFlow
 * with its chromiumapp.org redirect URL. Google redirects back to this server,
 * which creates a session and finally redirects to the extension's URL with
 * the session token in the fragment. Only configured extension IDs may
 * receive tokens.
 */

const STATE_TTL_MS = 10 * 60_000;

export function isAllowedExtensionRedirect(config: Config, redirectUri: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  const m = /^([a-p]{32})\.chromiumapp\.org$/.exec(url.hostname);
  if (url.protocol !== 'https:' || !m || url.username || url.password || url.port) return false;
  return config.extensionIds.includes(m[1]);
}

export function callbackUrl(config: Config): string {
  return `${config.publicUrl}/api/auth/google/callback`;
}

export function startGoogle(db: DB, config: Config, redirectUri: string): string {
  const state = newToken(24);
  const verifier = newToken(32);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO oauth_states (state_hash, redirect_uri, code_verifier, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    sha256(state),
    redirectUri,
    verifier,
    new Date(now).toISOString(),
    new Date(now + STATE_TTL_MS).toISOString(),
  );
  const url = new URL(config.google.authUrl);
  url.searchParams.set('client_id', config.google.clientId);
  url.searchParams.set('redirect_uri', callbackUrl(config));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

/** Consume a state (one-time). Returns the stored redirect and PKCE verifier. */
export function consumeState(db: DB, state: string): { redirectUri: string; verifier: string } | null {
  const hash = sha256(state);
  const row = db.prepare('SELECT * FROM oauth_states WHERE state_hash = ?').get(hash) as
    | { redirect_uri: string; code_verifier: string; expires_at: string }
    | undefined;
  if (!row) return null;
  db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').run(hash);
  if (Date.parse(row.expires_at) < Date.now()) return null;
  return { redirectUri: row.redirect_uri, verifier: row.code_verifier };
}

export type GoogleProfile = { sub: string; email: string; name: string | null; hd: string | null };

/** Is Google the authority for this address? (Gmail, or a matching Workspace domain.) */
export function googleIsAuthoritative(email: string, hd: string | null): boolean {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (domain === 'gmail.com' || domain === 'googlemail.com') return true;
  return !!hd && hd.toLowerCase() === domain;
}

export async function exchangeCode(config: Config, code: string, verifier: string): Promise<GoogleProfile> {
  const tokenRes = await fetch(config.google.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: callbackUrl(config),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed (${tokenRes.status})`);
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) throw new Error('no access token');
  const infoRes = await fetch(config.google.userinfoUrl, {
    headers: { Authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!infoRes.ok) throw new Error(`userinfo failed (${infoRes.status})`);
  const info = (await infoRes.json()) as { sub?: string; email?: string; email_verified?: boolean | string; name?: string; hd?: string };
  const verified = info.email_verified === true || info.email_verified === 'true';
  if (!info.sub || !info.email || !verified) throw new Error('Google account email is not verified');
  return { sub: info.sub, email: info.email, name: info.name ?? null, hd: typeof info.hd === 'string' ? info.hd : null };
}
