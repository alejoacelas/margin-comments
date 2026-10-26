// Regression tests for bugs found by review (see REVIEW.md).
import { closeSidebar, createThread, expect, FAKE, highlightTexts, selectBetween, selectText, setNetwork, setVersion, test, textCenter, uniquePath, waitForEmail } from './helpers';

test.afterEach(async ({ alice, bob }) => {
  expect([...alice.errors, ...bob.errors], 'host page console errors').toEqual([]);
});

test('checkboxes and forms in our UI activate exactly once', async ({ alice }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  await alice.openSidebar(a);
  const before = (await (await fetch(`${FAKE}/_test/sent?to=${encodeURIComponent(alice.email)}`)).json()).length;
  await a.locator('[data-testid=signin-email]').fill(alice.email);
  await a.locator('[data-testid=signin-send]').click();
  await expect(a.locator('[data-testid=signin-code]')).toBeVisible();
  await waitForEmail(alice.email, m => /sign-in code/.test(m.subject));
  await a.waitForTimeout(500);
  const after = (await (await fetch(`${FAKE}/_test/sent?to=${encodeURIComponent(alice.email)}`)).json()).length;
  expect(after - before).toBe(1);
  await a.locator('[data-testid=signin-code]').fill('000000');
  await a.locator('[data-testid=signin-verify]').click();
  await expect(a.locator('[data-testid=signin] .error')).toBeVisible();
  await closeSidebar(a);

  await alice.signIn(a);
  await alice.openSidebar(a);
  const box = a.locator('.sb-foot input[type=checkbox]');
  await expect(box).toBeChecked();
  await box.click();
  await expect(box).not.toBeChecked();
  await a.reload();
  await alice.openSidebar(a);
  await expect(a.locator('.sb-foot input[type=checkbox]')).not.toBeChecked();
});

test('switching threads never carries reply text over', async ({ alice }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  await alice.signIn(a);
  await createThread(a, 'Open annotation standard', 'Thread A');
  await createThread(a, 'Social highlights for friends', 'Thread B');
  const atA = await textCenter(a, 'Open annotation standard');
  await a.mouse.click(atA.x, atA.y);
  await expect(a.locator('[data-testid=thread-card] [data-testid=comment-body]').first()).toHaveText('Thread A');
  await a.locator('[data-testid=thread-card] [data-testid=reply-input]').fill('Intended for A');
  const atB = await textCenter(a, 'Social highlights for friends');
  await a.mouse.click(atB.x, atB.y);
  await expect(a.locator('[data-testid=thread-card] [data-testid=comment-body]').first()).toHaveText('Thread B');
  await expect(a.locator('[data-testid=thread-card] [data-testid=reply-input]')).toHaveValue('');
  // A's text is still waiting in A.
  const againA = await textCenter(a, 'Open annotation standard');
  await a.mouse.click(againA.x, againA.y);
  await expect(a.locator('[data-testid=thread-card] [data-testid=comment-body]').first()).toHaveText('Thread A');
  await expect(a.locator('[data-testid=thread-card] [data-testid=reply-input]')).toHaveValue('Intended for A');
});

test('a thread anchors when its text appears once on an otherwise quiet page', async ({ alice, bob }) => {
  const path = uniquePath('quiet');
  const a = await alice.open(path);
  await alice.signIn(a);
  await createThread(a, 'inserted once, a few seconds after load', 'Late and quiet');
  const b = await bob.open(path + '?late=1');
  await bob.signIn(b);
  await expect.poll(() => highlightTexts(b), { timeout: 15_000 }).toEqual(['inserted once, a few seconds after load']);
});

test('clicking a highlight works after the layout shifts', async ({ alice }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  await alice.signIn(a);
  await createThread(a, 'common in medieval manuscripts', 'Shift me');
  await a.keyboard.press('Escape');
  const before = await textCenter(a, 'medieval manuscripts');
  await a.mouse.click(before.x, before.y);
  await expect(a.locator('[data-testid=thread-card]')).toBeVisible();
  await a.keyboard.press('Escape');
  await a.evaluate(() => {
    const div = document.createElement('div');
    div.style.height = '200px';
    document.querySelector('main')!.prepend(div);
  });
  const after = await textCenter(a, 'medieval manuscripts');
  expect(Math.abs(after.y - before.y)).toBeGreaterThan(100);
  await a.waitForTimeout(600);
  await a.mouse.click(after.x, after.y);
  await expect(a.locator('[data-testid=thread-card] [data-testid=comment-body]')).toHaveText('Shift me');
});

test('selections spanning an inline script survive changes to the script', async ({ alice }) => {
  const path = uniquePath('inline-script');
  const a = await alice.open(path);
  await alice.signIn(a);
  await selectBetween(a, 'before the data island', 'and visible words');
  await a.locator('[data-testid=adder]').click();
  await a.locator('[data-testid=composer-input]').fill('Spans a script');
  await a.locator('[data-testid=composer-input]').press('Enter');
  await alice.openSidebar(a);
  const row = a.locator('[data-testid=sidebar-thread]');
  await expect(row).toContainText('before the data island and visible words');
  await expect(row).not.toContainText('build');
  await setVersion(path, 'inline-script-v2.html');
  await a.reload();
  await expect.poll(async () => (await highlightTexts(a)).length).toBe(1);
  await alice.openSidebar(a);
  await expect(a.locator('[data-testid=sidebar-thread]').getByText('Text not found')).toHaveCount(0);
  // The page's own checkbox still works normally.
  await a.locator('#pagebox').click();
  await expect(a.locator('#pagebox')).toBeChecked();
  await setVersion(path, null);
});

test('a reply draft stays recoverable when its thread is deleted', async ({ alice, bob }) => {
  const path = uniquePath('article');
  const b = await bob.open(path);
  await bob.signIn(b);
  await createThread(b, 'a well-annotated page', 'Bob will delete this too');
  const a = await alice.open(path);
  await alice.signIn(a);
  await alice.openSidebar(a);
  await a.locator('[data-testid=sidebar-thread]').click();
  await a.locator('[data-testid=sidebar-thread] [data-testid=reply-input]').fill('A long reply I typed but did not send');
  await a.waitForTimeout(700);
  const head = b.locator('[data-testid=thread-card] [data-testid=comment]').first();
  await head.hover();
  await head.locator('[data-testid=delete]').click();
  await head.locator('[data-testid=confirm-delete]').click();
  await expect(a.locator('[data-testid=sidebar-thread]')).toHaveCount(0);
  const draft = a.locator('[data-testid=draft-row]');
  await expect(draft).toContainText('A long reply I typed but did not send');
  await expect(draft).toContainText('was deleted');
});

test('clicks still hit highlights after a CSS transform moves the text', async ({ alice }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  await alice.signIn(a);
  await createThread(a, 'common in medieval manuscripts', 'Transform me');
  await a.keyboard.press('Escape');
  await a.evaluate(() => {
    (document.getElementById('p2') as HTMLElement).style.transform = 'translateY(120px)';
  });
  const at = await textCenter(a, 'medieval manuscripts');
  await a.mouse.click(at.x, at.y);
  await expect(a.locator('[data-testid=thread-card] [data-testid=comment-body]')).toHaveText('Transform me');
});

test('our buttons work on a page whose capture listeners swallow clicks', async ({ alice }) => {
  const path = uniquePath('keys');
  const a = await alice.open(path);
  await alice.signIn(a);
  await createThread(a, 'binds single-letter shortcuts', 'Clickable?');
  const before = await a.evaluate(() => (window as any).__pageClicks);
  await a.locator('[data-testid=thread-card] [data-testid=resolve]').click();
  await expect(a.locator('[data-testid=thread-card]')).toHaveCount(0);
  await alice.openSidebar(a);
  await a.locator('[data-testid=filter-resolved]').click();
  await expect(a.locator('[data-testid=sidebar-thread]')).toHaveCount(1);
  await a.locator('[data-testid=sidebar-thread]').click();
  await a.locator('[data-testid=sidebar-thread] [data-testid=reopen]').click();
  await a.locator('[data-testid=filter-open]').click();
  await expect(a.locator('[data-testid=sidebar-thread]')).toHaveCount(1);
  const box = a.locator('.sb-foot input[type=checkbox]');
  await box.click();
  await expect(box).not.toBeChecked();
  await box.click();
  await expect(box).toBeChecked();
  // The page never saw any of those clicks.
  expect(await a.evaluate(() => (window as any).__pageClicks)).toBe(before);
});

test("one account's unsent work never shows up for the next account on the same browser", async ({ alice }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  await alice.signIn(a);
  await setNetwork(true);
  await selectText(a, 'Footer text for the fixture page');
  await a.locator('[data-testid=adder]').click();
  await a.locator('[data-testid=composer-input]').fill("Alice's private unsent comment");
  await a.locator('[data-testid=composer-input]').press('Enter');
  await expect(a.locator('[data-testid=thread-card]').getByText('Saving…')).toBeVisible();
  await a.locator('[data-testid=thread-card] [data-testid=reply-input]').fill("Alice's half-typed reply");
  await a.waitForTimeout(700);
  await setNetwork(false);
  await alice.openSidebar(a);
  // Sign out and sign in as someone else in the same browser.
  await a.locator('[data-testid=signout]').click();
  const other = Object.assign(Object.create(Object.getPrototypeOf(alice)), alice, { email: `mallory-${Date.now()}@example.com` });
  await closeSidebar(a);
  await other.signIn(a);
  await alice.openSidebar(a);
  await expect(a.locator('[data-testid=sidebar]')).not.toContainText("Alice's private unsent comment");
  await expect(a.locator('[data-testid=sidebar]')).not.toContainText("Alice's half-typed reply");
  await expect(a.locator('[data-testid=draft-row]')).toHaveCount(0);
});

test('a thread selected in the sidebar has exactly one editor on the page', async ({ alice }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  await alice.signIn(a);
  await createThread(a, 'Open annotation standard', 'One editor please');
  await alice.openSidebar(a);
  await a.locator('[data-testid=sidebar-thread]').click();
  await expect(a.locator('[data-testid=reply-input]')).toHaveCount(1);
  // Clicking the highlight with the sidebar open selects it there too.
  await closeSidebar(a);
  await alice.openSidebar(a);
  const at = await textCenter(a, 'Open annotation standard');
  await a.mouse.click(at.x, at.y);
  await expect(a.locator('[data-testid=sidebar-thread].selected')).toHaveCount(1);
  await expect(a.locator('[data-testid=reply-input]')).toHaveCount(1);
});
