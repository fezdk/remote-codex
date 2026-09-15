import { test, expect } from '@playwright/test';

async function login(page) {
  await page.goto('/#session=session-one');
  await page.locator('#access-key').fill('browser-test-access-key-123456789');
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#model-select')).toBeEnabled();
  await page.request.post('/api/threads/session-one/settings', { data: { model: 'local-model', effort: 'medium' } });
  await expect(page.locator('#effort-select')).toHaveValue('medium');
  if (await page.locator('#interrupt').isVisible()) { await page.locator('#interrupt').click(); await expect(page.locator('#session-status')).toHaveText('Klar'); }
}

test('model and effort use catalog options, persist per session, preserve drafts and leave active work running', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await login(page);
  await expect(page.locator('#model-select option')).toHaveText(['Demo model', 'Demo fast']);
  await page.locator('#message').fill('Keep this draft');
  await page.locator('#effort-select').selectOption('high');
  await expect(page.locator('#effort-select')).toBeEnabled();
  await page.locator('#model-select').selectOption('demo-fast');
  await expect(page.locator('#effort-select')).toHaveValue('low');
  await expect(page.locator('#model-select')).toBeEnabled();
  await expect(page.locator('#effort-select option')).toHaveCount(1);
  await expect(page.locator('#message')).toHaveValue('Keep this draft');
  await page.reload(); await expect(page.locator('#model-select')).toHaveValue('demo-fast'); await expect(page.locator('#effort-select')).toHaveValue('low');
  await page.getByRole('button', { name: /Mit andet projekt/ }).click(); await expect(page.locator('#model-select')).toHaveValue('local-model');
  await page.getByRole('button', { name: /Byg et browser-UI/ }).click(); await expect(page.locator('#model-select')).toHaveValue('demo-fast');
  await page.locator('#message').fill('long'); await page.locator('#send').click(); await expect(page.locator('#interrupt')).toBeVisible();
  await expect(page.locator('#model-select')).toBeEnabled();
  await page.locator('#model-select').selectOption('local-model'); await expect(page.locator('#effort-select')).toHaveValue('medium');
  await expect(page.locator('#model-select')).toBeEnabled();
  await expect(page.locator('#interrupt')).toBeVisible(); await expect(page.locator('#models-status')).toContainText('efterfølgende turns');
  await page.locator('#interrupt').click(); await expect(page.locator('#session-status')).toHaveText('Klar');
  expect(errors).toEqual([]);
});

test('a newer settings event wins over a delayed acknowledgement and sending waits without losing a draft', async ({ page }) => {
  await login(page);
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/session-one/settings', async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }); });
  try {
    await page.locator('#model-select').selectOption('demo-fast'); await expect(page.locator('#models-status')).toContainText('Gemmer');
    await page.locator('#message').fill('Text typed while saving'); await expect(page.locator('#send')).toBeDisabled();
    await page.request.post('/api/threads/session-one/settings', { data: { model: 'local-model', effort: 'high' } });
    await expect(page.locator('#model-label')).toContainText('high');
  } finally { release(); }
  await expect(page.locator('#model-select')).toBeEnabled();
  await expect(page.locator('#model-select')).toHaveValue('local-model'); await expect(page.locator('#effort-select')).toHaveValue('high');
  await expect(page.locator('#message')).toHaveValue('Text typed while saving'); await expect(page.locator('#send')).toBeEnabled();
  await page.unroute('**/session-one/settings');
});

test('failed catalog and settings requests retain current values, allow retry and fit mobile in both languages', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await login(page);
  await page.locator('#composer-options-toggle').click();
  await page.locator('#message').fill('Preserved on failure');
  await page.route('**/session-one/settings', route => route.request().method() === 'POST' ? route.fulfill({ status: 409, json: { error: 'Synthetic catalog change', errorKey: 'models.unavailable' } }) : route.continue());
  await page.locator('#model-select').selectOption('demo-fast');
  await expect(page.locator('#notice')).toContainText('Ændringen kunne ikke bekræftes');
  await expect(page.locator('#model-select')).toHaveValue('local-model'); await expect(page.locator('#effort-select')).toHaveValue('medium');
  await expect(page.locator('#message')).toHaveValue('Preserved on failure');
  await expect(page.locator('#models-refresh')).toBeVisible();
  await page.locator('#models-refresh').click(); await expect(page.locator('#models-refresh')).toBeHidden();
  await page.unroute('**/session-one/settings');
  await page.route('**/api/models', route => route.fulfill({ status: 503, json: { error: 'Synthetic catalog failure' } }));
  await page.reload(); await expect(page.locator('#models-status')).toContainText('Model-listen kunne ikke hentes');
  await page.locator('#composer-options-toggle').click();
  await expect(page.locator('#model-select')).toBeDisabled(); await expect(page.locator('#model-select')).toHaveValue('local-model');
  await page.unroute('**/api/models'); await page.locator('#models-refresh').click(); await expect(page.locator('#model-select')).toBeEnabled();
  await page.locator('#workspace [data-language-select]').selectOption('en');
  await expect(page.getByLabel('Effort', { exact: true })).toBeVisible(); await expect(page.locator('#effort-select option')).toHaveText(['Medium', 'High']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#workspace [data-theme-toggle]').click();
  await page.screenshot({ path: 'test-results/model-picker-mobile.png' });
});

test('switching sessions and logging out during an update cannot repopulate the wrong composer', async ({ page }) => {
  await login(page);
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/session-one/settings', async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }); });
  try {
    await page.locator('#model-select').selectOption('demo-fast'); await expect(page.locator('#model-select')).toBeDisabled();
    await page.getByRole('button', { name: /Mit andet projekt/ }).click();
    await expect(page.locator('#model-select')).toHaveValue('local-model'); await expect(page.locator('#model-select')).toBeEnabled();
    await page.locator('#message').fill('Draft for the other session');
  } finally { release(); }
  await expect(page.locator('#message')).toHaveValue('Draft for the other session');
  await expect(page.locator('#model-select')).toHaveValue('local-model');
  await page.unroute('**/session-one/settings');
  await page.getByRole('button', { name: /Byg et browser-UI/ }).click(); await expect(page.locator('#model-select')).toHaveValue('demo-fast');
  let finish; const delayed = new Promise(resolve => { finish = resolve; });
  await page.route('**/session-one/settings', async route => { const response = await route.fetch(); await delayed; await route.fulfill({ response }); });
  try {
    await page.locator('#model-select').selectOption('local-model');
    await page.request.post('/api/logout', { data: {} }); await expect(page.locator('#login')).toBeVisible();
  } finally { finish(); }
  await expect(page.locator('#model-select option')).toHaveCount(1); await expect(page.locator('#model-select')).toHaveValue('');
  await expect(page.locator('#message')).toHaveValue('');
});
