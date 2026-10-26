/**
 * Smoke test against the deployed backend with the production build (dist/).
 * Not part of `npm test`; run with `npm run test:smoke` (needs ADMIN_TOKEN,
 * used to read sign-in codes from /admin/outbox while real email is off).
 */
import { chromium, expect, type Page, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const API = process.env.SMOKE_API ?? 'https://margin-comments.fly.dev';
const DIST = resolve('dist');
const PAGE = 'https://example.com/';

async function launch() {
  const dir = await mkdtemp(join(tmpdir(), 'mc-smoke-'));
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker');
  return { context, dir };
}

async function codeFor(email: string): Promise<string> {
  const auth = 'Basic ' + Buffer.from(`admin:${process.env.ADMIN_TOKEN}`).toString('base64');
  for (let i = 0; i < 30; i++) {
    const html = await (await fetch(`${API}/admin/outbox`, { headers: { authorization: auth } })).text();
    const block = html.split('class="mail"').find(b => b.includes(email.replace('@', '&#64;')) || b.includes(email));
    const m = block && /sign-in code: (\d{6})/.exec(block);
    if (m) return m[1];
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('no code in outbox');
}

async function signIn(context: import('@playwright/test').BrowserContext, page: Page, email: string) {
  const sw = context.serviceWorkers().find(w => w.url().endsWith('/background.js'))!;
  await page.bringToFront();
  await sw.evaluate(async u => {
    const tabs = await chrome.tabs.query({});
    await (globalThis as any).__marginTest.onActionClicked(tabs.find(t => t.url === u && t.active) ?? tabs.find(t => t.url === u));
  }, page.url());
  await page.locator('[data-testid=signin-email]').fill(email);
  await page.locator('[data-testid=signin-send]').click();
  await page.locator('[data-testid=signin-code]').fill(await codeFor(email));
  await page.locator('[data-testid=signin-verify]').click();
  await expect(page.locator('[data-testid=signout]')).toBeVisible();
  await page.locator('[data-testid=sidebar-close]').click();
}

test('production: sign in, comment, see it live in a second browser, clean up', async () => {
  test.skip(!process.env.ADMIN_TOKEN, 'ADMIN_TOKEN not set');
  test.setTimeout(120_000);
  const stamp = Date.now();
  const a = await launch();
  const b = await launch();
  try {
    const pa = await a.context.newPage();
    await pa.goto(PAGE);
    await expect(pa.locator('margin-comments-root')).toHaveCount(1);
    await signIn(a.context, pa, `smoke-a-${stamp}@example.com`);
    const pb = await b.context.newPage();
    await pb.goto(PAGE);
    await signIn(b.context, pb, `smoke-b-${stamp}@example.com`);

    await pa.evaluate(() => {
      const p = document.querySelector('p')!;
      const t = p.firstChild as Text;
      document.getSelection()!.setBaseAndExtent(t, 0, t, 30);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await pa.locator('[data-testid=adder]').click();
    const body = `Smoke test ${stamp}`;
    await pa.locator('[data-testid=composer-input]').fill(body);
    await pa.locator('[data-testid=composer-input]').press('Enter');
    await expect(pa.locator('[data-testid=thread-card]').getByText('Saving…')).toHaveCount(0, { timeout: 15_000 });

    // Live in the second browser.
    const highlights = (p: Page) =>
      p.evaluate(() => [...(CSS as any).highlights.entries()].filter(([n, h]: any) => n.startsWith('mc-') && h.size).length);
    await expect.poll(() => highlights(pb), { timeout: 15_000 }).toBeGreaterThan(0);

    // Clean up: delete the thread.
    const head = pa.locator('[data-testid=thread-card] [data-testid=comment]').first();
    await head.hover();
    await head.locator('[data-testid=delete]').click();
    await head.locator('[data-testid=confirm-delete]').click();
    await expect.poll(() => highlights(pb), { timeout: 15_000 }).toBe(0);
  } finally {
    await a.context.close();
    await b.context.close();
    await rm(a.dir, { recursive: true, force: true });
    await rm(b.dir, { recursive: true, force: true });
  }
});
