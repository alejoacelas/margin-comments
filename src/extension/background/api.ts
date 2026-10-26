declare const __API_URL__: string;

export const API_URL: string = __API_URL__;
export const WS_URL = API_URL.replace(/^http/, 'ws') + '/api/live';

/** Network failure, timeout or 5xx/429: retrying later may succeed. */
export class TransientError extends Error {
  constructor(
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** The server rejected the request; retrying as-is won't help. */
export class RequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  method: string,
  path: string,
  opts: { token?: string | null; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method,
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      cache: 'no-store',
    });
  } catch (err) {
    throw new TransientError(`network: ${(err as Error).message}`);
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    // empty or non-JSON body
  }
  if (res.ok) return json as T;
  if (res.status >= 500 || res.status === 429 || res.status === 408) {
    const retryAfter = Number(res.headers.get('retry-after'));
    throw new TransientError(json?.message ?? `HTTP ${res.status}`, Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined);
  }
  throw new RequestError(res.status, json?.error ?? 'error', json?.message ?? `HTTP ${res.status}`);
}
