import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { __API_URL__?: string }).__API_URL__ = 'https://api.test';

describe('extension api()', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a success whose body is cut off is a transient error (the write is retried)', async () => {
    const { api, TransientError } = await import('../../src/extension/background/api');
    vi.stubGlobal('fetch', async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"thread":'));
            c.error(new TypeError('network connection lost'));
          },
        }),
        { status: 200 },
      ),
    );
    await expect(api('POST', '/api/threads', { body: {} })).rejects.toBeInstanceOf(TransientError);
    vi.stubGlobal('fetch', async () => new Response('<html>proxy error</html>', { status: 200 }));
    await expect(api('POST', '/api/threads', { body: {} })).rejects.toBeInstanceOf(TransientError);
    vi.stubGlobal('fetch', async () => new Response('{"ok":true}', { status: 200 }));
    await expect(api('POST', '/api/threads', { body: {} })).resolves.toEqual({ ok: true });
  });
});
