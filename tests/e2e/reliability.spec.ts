import { createThread, expect, highlightTexts, selectText, setNetwork, test, uniquePath } from './helpers';

test.afterEach(async ({ alice, bob }) => {
  await setNetwork(false);
  expect([...alice.errors, ...bob.errors], 'host page console errors').toEqual([]);
});

test('comments typed while offline are kept, survive a reload, and sync when back online', async ({ alice, bob }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  await alice.signIn(a);
  const b = await bob.open(path);
  await bob.signIn(b);

  await setNetwork(true);
  await selectText(a, 'Nested item describing threaded replies');
  await a.locator('[data-testid=adder]').click();
  await a.frameLocator('iframe[data-testid=composer-input-frame]').locator('[data-testid=composer-input]').fill('Written on a plane');
  await a.frameLocator('iframe[data-testid=composer-input-frame]').locator('[data-testid=composer-input]').press('Enter');
  const card = a.locator('[data-testid=thread-card]');
  await expect(card.locator('[data-testid=comment-body]')).toHaveText('Written on a plane');
  await expect(card.getByText('Saving…')).toBeVisible();
  await card.frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]').fill('And a follow-up, also offline');
  await card.frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]').press('Enter');
  await expect(card.locator('[data-testid=comment-body]')).toHaveText(['Written on a plane', 'And a follow-up, also offline']);
  await alice.openSidebar(a);
  await expect(a.locator('[data-testid=offline-status]')).toBeVisible();

  // Reload while still offline: the unsent thread is still there, highlighted.
  await a.reload();
  await expect.poll(() => highlightTexts(a)).toEqual(['Nested item describing threaded replies']);
  await alice.openSidebar(a);
  await expect(a.locator('[data-testid=sidebar-thread]')).toContainText('Saving…');

  // Back online: everything syncs, and Bob sees it.
  await setNetwork(false);
  await expect.poll(() => highlightTexts(b), { timeout: 30_000 }).toEqual(['Nested item describing threaded replies']);
  await bob.openSidebar(b);
  await b.locator('[data-testid=sidebar-thread]').click();
  await expect(b.locator('[data-testid=sidebar-thread] [data-testid=comment-body]')).toHaveText([
    'Written on a plane',
    'And a follow-up, also offline',
  ]);
  await expect(a.locator('[data-testid=sidebar-thread]')).not.toContainText('Saving…', { timeout: 30_000 });
});

test('unsent drafts survive closing the tab', async ({ alice }) => {
  const path = uniquePath('article');
  let a = await alice.open(path);
  await alice.signIn(a);
  await selectText(a, 'Social highlights for friends');
  await a.locator('[data-testid=adder]').click();
  await a.frameLocator('iframe[data-testid=composer-input-frame]').locator('[data-testid=composer-input]').pressSequentially('A thought I did not finish');
  await a.waitForTimeout(100);
  await a.close(); // no submit, no wait for the debounce

  a = await alice.open(path);
  await alice.openSidebar(a);
  const draft = a.locator('[data-testid=draft-row]');
  await expect(draft).toContainText('A thought I did not finish');
  await expect(draft).toContainText('Social highlights for friends');
  await draft.getByText('Continue').click();
  await expect(a.frameLocator('iframe[data-testid=composer-input-frame]').locator('[data-testid=composer-input]')).toHaveValue('A thought I did not finish');
  await a.frameLocator('iframe[data-testid=composer-input-frame]').locator('[data-testid=composer-input]').press('Enter');
  await expect(a.locator('[data-testid=draft-row]')).toHaveCount(0);
  await expect(a.locator('[data-testid=sidebar-thread]')).toContainText('A thought I did not finish');

  // Reply drafts too.
  await a.locator('[data-testid=sidebar-thread]').click();
  await a.locator('[data-testid=sidebar-thread]').frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]').fill('Half a reply');
  await a.waitForTimeout(600);
  await a.reload();
  await alice.openSidebar(a);
  await a.locator('[data-testid=sidebar-thread]').click();
  await expect(a.locator('[data-testid=sidebar-thread]').frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]')).toHaveValue('Half a reply');
});

test('a reply that can no longer be saved stays visible with its text', async ({ alice, bob }) => {
  const path = uniquePath('article');
  const b = await bob.open(path);
  await bob.signIn(b);
  await createThread(b, 'a well-annotated page', 'Bob will delete this');
  const a = await alice.open(path);
  await alice.signIn(a);
  await alice.openSidebar(a);
  await a.locator('[data-testid=sidebar-thread]').click();

  await setNetwork(true);
  await a.locator('[data-testid=sidebar-thread]').frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]').fill('My reply that will bounce');
  await a.locator('[data-testid=sidebar-thread]').frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]').press('Enter');

  // Bob deletes the thread meanwhile (his own connection is cut too, so do it after).
  await setNetwork(false);
  const head = b.locator('[data-testid=thread-card] [data-testid=comment]').first();
  await head.hover();
  await head.locator('[data-testid=delete]').click();
  await head.locator('[data-testid=confirm-delete]').click();

  const stranded = a.locator('[data-testid=stranded-row]');
  await expect(stranded).toContainText('My reply that will bounce', { timeout: 30_000 });
  await stranded.getByText('Discard').click();
  await expect(stranded).toHaveCount(0);
});

test('the service worker restarting loses nothing', async ({ alice }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  await alice.signIn(a);
  await createThread(a, 'Threads with email replies', 'Saved before the restart');
  await setNetwork(true);
  await a.locator('[data-testid=thread-card]').frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]').fill('Queued across the restart');
  await a.locator('[data-testid=thread-card]').frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]').press('Enter');
  await expect(a.locator('[data-testid=thread-card]').getByText('Saving…')).toBeVisible();

  // Kill the worker (Chrome does this whenever it's idle). In-memory state is gone.
  await alice.sw.evaluate(() => ((globalThis as any).__marker = 1));
  const session = await alice.context.newCDPSession(a);
  const { targetInfos } = await session.send('Target.getTargets');
  const target = targetInfos.find(t => t.type === 'service_worker' && t.url.endsWith('/background.js'))!;
  await session.send('Target.closeTarget', { targetId: target.targetId });
  await expect
    .poll(async () => {
      const w = alice.context.serviceWorkers().find(x => x.url().endsWith('/background.js'));
      return w ? await w.evaluate(() => (globalThis as any).__marker ?? 'fresh').catch(() => 'gone') : 'none';
    })
    .toBe('fresh');

  // Back online: the queued reply (persisted in storage) is sent; the page keeps working.
  await setNetwork(false);
  const card = a.locator('[data-testid=thread-card]');
  await expect(card.getByText('Saving…')).toHaveCount(0, { timeout: 30_000 });
  await card.frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]').fill('After the restart');
  await card.frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]').press('Enter');
  const fresh = await alice.open(path);
  await alice.openSidebar(fresh);
  await fresh.locator('[data-testid=sidebar-thread]').click();
  await expect(fresh.locator('[data-testid=sidebar-thread] [data-testid=comment-body]')).toHaveText([
    'Saved before the restart',
    'Queued across the restart',
    'After the restart',
  ]);
});
