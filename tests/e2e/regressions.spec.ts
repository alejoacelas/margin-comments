// Regression tests for bugs found by review (see REVIEW.md).
import { closeSidebar, createThread, EXT_PATH_CLOSED, expect, FAKE, highlightTexts, Person, selectBetween, selectText, setNetwork, setVersion, test, textCenter, uniquePath, waitForEmail } from './helpers';

test.afterEach(async ({ alice, bob }) => {
  expect([...alice.errors, ...bob.errors], 'host page console errors').toEqual([]);
});

test('checkboxes and forms in our UI activate exactly once', async ({ alice }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  await alice.openSidebar(a);
  const before = (await (await fetch(`${FAKE}/_test/sent?to=${encodeURIComponent(alice.email)}`)).json()).length;
  await a.frameLocator('iframe[data-testid=signin-email-frame]').locator('[data-testid=signin-email]').fill(alice.email);
  await a.locator('[data-testid=signin-send]').click();
  await expect(a.frameLocator('iframe[data-testid=signin-code-frame]').locator('[data-testid=signin-code]')).toBeVisible();
  await waitForEmail(alice.email, m => /sign-in code/.test(m.subject));
  await a.waitForTimeout(500);
  const after = (await (await fetch(`${FAKE}/_test/sent?to=${encodeURIComponent(alice.email)}`)).json()).length;
  expect(after - before).toBe(1);
  await a.frameLocator('iframe[data-testid=signin-code-frame]').locator('[data-testid=signin-code]').fill('000000');
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
  await a.locator('[data-testid=thread-card]').frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]').fill('Intended for A');
  const atB = await textCenter(a, 'Social highlights for friends');
  await a.mouse.click(atB.x, atB.y);
  await expect(a.locator('[data-testid=thread-card] [data-testid=comment-body]').first()).toHaveText('Thread B');
  await expect(a.locator('[data-testid=thread-card]').frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]')).toHaveValue('');
  // A's text is still waiting in A.
  const againA = await textCenter(a, 'Open annotation standard');
  await a.mouse.click(againA.x, againA.y);
  await expect(a.locator('[data-testid=thread-card] [data-testid=comment-body]').first()).toHaveText('Thread A');
  await expect(a.locator('[data-testid=thread-card]').frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]')).toHaveValue('Intended for A');
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
  await a.frameLocator('iframe[data-testid=composer-input-frame]').locator('[data-testid=composer-input]').fill('Spans a script');
  await a.frameLocator('iframe[data-testid=composer-input-frame]').locator('[data-testid=composer-input]').press('Enter');
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
  await a.locator('[data-testid=sidebar-thread]').frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]').fill('A long reply I typed but did not send');
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
  await a.frameLocator('iframe[data-testid=composer-input-frame]').locator('[data-testid=composer-input]').fill("Alice's private unsent comment");
  await a.frameLocator('iframe[data-testid=composer-input-frame]').locator('[data-testid=composer-input]').press('Enter');
  await expect(a.locator('[data-testid=thread-card]').getByText('Saving…')).toBeVisible();
  await a.locator('[data-testid=thread-card]').frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]').fill("Alice's half-typed reply");
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
  await expect(a.frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]')).toHaveCount(1);
  // Clicking the highlight with the sidebar open selects it there too.
  await closeSidebar(a);
  await alice.openSidebar(a);
  const at = await textCenter(a, 'Open annotation standard');
  await a.mouse.click(at.x, at.y);
  await expect(a.locator('[data-testid=sidebar-thread].selected')).toHaveCount(1);
  await expect(a.frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]')).toHaveCount(1);
});

test('labels, links and middle clicks in our UI work, even on a hostile page', async ({ alice }) => {
  const path = uniquePath('keys');
  const a = await alice.open(path);
  await alice.signIn(a);
  await alice.openSidebar(a);
  const box = a.locator('.sb-foot input[type=checkbox]');
  await expect(box).toBeChecked();
  await a.locator('.sb-foot label.toggle').getByText('Email me when someone replies').click();
  await expect(box).not.toBeChecked();
  await closeSidebar(a);

  await createThread(a, 'binds single-letter shortcuts', 'See https://example.com/notes for more');
  const link = a.locator('[data-testid=thread-card] [data-testid=comment-body] a');
  await expect(link).toHaveAttribute('href', 'https://example.com/notes');
  const [tab] = await Promise.all([alice.context.waitForEvent('page'), link.click()]);
  expect(tab.url()).toContain('example.com/notes');
  await tab.close();
  const [tab2] = await Promise.all([alice.context.waitForEvent('page'), link.click({ button: 'middle' })]);
  expect(tab2.url()).toContain('example.com/notes');
  await tab2.close();
});

test('two quick replies are two comments', async ({ alice }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  await alice.signIn(a);
  await createThread(a, 'Open annotation standard', 'Start');
  const input = a.locator('[data-testid=thread-card]').frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]');
  await input.fill('Reply A');
  await input.press('Enter');
  await input.fill('Reply B');
  await input.press('Enter');
  await expect(a.locator('[data-testid=thread-card] [data-testid=comment-body]')).toHaveText(['Start', 'Reply A', 'Reply B']);
  await a.reload();
  await alice.openSidebar(a);
  await a.locator('[data-testid=sidebar-thread]').click();
  await expect(a.locator('[data-testid=sidebar-thread] [data-testid=comment-body]')).toHaveText(['Start', 'Reply A', 'Reply B']);
});

test('a comment made right after SPA navigation is saved for the new page', async ({ alice }) => {
  const path = uniquePath('spa');
  const a = await alice.open(path);
  await alice.signIn(a);
  await expect(a.locator('#late')).toBeVisible();
  const route = `${path}-second`;
  await a.evaluate(r => (window as any).navigate(r), route);
  // Select and comment immediately, before the URL poll notices.
  await createThread(a, 'A different view rendered', 'On route two');
  // Load the app again and navigate the same way: the thread belongs to route two…
  await a.goto(`http://localhost:18902${path}`);
  await expect(a.locator('#late')).toBeVisible();
  await alice.openSidebar(a);
  await expect(a.locator('[data-testid=sidebar-thread]')).toHaveCount(0); // …not to the first route
  await a.evaluate(r => (window as any).navigate(r), route);
  await expect(a.locator('[data-testid=sidebar-thread]')).toContainText('On route two', { timeout: 10_000 });
});

test('reply drafts typed in two tabs both survive', async ({ alice }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  await alice.signIn(a);
  await createThread(a, 'Open annotation standard', 'Two tabs');
  await a.keyboard.press('Escape');
  const open = async (p: import('@playwright/test').Page) => {
    await alice.openSidebar(p);
    await p.locator('[data-testid=sidebar-thread]').click();
    return p.locator('[data-testid=sidebar-thread]').frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]');
  };
  const one = await open(a);
  await one.fill('Reply typed in tab one');
  await a.waitForTimeout(700);
  const b = await alice.open(path);
  const two = await open(b);
  await two.fill('');
  await two.pressSequentially('Different reply from tab two');
  await b.waitForTimeout(700);
  await a.close();
  await b.close();
  const c = await alice.open(path);
  const box = await open(c);
  // One draft comes back in the editor, the other is kept under "Unsent drafts".
  const shown = await box.inputValue();
  expect(['Reply typed in tab one', 'Different reply from tab two']).toContain(shown);
  const other = shown === 'Reply typed in tab one' ? 'Different reply from tab two' : 'Reply typed in tab one';
  await expect(c.locator('[data-testid=draft-row]')).toContainText(other);
  // This tab edits its draft, then discards the other tab's: its own stays.
  await box.fill(`${shown} (edited in tab three)`);
  await c.waitForTimeout(700);
  await c.locator('[data-testid=draft-row]').filter({ hasText: other }).getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(c.locator('[data-testid=draft-row]').filter({ hasText: other })).toHaveCount(0);
  await c.waitForTimeout(300);
  await c.reload();
  const again = await open(c);
  await expect(again).toHaveValue(`${shown} (edited in tab three)`);
});

test('restored drafts can be discarded, and cancelling never deletes a draft another open tab owns', async ({ alice }) => {
  const path = uniquePath('article');
  let a = await alice.open(path);
  await alice.signIn(a);
  // A new-thread draft survives a closed tab and can then be discarded for good.
  await selectText(a, 'Social highlights for friends');
  await a.locator('[data-testid=adder]').click();
  await a.frameLocator('iframe[data-testid=composer-input-frame]').locator('[data-testid=composer-input]').fill('Draft to discard');
  await a.waitForTimeout(700);
  await a.close();
  a = await alice.open(path);
  await alice.openSidebar(a);
  await a.locator('[data-testid=draft-row]').getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(a.locator('[data-testid=draft-row]')).toHaveCount(0);
  await a.reload();
  await alice.openSidebar(a);
  await expect(a.locator('[data-testid=draft-row]')).toHaveCount(0);
  await closeSidebar(a);

  // Tab A keeps typing a reply; tab B restores it, extends it, then cancels.
  await createThread(a, 'Open annotation standard', 'Thread for drafts');
  await a.keyboard.press('Escape');
  await alice.openSidebar(a);
  await a.locator('[data-testid=sidebar-thread]').click();
  await a.locator('[data-testid=sidebar-thread]').frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]').fill('Original thought');
  await a.waitForTimeout(700);
  const b = await alice.open(path);
  await alice.openSidebar(b);
  await b.locator('[data-testid=sidebar-thread]').click();
  const boxB = b.locator('[data-testid=sidebar-thread]').frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]');
  await expect(boxB).toHaveValue('Original thought');
  await boxB.fill('Original thought, extended in tab B');
  await b.waitForTimeout(700);
  await b.locator('[data-testid=sidebar-thread] .text-btn').getByText('Cancel').click();
  await b.waitForTimeout(300);
  await b.close();
  await a.close();
  const c = await alice.open(path);
  await alice.openSidebar(c);
  await c.locator('[data-testid=sidebar-thread]').click();
  await expect(c.locator('[data-testid=sidebar-thread]').frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]')).toHaveValue('Original thought');
  // Cancelling the restored draft here (no other tab open) discards it.
  await c.locator('[data-testid=sidebar-thread] .text-btn').getByText('Cancel').click();
  await c.waitForTimeout(300);
  await c.reload();
  await alice.openSidebar(c);
  await c.locator('[data-testid=sidebar-thread]').click();
  await expect(c.locator('[data-testid=sidebar-thread]').frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]')).toHaveValue('');
});

test('clicking highlighted link text opens the thread without navigating', async ({ alice }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  await alice.signIn(a);
  await createThread(a, 'added glosses that explained', 'About the glosses link');
  await a.keyboard.press('Escape');
  const before = a.url();
  const at = await textCenter(a, 'glosses that');
  await a.mouse.click(at.x, at.y);
  await expect(a.locator('[data-testid=thread-card] [data-testid=comment-body]')).toHaveText('About the glosses link');
  expect(a.url()).toBe(before);
});

test("clicking where clipped highlighted text would be doesn't open its thread", async ({ alice }) => {
  const path = uniquePath('clip');
  const a = await alice.open(path);
  await alice.signIn(a);
  await createThread(a, 'second paragraph is clipped away', 'Hidden by overflow');
  await a.keyboard.press('Escape');
  await expect(a.locator('[data-testid=thread-card]')).toHaveCount(0);
  const at = await a.evaluate(() => {
    const t = document.getElementById('clipped')!.firstChild as Text;
    const r = document.createRange();
    r.setStart(t, 9);
    r.setEnd(t, 15);
    const rect = r.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await a.mouse.click(at.x, at.y);
  await a.waitForTimeout(300);
  await expect(a.locator('[data-testid=thread-card]')).toHaveCount(0);
  expect(await a.evaluate(() => (window as any).__covered)).toBe(1);
});

test('a new thread shows up even if the sidebar is on the Resolved filter', async ({ alice }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  await alice.signIn(a);
  await alice.openSidebar(a);
  await a.locator('[data-testid=filter-resolved]').click();
  await selectText(a, 'Threads with email replies');
  await a.locator('[data-testid=adder]').click();
  await a.frameLocator('iframe[data-testid=composer-input-frame]').locator('[data-testid=composer-input]').fill('Made while on Resolved');
  await a.frameLocator('iframe[data-testid=composer-input-frame]').locator('[data-testid=composer-input]').press('Enter');
  await expect(a.locator('[data-testid=sidebar-thread].selected')).toContainText('Made while on Resolved');
});

test("page scripts can't read or drive our UI in the production build (closed shadow root)", async ({ alice }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  await alice.signIn(a);
  await createThread(a, 'Open annotation standard', 'Secret-ish comment');
  const mallory = await Person.launch('prod', `prod-${Date.now()}@example.com`, EXT_PATH_CLOSED);
  try {
    await mallory.signInHeadless();
    const p = await mallory.open(path);
    // The extension works (the thread is highlighted)…
    await expect.poll(() => highlightTexts(p)).toEqual(['Open annotation standard']);
    // …but the page sees an opaque host: no shadow root, no way in.
    const probe = await p.evaluate(() => {
      const host = document.querySelector('margin-comments-root')!;
      return { shadow: host.shadowRoot === null, text: host.textContent, inner: host.querySelectorAll('*').length };
    });
    expect(probe).toEqual({ shadow: true, text: '', inner: 0 });
    // Synthetic events dispatched at the host do nothing (and don't throw).
    await p.evaluate(() => {
      const host = document.querySelector('margin-comments-root')!;
      host.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
    });
    expect(mallory.errors).toEqual([]);
  } finally {
    await mallory.close();
  }
});

test('the production build (closed shadow root) works with real mouse and keyboard input', async () => {
  const user = await Person.launch('prod-ui', `prod-ui-${Date.now()}@example.com`, EXT_PATH_CLOSED);
  try {
    const token = await user.signInHeadless();
    const path = uniquePath('article');
    const p = await user.open(path);
    await expect.poll(() => p.evaluate(() => document.querySelector('margin-comments-root')?.shadowRoot === null)).toBe(true);
    // A nosy page logs every key it can see.
    await p.evaluate(() => {
      const w = window as any;
      w.__keys = '';
      for (const type of ['keydown', 'keypress', 'input', 'beforeinput'])
        window.addEventListener(type, (e: any) => (w.__keys += e.key ?? e.data ?? '?'), true);
    });
    // Select text; the "Comment" chip appears 10px right of the selection, top-aligned.
    await selectText(p, 'Readers have always written in the margins');
    const chip = await p.evaluate(() => {
      const r = document.getSelection()!.getRangeAt(0).getBoundingClientRect();
      return { x: r.right + 10 + 25, y: Math.max(4, r.top) + 10 };
    });
    await p.waitForTimeout(400);
    await p.mouse.click(chip.x, chip.y);
    await p.waitForTimeout(400); // let the composer appear and take focus, as a person would
    // The composer has focus: type with the real keyboard.
    await p.keyboard.type('Typed into the production build');
    await p.waitForTimeout(800);
    const drafts = await user.sw.evaluate(async () => Object.values(((await chrome.storage.local.get('drafts')).drafts ?? {}) as Record<string, { text: string }>).map(d => d.text));
    expect(drafts).toContain('Typed into the production build');
    // The page can't see the keystrokes, and can't read the draft through its
    // own Selection API (the field lives in an extension-origin frame).
    expect(await p.evaluate(() => (window as any).__keys)).toBe('');
    const leaked = await p.evaluate(() => {
      document.execCommand('selectAll');
      const all = document.getSelection()!.toString();
      const active = document.activeElement;
      const range = document.createRange();
      range.selectNodeContents(document.documentElement);
      return { all, range: range.toString(), active: active?.tagName, frames: window.frames.length };
    });
    expect(leaked.all).not.toContain('Typed into');
    expect(leaked.range).not.toContain('Typed into');
    expect(await p.evaluate(() => { try { return (window.frames[0] as any).document.body.innerText; } catch { return 'blocked'; } })).toBe('blocked');
    // Put focus back in the field (selectAll moved it) and send.
    const field = p.frames().find(f => f.url().includes('/input.html'))!;
    await field.locator('textarea').focus();
    await p.keyboard.press('Enter');
    await expect
      .poll(async () => {
        const r = await fetch(`http://localhost:18788/api/threads?key=${encodeURIComponent(`localhost:18902${path}`)}`, { headers: { authorization: `Bearer ${token}` } });
        const j = await r.json();
        return j.threads?.map((t: any) => t.comments[0]?.body) ?? [];
      })
      .toEqual(['Typed into the production build']);
    await expect.poll(() => highlightTexts(p)).toEqual(['Readers have always written in the margins']);
    expect(user.errors).toEqual([]);
  } finally {
    await user.close();
  }
});

test("in the production build the page can't find or select your email or drafts", async () => {
  const user = await Person.launch('prod-private', `prod-private-${Date.now()}@example.com`, EXT_PATH_CLOSED);
  try {
    await user.signInHeadless();
    const path = uniquePath('article');
    const p = await user.open(path);
    await expect.poll(() => p.evaluate(() => document.querySelector('margin-comments-root')?.shadowRoot === null)).toBe(true);
    // Leave an unsent draft: chip, type, reload.
    await selectText(p, 'Readers have always written in the margins');
    const chip = await p.evaluate(() => {
      const r = document.getSelection()!.getRangeAt(0).getBoundingClientRect();
      return { x: r.right + 10 + 25, y: Math.max(4, r.top) + 10 };
    });
    await p.waitForTimeout(400);
    await p.mouse.click(chip.x, chip.y);
    await p.waitForTimeout(400);
    await p.keyboard.type('Unsent private musings');
    await p.waitForTimeout(800);
    await p.reload();
    await expect.poll(() => p.evaluate(() => !!document.querySelector('margin-comments-root'))).toBe(true);
    // Open the sidebar: account (name, email) and the "Unsent drafts" list.
    await user.clickToolbar(p);
    await expect.poll(() => p.evaluate(() => { getSelection()!.removeAllRanges(); return (window as any).find('Unsent drafts'); })).toBe(true);
    const probe = await p.evaluate(email => {
      const find = (q: string) => {
        getSelection()!.removeAllRanges();
        return (window as any).find(q);
      };
      const r = {
        email: find(email),
        emailUser: find(email.split('@')[0]),
        draft: find('Unsent private musings'),
        draftWord: find('musings'),
        all: '',
      };
      // Bulk read: put the selection in our UI, then select all.
      getSelection()!.removeAllRanges();
      (window as any).find('Unsent drafts');
      document.execCommand('selectAll');
      r.all = getSelection()!.toString();
      return r;
    }, user.email);
    expect(probe.email).toBe(false);
    expect(probe.emailUser).toBe(false);
    expect(probe.draft).toBe(false);
    expect(probe.draftWord).toBe(false);
    expect(probe.all).not.toContain('musings');
    expect(probe.all).not.toContain(user.email);
    expect(user.errors).toEqual([]);
  } finally {
    await user.close();
  }
});

test("a click on a card's blank area isn't taken over by clipped highlighted text inside it", async ({ alice }) => {
  const path = uniquePath('clip');
  const a = await alice.open(path);
  await alice.signIn(a);
  await createThread(a, 'Hidden teaser text that the card clips', 'Clipped inside a card');
  await a.keyboard.press('Escape');
  const at = await a.evaluate(() => {
    const ps = document.querySelectorAll('#card p');
    const t = ps[1].firstChild as Text;
    const r = document.createRange();
    r.setStart(t, 0);
    r.setEnd(t, 6);
    const rect = r.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await a.mouse.click(at.x, at.y);
  await expect(a).toHaveURL(/#card-opened$/);
  await expect(a.locator('[data-testid=thread-card]')).toHaveCount(0);
});

test('a click on blank space beside a highlighted paragraph goes to the page, not the thread', async ({ alice }) => {
  const path = uniquePath('clip');
  const a = await alice.open(path);
  await alice.signIn(a);
  await selectBetween(a, 'Opening line of the wide', 'Closing line');
  await a.locator('[data-testid=adder]').click();
  const input = a.frameLocator('iframe[data-testid=composer-input-frame]').locator('[data-testid=composer-input]');
  await input.fill('Across three paragraphs');
  await input.press('Enter');
  await expect(a.locator('[data-testid=thread-card] [data-testid=comment-body]')).toHaveText(['Across three paragraphs']);
  await a.keyboard.press('Escape');
  await expect(a.locator('[data-testid=thread-card]')).toHaveCount(0);
  // Far right of the short middle line: inside the highlight's (full-width)
  // rect for that paragraph, but no text there.
  const at = await a.evaluate(() => {
    const p = document.querySelectorAll('#card2 p')[1];
    const r = p.getBoundingClientRect();
    return { x: r.right - 20, y: r.top + r.height / 2 };
  });
  await a.mouse.click(at.x, at.y);
  await expect(a).toHaveURL(/#card2-opened$/);
  await expect(a.locator('[data-testid=thread-card]')).toHaveCount(0);
  // Clicking the highlighted text itself still opens the thread.
  await a.mouse.click(...(Object.values(await textCenter(a, 'Middle.')) as [number, number]));
  await expect(a.locator('[data-testid=thread-card]')).toHaveCount(1);
});

test('following a thread link on the page that is already open opens the thread', async ({ alice }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  await alice.signIn(a);
  await createThread(a, 'common in medieval manuscripts', 'Linked from an email');
  const id = await a.locator('[data-testid=thread-card] [data-thread-id]').first().getAttribute('data-thread-id');
  await a.keyboard.press('Escape');
  await expect(a.locator('[data-testid=thread-card]')).toHaveCount(0);
  await a.evaluate(i => {
    location.hash = `margin-comments=${i}`;
  }, id);
  await expect(a.locator('[data-testid=thread-card] [data-testid=comment-body]')).toHaveText('Linked from an email');
});

test('keyboard activation of our buttons works (Enter on a focused button)', async ({ alice }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  await alice.signIn(a);
  await alice.openSidebar(a);
  await a.locator('[data-testid=sidebar-close]').focus();
  await a.keyboard.press('Enter');
  await expect(a.locator('[data-testid=sidebar]')).toHaveCount(0);
});

test('Continue opens exactly the chosen draft when two share a selection', async ({ alice }) => {
  const path = uniquePath('article');
  const make = async (text: string) => {
    const p = await alice.open(path);
    await selectText(p, 'Social highlights for friends');
    await p.locator('[data-testid=adder]').click();
    const input = p.frameLocator('iframe[data-testid=composer-input-frame]').locator('[data-testid=composer-input]');
    await expect(input).toBeFocused();
    await p.waitForTimeout(200); // the composer restores a saved draft and moves the caret
    await input.fill(text);
    await expect(input).toHaveValue(text);
    await p.waitForTimeout(700);
    return p;
  };
  const first = await alice.open(path);
  await alice.signIn(first);
  await first.close();
  const a = await make('First draft for this selection');
  const b = await make('Second draft for this selection');
  await a.close();
  await b.close();
  const c = await alice.open(path);
  await alice.openSidebar(c);
  for (const text of ['First draft for this selection', 'Second draft for this selection']) {
    await c.locator('[data-testid=draft-row]').filter({ hasText: text }).getByRole('button', { name: 'Continue' }).click();
    await expect(c.frameLocator('iframe[data-testid=composer-input-frame]').locator('[data-testid=composer-input]')).toHaveValue(text);
    await c.keyboard.press('Escape');
  }
});

test("submitting in one tab doesn't delete another open tab's shorter draft", async ({ alice }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  await alice.signIn(a);
  await createThread(a, 'Open annotation standard', 'Thread');
  await a.keyboard.press('Escape');
  await alice.openSidebar(a);
  await a.locator('[data-testid=sidebar-thread]').click();
  await a.locator('[data-testid=sidebar-thread]').frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]').fill('No');
  await a.waitForTimeout(700);
  const b = await alice.open(path);
  await alice.openSidebar(b);
  await b.locator('[data-testid=sidebar-thread]').click();
  const boxB = b.locator('[data-testid=sidebar-thread]').frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]');
  await boxB.fill('Nobody has tested this yet');
  await boxB.press('Enter');
  await expect(b.locator('[data-testid=sidebar-thread] [data-testid=comment-body]')).toHaveText(['Thread', 'Nobody has tested this yet']);
  await b.close();
  await a.reload();
  await alice.openSidebar(a);
  await a.locator('[data-testid=sidebar-thread]').click();
  await expect(a.locator('[data-testid=sidebar-thread]').frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]')).toHaveValue('No');
});

test('keys typed right after Enter never end up in the comment or in a phantom draft', async ({ alice }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  await alice.signIn(a);
  await selectText(a, 'Open annotation standard');
  await a.locator('[data-testid=adder]').click();
  const box = a.frameLocator('iframe[data-testid=composer-input-frame]').locator('[data-testid=composer-input]');
  await box.fill('Posted text');
  // Enter and the next keys in one burst, like a fast typist.
  await a.keyboard.type('\nzz');
  await expect(a.locator('[data-testid=thread-card] [data-testid=comment-body]').first()).toHaveText('Posted text');
  await a.waitForTimeout(800);
  await a.keyboard.press('Escape');
  await alice.openSidebar(a);
  await expect(a.locator('[data-testid=sidebar-thread] .row-first')).toHaveText(['Posted text']);
  for (const row of await a.locator('[data-testid=draft-row]').all()) await expect(row).not.toContainText('Posted text');
});

