import { API, createThread, expect, FAKE, highlightTexts, test, textCenter, waitForEmail, uniquePath } from './helpers';

test.afterEach(async ({ alice, bob }) => {
  expect([...alice.errors, ...bob.errors], 'host page console errors').toEqual([]);
});

async function inbound(body: Record<string, unknown>) {
  const res = await fetch(`${FAKE}/_test/inbound`, { method: 'POST', body: JSON.stringify(body) });
  return res.json() as Promise<{ email_id: string; webhookStatus: number; webhookBody: string }>;
}

test('a second user sees threads, replies, edits, resolves and deletes live', async ({ alice, bob }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  await alice.signIn(a);
  const b = await bob.open(path);
  await bob.signIn(b);

  await createThread(a, 'shared highlights let friends see what you read', 'Alice starts a thread');
  // Bob sees it without reloading.
  await expect.poll(() => highlightTexts(b)).toEqual(['shared highlights let friends see what you read']);
  await bob.openSidebar(b);
  const row = b.locator('[data-testid=sidebar-thread]');
  await expect(row).toContainText('Alice starts a thread');

  // Bob replies; Alice sees it live in her open card.
  await row.click();
  await row.frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]').fill('Bob replies live');
  await row.frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]').press('Enter');
  const aliceCard = a.locator('[data-testid=thread-card]');
  await expect(aliceCard.locator('[data-testid=comment-body]')).toHaveText(['Alice starts a thread', 'Bob replies live']);

  // Alice edits her comment; Bob sees the edit.
  const first = aliceCard.locator('[data-testid=comment]').first();
  await first.hover();
  await first.locator('[data-testid=edit]').click();
  await first.frameLocator('iframe[data-testid=edit-input-frame]').locator('[data-testid=edit-input]').fill('Alice edited her thread');
  await first.frameLocator('iframe[data-testid=edit-input-frame]').locator('[data-testid=edit-input]').press('Enter');
  await expect(row.locator('[data-testid=comment-body]').first()).toHaveText('Alice edited her thread');

  // Bob can't edit or delete Alice's comment.
  await row.locator('[data-testid=comment]').first().hover();
  await expect(row.locator('[data-testid=comment]').first().locator('[data-testid=edit]')).toHaveCount(0);

  // Alice resolves; Bob's highlight goes away and the thread moves to Resolved.
  await aliceCard.locator('[data-testid=resolve]').click();
  await expect(b.locator('[data-testid=filter-resolved]')).toHaveText(/Resolved 1/);
  await expect.poll(() => highlightTexts(b)).toEqual([]);

  // Alice deletes the thread; it disappears for Bob.
  await alice.openSidebar(a);
  await a.locator('[data-testid=filter-resolved]').click();
  const aliceRow = a.locator('[data-testid=sidebar-thread]');
  await aliceRow.click();
  const head = aliceRow.locator('[data-testid=comment]').first();
  await head.hover();
  await head.locator('[data-testid=delete]').click();
  await head.locator('[data-testid=confirm-delete]').click();
  await expect(b.locator('[data-testid=filter-resolved]')).toHaveText(/Resolved 0/);
});

test('reply notifications are emailed, and replying to the email posts into the thread', async ({ alice, bob }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  await alice.signIn(a);
  const b = await bob.open(path);
  await bob.signIn(b);

  await createThread(a, 'Open annotation standard', 'Is Hypothesis still the reference?');
  await expect.poll(() => highlightTexts(b)).toHaveLength(1);

  // Bob replies in the extension -> Alice gets an email.
  await bob.openSidebar(b);
  const row = b.locator('[data-testid=sidebar-thread]');
  await row.click();
  await row.frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]').fill('Yes, and it is open source.');
  await row.frameLocator('iframe[data-testid=reply-input-frame]').locator('[data-testid=reply-input]').press('Enter');

  const mail = await waitForEmail(alice.email, m => m.subject.includes('Open annotation standard'));
  expect(mail.text).toContain('Open annotation standard'); // the anchored quote
  expect(mail.text).toContain('Yes, and it is open source.'); // the new reply
  expect(mail.html).toContain('Yes, and it is open source.');
  const link = /Open the thread: (\S+)/.exec(mail.text)![1];
  expect(link).toMatch(/^http:\/\/localhost:18902\/u\/\w+\/article#margin-comments=[0-9a-f-]{36}$/);
  expect(mail.reply_to).toMatch(/^r-[a-z2-7]{26}-[a-z2-7]{12}-[a-z2-7]{16}@reply\.mail\.test$/);
  expect(mail.headers?.['List-Unsubscribe']).toContain('/unsubscribe?u=');
  // Bob (the replier) gets no email about his own reply.
  expect((await fetch(`${FAKE}/_test/sent?to=${encodeURIComponent(bob.email)}`).then(r => r.json())).filter((m: any) => !/sign-in/.test(m.subject))).toEqual([]);

  // The link opens the thread.
  const fromEmail = await alice.open(link);
  await expect(fromEmail.locator('[data-testid=thread-card] [data-testid=comment-body]')).toHaveText([
    'Is Hypothesis still the reference?',
    'Yes, and it is open source.',
  ]);

  // Alice replies by email (Gmail-style quoting and a signature are stripped).
  const result = await inbound({
    from: alice.email,
    fromName: 'Alice',
    to: [mail.reply_to],
    subject: `Re: ${mail.subject}`,
    text: [
      'Good to know, thanks!',
      '',
      '--',
      'Alice',
      '',
      `On Mon, Oct 26, 2026 at 3:00 PM Margin Comments <${mail.reply_to}> wrote:`,
      '> Yes, and it is open source.',
      '>',
      '> Reply to this email to respond in the thread.',
    ].join('\n'),
  });
  expect(result.webhookStatus).toBe(200);
  expect(result.webhookBody).toContain('posted');
  // It shows up live for both users, as Alice.
  await expect(row.locator('[data-testid=comment-body]')).toHaveText([
    'Is Hypothesis still the reference?',
    'Yes, and it is open source.',
    'Good to know, thanks!',
  ]);
  // And Bob is notified of Alice's emailed reply.
  await waitForEmail(bob.email, m => m.text.includes('Good to know, thanks!'));

  // Forged reply: right address, wrong sender -> rejected.
  const forged = await inbound({ from: 'mallory@evil.example', to: [mail.reply_to], subject: 'Re', text: 'forged!' });
  expect(forged.webhookBody).toContain('rejected');
  // Tampered address (signature changed) -> rejected.
  const tampered = mail.reply_to!.replace(/-[a-z2-7]{16}@/, '-aaaaaaaaaaaaaaaa@');
  const bad = await inbound({ from: alice.email, to: [tampered], subject: 'Re', text: 'tampered!' });
  expect(bad.webhookBody).toContain('rejected');
  // Sender that failed DMARC -> rejected.
  const spoofed = await inbound({ from: alice.email, to: [mail.reply_to], subject: 'Re', text: 'spoofed!', authentication: { spf: 'fail', dkim: 'fail', dmarc: 'fail' } });
  expect(spoofed.webhookBody).toContain('rejected');
  // Bad webhook signature -> 401, nothing posted.
  const unsigned = await inbound({ from: alice.email, to: [mail.reply_to], subject: 'Re', text: 'unsigned!', badSignature: true });
  expect(unsigned.webhookStatus).toBe(401);
  // Redelivered webhook -> posted once.
  const twice = await inbound({ from: alice.email, to: [mail.reply_to], subject: 'Re', text: 'Only once please', redeliver: true });
  expect(twice.webhookBody).toContain('duplicate');
  await expect(row.locator('[data-testid=comment-body]')).toHaveText([
    'Is Hypothesis still the reference?',
    'Yes, and it is open source.',
    'Good to know, thanks!',
    'Only once please',
  ]);
  await expect(row.locator('[data-testid=comment-body]').filter({ hasText: /forged|tampered|spoofed|unsigned/ })).toHaveCount(0);
});

test('signing in by opening the emailed link', async ({ alice }) => {
  const path = uniquePath('article');
  const page = await alice.open(path);
  await alice.openSidebar(page);
  const since = Date.now();
  await page.frameLocator('iframe[data-testid=signin-email-frame]').locator('[data-testid=signin-email]').fill(alice.email);
  await page.locator('[data-testid=signin-send]').click();
  const mail = await waitForEmail(alice.email, m => /sign-in code/.test(m.subject), since);
  const link = /(http:\/\/localhost:\d+\/auth\/verify#token=[\w-]+)/.exec(mail.text)![1];
  expect(link.startsWith(API)).toBe(true);
  const verify = await alice.open(link);
  await expect(verify.locator('#mc-verify')).toHaveAttribute('data-state', 'done');
  await expect(verify.locator('#mc-verify-message')).toContainText(alice.email);
  expect(verify.url()).not.toContain('token=');
  // The original tab is signed in too.
  await expect(page.locator('[data-testid=signout]')).toBeVisible();
  // The link is single-use.
  const again = await alice.open(link);
  await expect(again.locator('#mc-verify')).toHaveAttribute('data-state', 'error');
});

test("someone else's sign-in link doesn't switch accounts without asking", async ({ alice }) => {
  const path = uniquePath('article');
  const page = await alice.open(path);
  await alice.signIn(page);
  // Mallory requests a link for her own address and gets Alice to open it.
  const mallory = `mallory-${Date.now()}@example.com`;
  const since = Date.now();
  await fetch(`${API}/api/auth/email/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: mallory }) });
  const mail = await waitForEmail(mallory, m => /sign-in code/.test(m.subject), since);
  const link = /(http:\/\/localhost:\d+\/auth\/verify#token=[\w-]+)/.exec(mail.text)![1];
  const verify = await alice.open(link);
  await expect(verify.locator('#mc-verify')).toHaveAttribute('data-state', 'confirm');
  await expect(verify.locator('#mc-verify-title')).toContainText(mallory);
  await expect(verify.locator('#mc-verify-message')).toContainText(alice.email);
  const signedInAs = () => alice.sw.evaluate(async () => ((await chrome.storage.local.get('session')).session as { user: { email: string } } | undefined)?.user.email);
  expect(await signedInAs()).toBe(alice.email);
  // A script click isn't a confirmation.
  await verify.evaluate(() => (document.getElementById('mc-verify-confirm') as HTMLButtonElement).click());
  await verify.waitForTimeout(500);
  expect(await signedInAs()).toBe(alice.email);
  await expect(verify.locator('#mc-verify')).toHaveAttribute('data-state', 'confirm');
  // Only a real click on the confirmation switches.
  await verify.locator('#mc-verify-confirm').click();
  await expect(verify.locator('#mc-verify')).toHaveAttribute('data-state', 'done');
  expect(await signedInAs()).toBe(mallory);
});

test("switching accounts drops the previous account's unsaved name edit", async ({ alice }) => {
  const a = await alice.open(uniquePath('article'));
  await alice.signIn(a);
  await alice.openSidebar(a);
  await a.locator('.me .who .n').click();
  const name = a.frameLocator('iframe[data-testid=name-input-frame]').locator('[data-testid=name-input]');
  await name.fill('Alice Unsaved Rename');
  // In another tab, confirm someone else's sign-in link: this browser switches accounts.
  const mallory = `mallory-${Date.now()}@example.com`;
  const since = Date.now();
  await fetch(`${API}/api/auth/email/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: mallory }) });
  const mail = await waitForEmail(mallory, m => /sign-in code/.test(m.subject), since);
  const verify = await alice.open(/(http:\/\/localhost:\d+\/auth\/verify#token=[\w-]+)/.exec(mail.text)![1]);
  await verify.locator('#mc-verify-confirm').click();
  await expect(verify.locator('#mc-verify')).toHaveAttribute('data-state', 'done');
  // The first tab now shows the new account, without Alice's editor or text.
  await expect(a.locator('.me .who')).toContainText(mallory);
  await expect(a.locator('iframe[data-testid=name-input-frame]')).toHaveCount(0);
  await expect(a.locator('.me .who')).not.toContainText('Alice Unsaved Rename');
});

test('an edit started before a newer edit elsewhere is refused, not saved over it', async ({ alice }) => {
  const path = uniquePath('article');
  const a = await alice.open(path);
  await alice.signIn(a);
  await createThread(a, 'Open annotation standard', 'Original text');
  // Tab A starts editing.
  const cardA = a.locator('[data-testid=thread-card]');
  await cardA.locator('[data-testid=comment]').first().hover();
  await cardA.locator('[data-testid=edit]').click();
  const editA = cardA.frameLocator('iframe[data-testid=edit-input-frame]').locator('[data-testid=edit-input]');
  await editA.fill('Edit from tab A');
  // Tab B edits the same comment and saves; A receives it live while still editing.
  const b = await alice.open(path);
  await b.mouse.click(...(Object.values(await textCenter(b, 'Open annotation')) as [number, number]));
  const cardB = b.locator('[data-testid=thread-card]');
  await cardB.locator('[data-testid=comment]').first().hover();
  await cardB.locator('[data-testid=edit]').click();
  const editB = cardB.frameLocator('iframe[data-testid=edit-input-frame]').locator('[data-testid=edit-input]');
  await editB.fill('Edit from tab B');
  await editB.press('Enter');
  await expect(cardB.locator('[data-testid=comment-body]').first()).toHaveText('Edit from tab B');
  await a.waitForTimeout(1500);
  // A submits its (stale) edit: refused, kept visible as not saved.
  await editA.press('Enter');
  await expect(cardA.locator('.c-status.failed')).toContainText('changed elsewhere', { timeout: 15_000 });
  const token = await alice.sw.evaluate(async () => ((await chrome.storage.local.get('session')).session as { token: string }).token);
  const key = encodeURIComponent(`localhost:18902${path}`);
  const r = await (await fetch(`${API}/api/threads?key=${key}`, { headers: { authorization: `Bearer ${token}` } })).json();
  expect(r.threads[0].comments[0].body).toBe('Edit from tab B');
});

