import { closeSidebar, createThread, expect, FIXTURES, highlightTexts, selectBetween, selectText, setVersion, test, textCenter, uniquePath, waitForEmail } from './helpers';

test.afterEach(async ({ alice }) => {
  expect(alice.errors, 'host page console errors').toEqual([]);
});

test('threads re-anchor on an edited page; removed text becomes an orphan', async ({ alice }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  await alice.signIn(a);
  await createThread(a, 'Readers have always written in the margins of books.', 'Reworded later');
  await createThread(a, 'Later readers responded to those glosses with their own notes', 'This sentence gets deleted');
  await createThread(a, 'shared highlights let friends see what you read', 'A word gets inserted');
  await createThread(a, 'Social highlights for friends', 'Unchanged table cell');

  await setVersion(path, 'article-v2.html');
  await a.reload();
  await expect
    .poll(() => highlightTexts(a))
    .toEqual(['Readers have always written in the margins of their books.', 'Social highlights for friends', 'shared highlights let your friends see what you read'].sort());
  await alice.openSidebar(a);
  const rows = a.locator('[data-testid=sidebar-thread]');
  await expect(rows).toHaveCount(4);
  // The orphan is listed under "Not found on this page", never dropped.
  const orphan = rows.filter({ hasText: 'This sentence gets deleted' });
  await expect(orphan).toContainText('Text not found');
  await orphan.click();
  await expect(orphan.locator('[data-testid=comment-body]')).toHaveText('This sentence gets deleted');
  await setVersion(path, null);
});

test('selections across elements, inside lists and tables, overlapping, and very long', async ({ alice }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  await alice.signIn(a);

  // Across <a>: "scribes added glosses that explained"
  await createThread(a, 'scribes added glosses that explained', 'Crosses a link');
  // Across list items (into the nested list).
  await selectBetween(a, 'see what you read.', 'Nested item');
  await a.locator('[data-testid=adder]').click();
  await a.frameLocator('iframe[data-testid=composer-input-frame]').locator('[data-testid=composer-input]').fill('Crosses list items');
  await a.frameLocator('iframe[data-testid=composer-input-frame]').locator('[data-testid=composer-input]').press('Enter');
  await expect(a.locator('[data-testid=thread-card] [data-testid=comment-body]')).toHaveText('Crosses list items');
  // Inside a table, across cells.
  await createThread(a, '2020Social highlights', 'Crosses table cells');
  // Overlapping an existing highlight.
  await createThread(a, 'added glosses', 'Overlaps the first one');
  // Very long: the entire long paragraph (~6,000 characters).
  const long = await a.locator('#p3').innerText();
  expect(long.length).toBeGreaterThan(5000);
  await createThread(a, long.slice(0, 5900), 'A very long selection');

  const expected = [
    'scribes added glosses that explained',
    'see what you read. Nested item',
    '2020Social highlights',
    'added glosses',
    long.slice(0, 5900).replace(/\s+/g, ' ').trim(),
  ];
  await expect.poll(async () => (await highlightTexts(a)).length).toBe(5);
  expect((await highlightTexts(a)).map(t => t.replace(/\s+/g, ''))).toEqual(expected.map(t => t.replace(/\s+/g, '')).sort());

  // Overlap: clicking inside the inner highlight opens the more specific thread.
  await a.keyboard.press('Escape');
  const at = await textCenter(a, 'added glosses');
  await a.mouse.click(at.x, at.y);
  await expect(a.locator('[data-testid=thread-card] [data-testid=comment-body]')).toHaveText('Overlaps the first one');

  // Everything survives a reload.
  await a.reload();
  await expect.poll(async () => (await highlightTexts(a)).length).toBe(5);
  await alice.openSidebar(a);
  await expect(a.locator('[data-testid=sidebar-thread]')).toHaveCount(5);
  await expect(a.locator('[data-testid=sidebar-thread]').getByText('Text not found')).toHaveCount(0);
});

test('works on a page with a strict Content-Security-Policy', async ({ alice }) => {
  const path = uniquePath('article-csp', { csp: true });
  const a = await alice.open(path);
  await alice.signIn(a);
  await createThread(a, 'Marginalia record a conversation', 'Works under CSP');
  await expect.poll(() => highlightTexts(a)).toEqual(['Marginalia record a conversation']);
  await a.reload();
  await expect.poll(() => highlightTexts(a)).toEqual(['Marginalia record a conversation']);
  // UI styles applied (adopted stylesheet not blocked): the card has its shadow.
  await a.mouse.click(...Object.values(await textCenter(a, 'Marginalia record')) as [number, number]);
  const shadow = await a.locator('[data-testid=thread-card]').evaluate(el => getComputedStyle(el.closest('.card')!).boxShadow);
  expect(shadow).not.toBe('none');
});

test('content that renders late, arrives by infinite scroll, or is re-rendered', async ({ alice, bob }) => {
  const path = uniquePath('spa');
  const a = await alice.open(path);
  await alice.signIn(a);
  await expect(a.locator('#late')).toBeVisible();
  await createThread(a, 'only exists after the client-side render', 'On late content');
  await a.evaluate(() => (window as any).addMore());
  await createThread(a, 'Infinite chunk 5: photos from a trip to a library', 'On infinite scroll content');

  // A fresh visitor: the threads anchor once the content shows up.
  const b = await bob.open(path);
  await bob.signIn(b);
  await expect.poll(() => highlightTexts(b), { timeout: 15_000 }).toEqual(['only exists after the client-side render']);
  await b.evaluate(() => (window as any).addMore());
  await expect
    .poll(() => highlightTexts(b), { timeout: 15_000 })
    .toEqual(['Infinite chunk 5: photos from a trip to a library', 'only exists after the client-side render']);

  // The framework replaces the node: the highlight follows.
  await b.evaluate(() => (window as any).rerender());
  await expect
    .poll(() => highlightTexts(b), { timeout: 15_000 })
    .toEqual(['Infinite chunk 5: photos from a trip to a library', 'only exists after the client-side render']);

  // SPA navigation via pushState switches the page's threads.
  await b.evaluate(() => (window as any).navigate('/spa-second-route'));
  await expect.poll(() => highlightTexts(b), { timeout: 15_000 }).toEqual([]);
  await createThread(b, 'A different view rendered', 'On the second route');
  await expect.poll(() => highlightTexts(b)).toEqual(['A different view rendered']);
});

test("typing in our UI never triggers the page's shortcuts, and page handlers can't block it", async ({ alice }) => {
  const path = uniquePath('keys');
  const a = await alice.open(path);
  await alice.signIn(a);
  await a.evaluate(() => {
    (window as any).__pageKeys = 0;
  });
  await selectText(a, 'binds single-letter shortcuts like j and k');
  await a.locator('[data-testid=adder]').click();
  const input = a.frameLocator('iframe[data-testid=composer-input-frame]').locator('[data-testid=composer-input]');
  await input.click();
  await input.pressSequentially('jjj kkk');
  await expect(input).toHaveValue('jjj kkk');
  expect(await a.evaluate(() => (window as any).__pageKeys)).toBe(0);
  expect(await a.evaluate(() => document.body.dataset.jumped ?? null)).toBeNull();
  await input.press('Enter');
  await expect(a.locator('[data-testid=thread-card] [data-testid=comment-body]')).toHaveText('jjj kkk');
  // Keys outside our UI still reach the page.
  await a.locator('#k2').click();
  await a.keyboard.press('j');
  expect(await a.evaluate(() => (window as any).__pageKeys)).toBeGreaterThan(0);
});

test('host page layout and text are untouched', async ({ alice }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  const before = await a.evaluate(() => ({ text: document.body.innerText, html: document.body.innerHTML, width: document.documentElement.scrollWidth }));
  await alice.signIn(a);
  await createThread(a, 'common in medieval manuscripts', 'No DOM changes please');
  await alice.openSidebar(a);
  const after = await a.evaluate(() => ({ text: document.body.innerText, html: document.body.innerHTML, width: document.documentElement.scrollWidth }));
  // Highlights use the CSS Custom Highlight API: no wrapper elements in the page.
  expect(after.html).toBe(before.html);
  expect(after.text).toBe(before.text);
  expect(after.width).toBe(before.width);
  // Our only node is the shadow host on <html>.
  expect(
    await a.evaluate(() => [...document.documentElement.children].map(e => e.tagName.toLowerCase() + (e.hasAttribute('data-margin-comments') ? '[data-margin-comments]' : ''))),
  ).toEqual(['head', 'body', 'div[data-margin-comments]']);
  void FIXTURES;
});

test('dark pages get dark highlight colors', async ({ alice }) => {
  const path = uniquePath('dark');
  const a = await alice.open(path);
  await alice.signIn(a);
  await createThread(a, 'Readers have always written', 'On a dark page');
  const names = await a.evaluate(() => [...(CSS as any).highlights.keys()].filter((n: string) => n.startsWith('mc-') && (CSS as any).highlights.get(n).size > 0));
  expect(names.every((n: string) => n.endsWith('-d'))).toBe(true);
});

test('works on plain-HTTP pages (insecure context, no crypto.randomUUID)', async ({ alice }) => {
  const a = await alice.open(`http://insecure.test:18902${uniquePath('article')}`);
  expect(await a.evaluate(() => window.isSecureContext)).toBe(false);
  await alice.signIn(a);
  await createThread(a, 'Marginalia record a conversation', 'Works over plain HTTP');
  await expect.poll(() => highlightTexts(a)).toEqual(['Marginalia record a conversation']);
  await a.locator('[data-testid=thread-card]').frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]').fill('And replies');
  await a.locator('[data-testid=thread-card]').frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]').press('Enter');
  await expect(a.locator('[data-testid=thread-card] [data-testid=comment-body]')).toHaveText(['Works over plain HTTP', 'And replies']);
});

test("works on sandboxed pages, where our frames can't run: you type in an extension window the page can't see", async ({ alice }) => {
  const a = await alice.open(uniquePath('article', { sandbox: true }));
  expect(await a.evaluate(() => window.origin)).toBe('null');
  // The page runs scripts (sandbox allow-scripts) and logs every key it sees.
  await a.evaluate(() => {
    const w = window as any;
    w.__keys = '';
    for (const t of ['keydown', 'input', 'beforeinput']) window.addEventListener(t, (e: any) => (w.__keys += e.key ?? e.data ?? '?'), true);
  });
  await alice.openSidebar(a);
  await expect(a.locator('iframe.field-frame')).toHaveCount(0);
  const typeIn = async (testId: string, text: string) => {
    const [win] = await Promise.all([alice.context.waitForEvent('page'), a.locator(`[data-testid=${testId}-window]`).click()]);
    const field = win.locator(`[data-testid=${testId}]`);
    await field.fill(text);
    await field.press('Enter');
    return win;
  };
  const since = Date.now();
  const w1 = await typeIn('signin-email', alice.email);
  // The window closes once its field is gone from the page.
  await expect.poll(() => w1.isClosed()).toBe(true);
  const mail = await waitForEmail(alice.email, m => /sign-in code/.test(m.subject), since);
  await typeIn('signin-code', /(\d{6})/.exec(mail.subject)![1]);
  await expect(a.locator('[data-testid=signout]')).toBeVisible();
  await closeSidebar(a);
  await selectText(a, 'Marginalia record a conversation');
  await a.locator('[data-testid=adder]').click();
  const w3 = await typeIn('composer-input', 'Typed in a window');
  await expect(a.locator('[data-testid=thread-card] [data-testid=comment-body]')).toHaveText(['Typed in a window']);
  await expect.poll(() => w3.isClosed()).toBe(true);
  await expect.poll(() => highlightTexts(a)).toEqual(['Marginalia record a conversation']);
  // Close a window mid-reply and reopen it: the text is still there.
  const [w4] = await Promise.all([alice.context.waitForEvent('page'), a.locator('[data-testid=reply-input-window]').click()]);
  await w4.locator('[data-testid=reply-input]').fill('An unfinished reply');
  await expect(a.locator('[data-testid=reply-input-window]')).toHaveText('Continue typing');
  await w4.close();
  const [w5] = await Promise.all([alice.context.waitForEvent('page'), a.locator('[data-testid=reply-input-window]').click()]);
  await expect(w5.locator('[data-testid=reply-input]')).toHaveValue('An unfinished reply');
  await w5.locator('[data-testid=reply-input]').press('End');
  await w5.locator('[data-testid=reply-input]').pressSequentially(', finished');
  await w5.locator('[data-testid=reply-input]').press('Enter');
  await expect(a.locator('[data-testid=thread-card] [data-testid=comment-body]')).toHaveText(['Typed in a window', 'An unfinished reply, finished']);
  expect(await a.evaluate(() => (window as any).__keys)).toBe('');
});
