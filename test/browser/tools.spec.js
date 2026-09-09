import { test, expect } from '@playwright/test';

async function login(page) {
  await page.goto('/#session=session-one');
  await page.locator('#access-key').fill('browser-test-access-key-123456789');
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#connection-label')).toHaveText('Forbundet');
  await expect(page.locator('#message')).toBeEnabled();
  if (await page.locator('#interrupt').isVisible()) { await page.locator('#interrupt').click(); await expect(page.locator('#session-status')).toHaveText('Klar'); }
}
const send = async (page, text) => { await page.locator('#message').fill(text); await page.locator('#message').press('Enter'); };

test('commands bypass chat and queue; rename, compaction and server-reported status work', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await login(page);
  const sent = []; page.on('request', req => { if (req.method() === 'POST' && /\/(message|queue)$/.test(req.url())) sent.push(req.url()); });
  await send(page, '/rename Demo command session');
  await expect(page.locator('#session-title')).toHaveText('Demo command session');
  await expect(page.locator('#message')).toHaveValue('');
  await page.reload(); await expect(page.locator('#session-title')).toHaveText('Demo command session');
  await send(page, '/rename Byg et browser-UI'); await expect(page.locator('#session-title')).toHaveText('Byg et browser-UI');
  await send(page, '/compact');
  await expect(page.locator('#notice')).toContainText('Komprimering er startet');
  await expect(page.locator('#session-status')).toHaveText('Klar');
  await send(page, '/status');
  await expect(page.locator('#tools-dialog')).toBeVisible();
  await expect(page.locator('#tools-content')).toContainText('4.567');
  await expect(page.locator('#tools-content')).toContainText('25%');
  await expect(page.locator('#tools-content')).toContainText('ingen beregnet kontekstprocent');
  await page.locator('#tools-close').click();
  await send(page, '/status extra'); await expect(page.locator('#notice')).toContainText('ingen argumenter');
  expect(sent).toEqual([]);
  await page.locator('#message').fill('/ren');
  await expect(page.locator('#input-suggestions')).toContainText('/rename');
  await page.locator('#message').press('Tab'); await expect(page.locator('#message')).toHaveValue('/rename ');
  await page.locator('#message').press('Enter'); await expect(page.locator('#rename-form')).toBeVisible();
  await page.locator('#session-name').fill('Unsubmitted title');
  await page.locator('#tools-close').click();
  await expect(page.locator('#session-title')).toHaveText('Byg et browser-UI');
  expect(errors).toEqual([]);
});

test('skill highlighting and discovery preserve explicit skill inputs through queue editing and steering', async ({ page }) => {
  await login(page);
  await page.locator('#message').fill('Please /review and $ui-polish. `/review` /review/path /rename');
  await expect(page.locator('#input-highlight mark')).toHaveCount(2);
  await expect(page.locator('#input-skill-summary')).toContainText('review, ui-polish');
  await page.locator('#message').fill('Please /rev');
  await expect(page.locator('#input-suggestions')).toContainText('/review');
  await page.locator('#message').press('Escape'); await expect(page.locator('#input-suggestions')).toBeHidden();
  await page.locator('#message').press('ArrowLeft'); await page.locator('#message').press('ArrowRight');
  await expect(page.locator('#input-suggestions')).toBeVisible();
  await page.locator('#message').press('Tab'); await expect(page.locator('#message')).toHaveValue('Please /review ');
  await send(page, 'long'); await expect(page.locator('#interrupt')).toBeVisible();
  await send(page, 'Then /review with $ui-polish');
  await expect(page.locator('#queue-list')).toContainText('Then /review with $ui-polish');
  await page.locator('#message').press('ArrowUp'); await expect(page.locator('#edit-mode')).toBeVisible();
  await expect(page.locator('#message')).toHaveValue('Then /review with $ui-polish');
  await expect(page.locator('#input-highlight mark')).toHaveCount(2);
  await page.locator('#message').press('Enter'); await expect(page.locator('#queue-list')).toContainText('Then /review with $ui-polish');
  const steering = page.waitForRequest(req => req.url().endsWith('/message') && req.method() === 'POST');
  await page.getByRole('button', { name: 'Send som steer', exact: true }).click();
  expect((await steering).postDataJSON().skills).toEqual(['review', 'ui-polish']);
  await expect(page.locator('#messages')).toContainText('Then /review with $ui-polish');
  await expect(page.locator('#queue-list')).toBeEmpty();
  await page.locator('#interrupt').click();
  await page.route('**/session-two/skills*', route => route.fulfill({ json: { skills: [], incomplete: false } }));
  await page.getByRole('button', { name: /Mit andet projekt/ }).click();
  await page.locator('#message').fill('Please /review'); await expect(page.locator('#input-highlight mark')).toHaveCount(0);
});

test('mobile highlighting stays aligned; unavailable and stale usage are explicit, and logout clears status', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.locator('#message').fill('Check this with /review, then use $ui-polish.');
  await expect(page.locator('#input-highlight mark')).toHaveCount(2);
  const metrics = await page.locator('#message').evaluate(input => { const mirror = document.getElementById('input-highlight'); return [input.clientWidth, mirror.clientWidth, getComputedStyle(input).fontSize, getComputedStyle(mirror).fontSize]; });
  expect(metrics[0]).toBe(metrics[1]); expect(metrics[2]).toBe(metrics[3]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/skill-highlighting-mobile.png' });
  await page.route('**/session-one/status', async route => { const response = await route.fetch(); const data = await response.json(); data.usage = null; data.limits = null; await route.fulfill({ json: data }); });
  await send(page, '/status'); await expect(page.locator('#tools-content')).toContainText('Afventer tokenoplysninger');
  await page.unroute('**/session-one/status');
  await page.route('**/session-one/status', async route => { const response = await route.fetch(); const data = await response.json(); data.usage = { total: { totalTokens: 123 }, last: { totalTokens: 12 }, modelContextWindow: 1000, updatedAt: 1800000000000, stale: 'compaction' }; await route.fulfill({ json: data }); });
  await page.locator('#tools-refresh').click(); await expect(page.locator('#tools-content')).toContainText('sidst kendte');
  await page.unroute('**/session-one/status');
  await page.request.post('/api/logout', { data: {} });
  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('#tools-dialog')).toBeHidden(); await expect(page.locator('#tools-content')).toBeEmpty();
});

test('failed and delayed commands retain new drafts and do not run commands embedded in prose', async ({ page }) => {
  await login(page);
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/command', async route => { await gate; await route.fulfill({ status: 503, json: { error: 'Synthetic command failure' } }); });
  try {
    await send(page, '/rename Keep original'); await page.locator('#message').fill('My next draft');
  } finally { release(); }
  await expect(page.locator('#notice')).toContainText('Synthetic command failure');
  await expect(page.locator('#message')).toHaveValue('My next draft');
  await page.unroute('**/command');
  await page.locator('#message').fill('Please consider /compact later');
  await expect(page.locator('#input-highlight mark')).toHaveCount(0);
  const message = page.waitForRequest(req => req.url().endsWith('/message') && req.method() === 'POST');
  await page.locator('#message').press('Enter'); expect((await message).postDataJSON().text).toBe('Please consider /compact later');
  await expect(page.locator('#session-status')).toHaveText('Klar');
});
