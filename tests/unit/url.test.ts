import { describe, expect, it } from 'vitest';
import { normalizeUrl, pageIdentity, pageKey, threadIdFromHash, threadLink } from '../../src/shared/url';

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
