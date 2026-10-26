import { closeSidebar, createThread, expect, selectText, test, uniquePath } from './helpers';

// Not an assertion test: captures the UI for visual review (test-results/screens).
test('capture UI screenshots', async ({ alice, bob }) => {
  const path = uniquePath('article');
  const page = await alice.open(path);
  await alice.openSidebar(page);
  await page.screenshot({ path: 'test-results/screens/0-signin.png' });
  await closeSidebar(page);
  await alice.signIn(page);
  await selectText(page, 'Readers have always written in the margins of books.');
  await expect(page.locator('[data-testid=adder]')).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/1-adder.png' });
  await page.locator('[data-testid=adder]').click();
  await page.locator('[data-testid=composer-input]').fill('Margins are where the real reading happens.');
  await page.screenshot({ path: 'test-results/screens/2-composer.png' });
  await page.locator('[data-testid=composer-input]').press('Enter');
  await expect(page.locator('[data-testid=thread-card] [data-testid=comment-body]')).toHaveCount(1);

  const bobPage = await bob.open(path);
  await bob.signIn(bobPage);
  await createThread(bobPage, 'scribes added glosses that explained difficult passages', 'Glosses were the first hyperlinks.');
  await bobPage.keyboard.press('Escape');
  await expect(page.locator('[data-testid=launcher]')).toBeVisible();
  await page.locator('[data-testid=thread-card] [data-testid=reply-input]').fill('Agreed, and they still are.');
  await page.locator('[data-testid=thread-card] [data-testid=reply-input]').press('Enter');
  await page.screenshot({ path: 'test-results/screens/3-thread.png' });
  await page.keyboard.press('Escape');
  await alice.openSidebar(page);
  await page.screenshot({ path: 'test-results/screens/4-sidebar.png' });
});
