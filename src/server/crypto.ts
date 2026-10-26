import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32, lowercase, no padding (safe in email local parts). */
export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.toLowerCase()) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function uuidToBase32(uuid: string): string {
  return base32Encode(Buffer.from(uuid.replace(/-/g, ''), 'hex'));
}

export function base32ToUuid(s: string): string | null {
  if (s.length !== 26) return null;
  const buf = base32Decode(s);
  if (!buf || buf.length !== 16) return null;
  const hex = buf.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** User ids: 12 base32 chars (60 bits). Short enough for reply addresses. */
export function newUserId(): string {
  return base32Encode(randomBytes(8)).slice(0, 12);
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function hmac(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const ab = typeof a === 'string' ? Buffer.from(a) : a;
  const bb = typeof b === 'string' ? Buffer.from(b) : b;
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Deterministic UUID (v4 layout) derived from a string; used for idempotent ids. */
export function uuidFrom(namespace: string, value: string): string {
  const h = createHash('sha256').update(`${namespace}:${value}`).digest();
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
