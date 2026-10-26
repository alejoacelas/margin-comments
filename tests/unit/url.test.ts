import { describe, expect, it } from 'vitest';
import { normalizeUrl, pageIdentity, pageKey, threadIdFromHash, threadIdFromUrl, threadLink } from '../../src/shared/url';

describe('normalizeUrl / pageKey', () => {
  it('strips tracking params, fragments, credentials and sorts the query', () => {
    expect(normalizeUrl('https://user:pw@Example.com/a/b?utm_source=x&b=2&fbclid=abc&a=1&gclid=z#section')).toBe('https://example.com/a/b?a=1&b=2');
    expect(pageKey('http://Example.com/a/?utm_medium=email#top')).toBe('example.com/a');
    expect(pageKey('https://example.com/')).toBe('example.com/');
    expect(pageKey('https://example.com')).toBe('example.com/');
  });

  it('keeps meaningful params and hash routes', () => {
    expect(pageKey('https://github.com/o/r/blob/main/README.md?ref=dev')).toBe('github.com/o/r/blob/main/README.md?ref=dev');
    expect(pageKey('https://app.example/#/doc/42?x=1')).toBe('app.example/#/doc/42?x=1');
    expect(pageKey('https://news.ycombinator.com/item?id=123')).toBe('news.ycombinator.com/item?id=123');
  });

  it('strips host-specific referral params only on that host', () => {
    expect(pageKey('https://foo.substack.com/p/post?r=abc&s=r&utm_campaign=post')).toBe('foo.substack.com/p/post');
    expect(pageKey('https://example.com/p?r=abc')).toBe('example.com/p?r=abc');
  });

  it('treats http and https the same and keeps non-default ports', () => {
    expect(pageKey('http://example.com/x')).toBe(pageKey('https://example.com/x'));
    expect(pageKey('http://localhost:8080/x')).toBe('localhost:8080/x');
  });

  it('rejects non-web URLs', () => {
    expect(normalizeUrl('chrome://extensions')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });
});

describe('pageIdentity', () => {
  it('prefers the canonical link and keeps the location as an alternate key', () => {
    const id = pageIdentity('https://m.example.com/story/1?utm_source=tw', 'https://www.example.com/story/1');
    expect(id?.keys).toEqual(['www.example.com/story/1', 'm.example.com/story/1']);
    expect(id?.url).toBe('https://m.example.com/story/1');
  });

  it('resolves relative canonicals and ignores ones that point every page at the root', () => {
    expect(pageIdentity('https://example.com/a/b', '/a/b?utm_source=x')?.keys).toEqual(['example.com/a/b']);
    expect(pageIdentity('https://example.com/a/b', 'https://example.com/')?.keys).toEqual(['example.com/a/b']);
    expect(pageIdentity('https://example.com/', 'https://example.com/')?.keys).toEqual(['example.com/']);
  });
});

describe('thread links', () => {
  it('round-trips the thread id through the fragment', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const link = threadLink('https://example.com/a?b=1', id);
    expect(link).toBe(`https://example.com/a?b=1#margin-comments=${id}`);
    expect(threadIdFromHash(new URL(link).hash)).toBe(id);
    expect(threadIdFromHash('#margin-comments=nope')).toBeNull();
  });
});

describe('hash-routed apps', () => {
  it("ignore a shell canonical that would merge routes", () => {
    const one = pageIdentity('https://app.test/app#/one', 'https://app.test/app');
    const two = pageIdentity('https://app.test/app#/two', 'https://app.test/app');
    expect(one?.keys).toEqual(['app.test/app#/one']);
    expect(two?.keys).toEqual(['app.test/app#/two']);
  });
  it('thread links keep the route and still carry the thread id', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const link = threadLink('https://app.test/app#/article/7', id);
    expect(new URL(link).hash).toBe('#/article/7');
    expect(threadIdFromUrl(link)).toBe(id);
    expect(pageKey(link)).toBe('app.test/app#/article/7');
    expect(threadIdFromUrl(`https://x.test/a#margin-comments=${id}`)).toBe(id);
    expect(threadIdFromUrl('https://x.test/a?margin-comments=nope')).toBeNull();
  });
});

describe('uuid', () => {
  it('makes v4 UUIDs without crypto.randomUUID', async () => {
    const { uuid } = await import('../../src/shared/id');
    const ids = new Set(Array.from({ length: 1000 }, () => uuid()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
