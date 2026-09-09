import { test, expect } from '@playwright/test';

async function start(page) {
  await page.goto('/'); await page.locator('#access-key').fill('browser-test-access-key-123456789');
  await page.getByRole('button', { name: 'Forbind til Codex' }).click();
  await page.getByRole('button', { name: /Byg et browser-UI/ }).click();
  await expect(page.locator('#session-status')).toHaveText('Klar');
  await page.locator('#message').fill('long'); await page.locator('#send').click();
  await expect(page.locator('#interrupt')).toBeVisible(); await expect(page.locator('#message')).toHaveValue('');
}
async function stop(page) {
  await page.locator('#interrupt').click(); await expect(page.locator('#interrupt')).toBeHidden();
}
const pending = page => page.locator('#messages .pending-steer');
const copies = (page, text) => page.locator('#messages .message.user .message-body').filter({ hasText: text });

test('accepted steers stay in the chat across session switches and reconcile identical messages once each', async ({ page }) => {
  await start(page);
  const submissions = [];
  await page.route('**/message', route => {
    const data = route.request().postDataJSON(); submissions.push(data);
    return route.fulfill({ json: { turnId: data.turnId } });
  });
  for (let count = 1; count <= 2; count++) {
    await page.locator('#message').fill('identical delayed steer'); await page.locator('#steer').click();
    await expect(pending(page)).toHaveCount(count);
    await expect(pending(page).last()).toHaveAttribute('data-delivery-state', 'accepted');
    await expect(page.locator('#message')).toHaveValue('');
  }
  await page.locator('#message').press('ArrowUp'); await expect(page.locator('#message')).toHaveValue('identical delayed steer');
  await expect(page.locator('#edit-mode')).toBeHidden();
  await page.locator('#message').fill('keep typing while steers wait'); await expect(page.locator('#steer')).toBeEnabled();
  await page.getByRole('button', { name: /Mit andet projekt/ }).click(); await expect(pending(page)).toHaveCount(0);
  await page.getByRole('button', { name: /Byg et browser-UI/ }).click();
  await expect(pending(page)).toHaveCount(2); await expect(page.locator('#message')).toHaveValue('keep typing while steers wait');
  await page.locator('#workspace [data-language-select]').selectOption('en');
  await expect(pending(page).first()).toContainText('Steer sent · waiting to appear in the conversation');
  for (let index = 0; index < 2; index++) {
    // APIRequestContext bypasses page routes: now deliver the previously acknowledged text.
    const response = await page.request.post('/api/threads/session-one/message', { data: submissions[index] }); expect(response.ok()).toBe(true);
    await expect(pending(page)).toHaveCount(1 - index);
    await expect(copies(page, 'identical delayed steer')).toHaveCount(2);
  }
  await stop(page);
});

test('queue-to-steer is visible before the HTTP reply and remains until the real conversation event', async ({ page }) => {
  await start(page);
  await page.locator('#message').fill('convert this delayed instruction'); await page.locator('#send').click();
  await expect(page.locator('#queue-list')).toContainText('convert this delayed instruction');
  let release, submitted;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/message', async route => { submitted = route.request().postDataJSON(); await gate; await route.fulfill({ json: { turnId: submitted.turnId } }); });
  try {
    await page.getByRole('button', { name: 'Send som steer', exact: true }).click();
    await expect(pending(page)).toContainText('convert this delayed instruction');
    await expect(pending(page)).toHaveAttribute('data-delivery-state', 'sending');
    await expect(page.locator('#queue-list')).toBeEmpty();
    await page.locator('#message').fill('my next draft');
  } finally { release(); }
  await expect(pending(page)).toHaveAttribute('data-delivery-state', 'accepted');
  await expect(page.locator('#steer')).toBeEnabled(); await expect(page.locator('#message')).toHaveValue('my next draft');
  const response = await page.request.post('/api/threads/session-one/message', { data: submitted }); expect(response.ok()).toBe(true);
  await expect(pending(page)).toHaveCount(0); await expect(copies(page, 'convert this delayed instruction')).toHaveCount(1);
  await stop(page);
});

test('failed steer keeps its text recoverable and logout clears accepted display entries', async ({ page }) => {
  await start(page);
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/message', async route => { await gate; await route.fulfill({ status: 503, json: { error: 'Synthetic failed steer' } }); });
  try {
    await page.locator('#message').fill('unconfirmed steer text'); await page.locator('#steer').click();
    await expect(pending(page)).toContainText('Sender steer…');
    await page.locator('#message').fill('do not replace this draft');
  } finally { release(); }
  await expect(pending(page)).toHaveCount(0); await expect(page.locator('#queue-list')).toContainText('unconfirmed steer text');
  await expect(page.locator('#queue-list')).toContainText('Afsendelsen blev ikke bekræftet');
  await expect(page.locator('#message')).toHaveValue('do not replace this draft');
  await page.unroute('**/message');
  await page.route('**/message', route => route.fulfill({ json: { turnId: route.request().postDataJSON().turnId } }));
  await page.locator('#steer').click(); await expect(pending(page)).toHaveAttribute('data-delivery-state', 'accepted');
  await stop(page); await page.locator('#logout').click();
  await expect(page.locator('#login')).toBeVisible(); await expect(page.locator('#messages')).toBeEmpty();
});
