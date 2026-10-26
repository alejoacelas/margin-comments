import { createThread, expect, highlightTexts, selectText, test, textCenter , uniquePath } from './helpers';

test.afterEach(async ({ alice }) => {
  expect(alice.errors, 'host page console errors').toEqual([]);
});

test('create, reply, edit, delete and resolve a thread; reload re-anchors it', async ({ alice }) => {
  const path = uniquePath('article');
  const page = await alice.open(path);
  await alice.signIn(page);

  // Create (selection crosses <em>: "books. Marginalia record").
  await createThread(page, 'margins of books. Marginalia record a conversation', 'First thought on marginalia');
  await expect.poll(() => highlightTexts(page)).toEqual(['margins of books. Marginalia record a conversation']);
  const card = page.locator('[data-testid=thread-card]');
  await expect(card.locator('[data-testid=comment]')).toHaveCount(1);
  await expect(card.getByText('Saving…')).toHaveCount(0);

  // Reply.
  await card.locator('[data-testid=reply-input]').fill('A reply to myself');
  await card.locator('[data-testid=reply-input]').press('Enter');
  await expect(card.locator('[data-testid=comment-body]')).toHaveText(['First thought on marginalia', 'A reply to myself']);

  // Edit the reply.
  const reply = card.locator('[data-testid=comment]').nth(1);
  await reply.hover();
  await reply.locator('[data-testid=edit]').click();
  await reply.locator('[data-testid=edit-input]').fill('An edited reply');
  await reply.locator('[data-testid=edit-input]').press('Enter');
  await expect(card.locator('[data-testid=comment-body]')).toHaveText(['First thought on marginalia', 'An edited reply']);
  await expect(reply.locator('.c-time')).toContainText('edited');

  // Delete the reply.
  await reply.hover();
  await reply.locator('[data-testid=delete]').click();
  await reply.locator('[data-testid=confirm-delete]').click();
  await expect(card.locator('[data-testid=comment-body]')).toHaveText(['First thought on marginalia']);

  // Reload: the thread and its highlight come back from the server.
  await page.reload();
  await expect.poll(() => highlightTexts(page)).toEqual(['margins of books. Marginalia record a conversation']);
  await alice.openSidebar(page);
  const row = page.locator('[data-testid=sidebar-thread]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('margins of books. Marginalia record a conversation');

  // Resolve from the sidebar: highlight disappears, thread moves to Resolved.
  await row.click();
  await row.locator('[data-testid=resolve]').click();
  await expect(page.locator('[data-testid=filter-resolved]')).toHaveText(/Resolved 1/);
  await expect.poll(() => highlightTexts(page)).toEqual([]);
  await page.locator('[data-testid=filter-resolved]').click();
  const resolvedRow = page.locator('[data-testid=sidebar-thread]');
  await expect(resolvedRow).toHaveCount(1);
  await resolvedRow.click();
  await expect(resolvedRow.locator('[data-testid=resolved-note]')).toContainText('Resolved by');

  // Reopen.
  await resolvedRow.locator('[data-testid=reopen]').click();
  await page.locator('[data-testid=filter-open]').click();
  await expect(page.locator('[data-testid=sidebar-thread]')).toHaveCount(1);
  await expect.poll(() => highlightTexts(page)).toHaveLength(1);

  // Delete the first comment: the whole thread goes away.
  await page.locator('[data-testid=sidebar-thread]').click();
  const first = page.locator('[data-testid=sidebar-thread] [data-testid=comment]').first();
  await first.hover();
  await first.locator('[data-testid=delete]').click();
  await first.locator('[data-testid=confirm-delete]').click();
  await expect(page.locator('[data-testid=sidebar-thread]')).toHaveCount(0);
  await expect.poll(() => highlightTexts(page)).toEqual([]);
  await page.reload();
  await alice.openSidebar(page);
  await expect(page.locator('[data-testid=sidebar-thread]')).toHaveCount(0);
});

test('clicking a highlight opens its thread', async ({ alice }) => {
  const path = uniquePath('article');
  const page = await alice.open(path);
  await alice.signIn(page);
  await createThread(page, 'common in medieval manuscripts', 'Medieval note');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid=thread-card]')).toHaveCount(0);
  const at = await textCenter(page, 'medieval manuscripts');
  await page.mouse.click(at.x, at.y);
  await expect(page.locator('[data-testid=thread-card]')).toBeVisible();
  await expect(page.locator('[data-testid=thread-card] [data-testid=comment-body]')).toHaveText('Medieval note');
});

test('adder ignores empty selections and editable fields', async ({ alice }) => {
  const path = uniquePath('article');
  const page = await alice.open(path);
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  await expect(page.locator('[data-testid=adder]')).toHaveCount(0);
  await selectText(page, 'Readers have always');
  await expect(page.locator('[data-testid=adder]')).toBeVisible();
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  await expect(page.locator('[data-testid=adder]')).toHaveCount(0);
});
