import { type BrowserContext, chromium, expect, type Page, test as base, type Worker } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PORTS } from '../../playwright.config';

export const EXT_PATH = resolve('build/ext-test');
export const FIXTURES = `http://localhost:${PORTS.fixtures}`;
export const FAKE = `http://localhost:${PORTS.fakeResend}`;
export const API = `http://localhost:${PORTS.proxy}`;
export const BACKEND = `http://127.0.0.1:${PORTS.backend}`;

export type SentEmail = {
  id: string;
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  reply_to?: string;
  headers?: Record<string, string>;
  idempotencyKey: string | null;
};

/** A browser profile with the extension loaded: one "user". */
export class Person {
  readonly errors: string[] = [];
  private pages: Page[] = [];

  constructor(
    readonly name: string,
    readonly email: string,
    readonly context: BrowserContext,
    private firstWorker: Worker,
    private dir: string,
  ) {}

  /** The current background worker (it changes when Chrome restarts it). */
  get sw(): Worker {
    return this.context.serviceWorkers().find(w => w.url().endsWith('/background.js')) ?? this.firstWorker;
  }

  static async launch(name: string, email: string): Promise<Person> {
    const dir = await mkdtemp(join(tmpdir(), `mc-${name}-`));
    const context = await chromium.launchPersistentContext(dir, {
      channel: 'chromium',
      headless: !process.env.HEADED,
      viewport: { width: 1280, height: 860 },
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
    });
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker');
    return new Person(name, email, context, sw, dir);
  }

  /** Open a page and record any host-page console errors. */
  async open(path: string): Promise<Page> {
    const page = this.pages.find(p => !p.isClosed() && p.url() === 'about:blank') ?? (await this.context.newPage());
    page.on('console', msg => {
      if (msg.type() === 'error') this.errors.push(`[${this.name}] console: ${msg.text()} @ ${msg.location().url}`);
    });
    page.on('pageerror', err => this.errors.push(`[${this.name}] pageerror: ${err.message}`));
    this.pages.push(page);
    await page.goto(path.startsWith('http') ? path : FIXTURES + path);
    await waitForExtension(page);
    return page;
  }

  /** Simulate a click on the toolbar button for this page's tab. */
  async clickToolbar(page: Page) {
    const url = page.url();
    // Wake the worker if Chrome stopped it, like a real click would.
    if (!this.context.serviceWorkers().some(w => w.url().endsWith('/background.js'))) await this.context.waitForEvent('serviceworker');
    await page.bringToFront();
    await this.sw.evaluate(async u => {
      const tabs = await chrome.tabs.query({});
      const matching = tabs.filter(t => t.url === u);
      const tab = matching.find(t => t.active) ?? matching[0];
      if (!tab) throw new Error(`no tab for ${u}`);
      await (globalThis as any).__marginTest.onActionClicked(tab);
    }, url);
  }

  async openSidebar(page: Page) {
    if (await page.locator('[data-testid=sidebar]').isVisible()) return;
    await this.clickToolbar(page);
    try {
      await expect(page.locator('[data-testid=sidebar]')).toBeVisible({ timeout: 4000 });
    } catch (err) {
      const diag = await this.sw
        .evaluate(async u => {
          const tabs = await chrome.tabs.query({});
          return { tabs: tabs.map(t => `${t.id} ${t.active} ${t.url}`), debug: (globalThis as any).__marginTest.debug?.() };
        }, page.url())
        .catch(e => String(e));
      console.log('[openSidebar diag]', JSON.stringify(diag), 'roots', await page.locator('margin-comments-root').count(), 'workers', this.context.serviceWorkers().length);
      throw err;
    }
  }

  /** Sign in through the real email flow (code typed into the sidebar). */
  async signIn(page: Page) {
    await this.openSidebar(page);
    const since = Date.now();
    await page.locator('[data-testid=signin-email]').fill(this.email);
    await page.locator('[data-testid=signin-send]').click();
    await expect(page.locator('[data-testid=signin-code]')).toBeVisible();
    const mail = await waitForEmail(this.email, m => /sign-in code/.test(m.subject), since);
    const code = /(\d{6})/.exec(mail.subject)![1];
    await page.locator('[data-testid=signin-code]').fill(code);
    await page.locator('[data-testid=signin-verify]').click();
    await expect(page.locator('[data-testid=signout]')).toBeVisible();
    await page.locator('[data-testid=sidebar-close]').click();
  }

  async close() {
    await this.context.close();
    await rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function waitForExtension(page: Page) {
  await expect(page.locator('margin-comments-root')).toHaveCount(1, { timeout: 10_000 });
}

/** Select `text` on the page (it may span several elements). */
export async function selectText(page: Page, text: string, occurrence = 0) {
  await page.evaluate(
    ({ text, occurrence }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      let all = '';
      const starts: number[] = [];
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        if (n.parentElement?.closest('script,style')) continue;
        starts.push(all.length);
        nodes.push(n);
        all += n.data;
      }
      let at = -1;
      for (let i = 0; i <= occurrence; i++) {
        at = all.indexOf(text, at + 1);
        if (at < 0) throw new Error(`text not found: ${text}`);
      }
      const locate = (offset: number, preferEnd: boolean) => {
        for (let i = 0; i < nodes.length; i++) {
          const end = starts[i] + nodes[i].data.length;
          if (offset < end || (preferEnd && offset === end)) return { node: nodes[i], offset: offset - starts[i] };
        }
        const last = nodes[nodes.length - 1];
        return { node: last, offset: last.data.length };
      };
      const a = locate(at, false);
      const b = locate(at + text.length, true);
      (a.node.parentElement as Element).scrollIntoView({ block: 'center' });
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      sel.setBaseAndExtent(a.node, a.offset, b.node, b.offset);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    },
    { text, occurrence },
  );
}

/** A fresh URL for a fixture page, so each test has its own threads. */
export function uniquePath(file: string, opts: { csp?: boolean } = {}): string {
  return `${opts.csp ? '/csp' : ''}/u/${Math.random().toString(36).slice(2, 10)}/${file}`;
}

/** Viewport center of the first occurrence of `text` (may span elements). */
export async function textCenter(page: Page, text: string, occurrence = 0): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ text, occurrence }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      const starts: number[] = [];
      let all = '';
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        if (n.parentElement?.closest('script,style')) continue;
        starts.push(all.length);
        nodes.push(n);
        all += n.data;
      }
      let at = -1;
      for (let i = 0; i <= occurrence; i++) at = all.indexOf(text, at + 1);
      if (at < 0) throw new Error(`text not found: ${text}`);
      const idx = nodes.findIndex((n, i) => at < starts[i] + n.data.length);
      const r = document.createRange();
      r.setStart(nodes[idx], at - starts[idx]);
      r.setEnd(nodes[idx], Math.min(nodes[idx].data.length, at - starts[idx] + Math.min(text.length, 6)));
      r.startContainer.parentElement?.scrollIntoView({ block: 'center' });
      const rect = r.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    },
    { text, occurrence },
  );
}

/** Select from the start of `from` to the end of `to` (e.g. across list items). */
export async function selectBetween(page: Page, from: string, to: string) {
  await page.evaluate(
    ({ from, to }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let start: { node: Text; offset: number } | null = null;
      let end: { node: Text; offset: number } | null = null;
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        if (!start) {
          const i = n.data.indexOf(from);
          if (i >= 0) start = { node: n, offset: i };
        }
        if (start) {
          const j = n.data.indexOf(to);
          if (j >= 0) {
            end = { node: n, offset: j + to.length };
            break;
          }
        }
      }
      if (!start || !end) throw new Error('not found');
      (start.node.parentElement as Element).scrollIntoView({ block: 'center' });
      document.getSelection()!.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    },
    { from, to },
  );
}

/** Select text and start a thread with `body`. */
export async function createThread(page: Page, text: string, body: string, occurrence = 0) {
  await selectText(page, text, occurrence);
  await page.locator('[data-testid=adder]').click();
  const input = page.locator('[data-testid=composer-input]');
  await expect(input).toBeVisible();
  await input.fill(body);
  await input.press('Enter');
  await expect(page.locator('[data-testid=thread-card] [data-testid=comment-body]').first()).toHaveText(body);
}

export async function fakeSent(to?: string): Promise<SentEmail[]> {
  const res = await fetch(`${FAKE}/_test/sent${to ? `?to=${encodeURIComponent(to)}` : ''}`);
  return res.json();
}

export async function waitForEmail(to: string, pred: (m: SentEmail) => boolean, sinceMs = 0, timeout = 15_000): Promise<SentEmail> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const mails = await fakeSent(to);
    const hit = mails.find(m => pred(m) && Date.parse((m as any).created_at) >= sinceMs - 1000);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`no email to ${to} matching; got ${mails.map(m => m.subject).join(' | ')}`);
    await new Promise(r => setTimeout(r, 200));
  }
}

export async function setNetwork(down: boolean) {
  await fetch(`${FIXTURES}/_test/network`, { method: 'POST', body: JSON.stringify({ down }) });
}

export async function setVersion(path: string, file: string | null) {
  await fetch(`${FIXTURES}/_test/version`, { method: 'POST', body: JSON.stringify({ path, file }) });
}

/** Highlights currently painted, read from the CSS highlight registry. */
export async function highlightTexts(page: Page): Promise<string[]> {
  // The registry is per document, so the main world sees our highlights too.
  return page.evaluate(() => {
    const out: string[] = [];
    for (const [name, hl] of (CSS as any).highlights as Map<string, Set<Range>>) {
      if (!String(name).startsWith('mc-') || String(name).startsWith('mc-draft')) continue;
      for (const r of hl) out.push(r.toString().replace(/\s+/g, ' ').trim());
    }
    return out.sort();
  });
}

export const test = base.extend<{ alice: Person; bob: Person }>({
  alice: async ({}, use, testInfo) => {
    const p = await Person.launch('alice', `alice-${testInfo.testId.slice(0, 8)}-${Date.now()}@example.com`);
    await use(p);
    await p.close();
  },
  bob: async ({}, use, testInfo) => {
    const p = await Person.launch('bob', `bob-${testInfo.testId.slice(0, 8)}-${Date.now()}@example.com`);
    await use(p);
    await p.close();
  },
});

export { expect };
