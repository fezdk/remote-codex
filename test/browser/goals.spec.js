import { test, expect } from '@playwright/test';
async function login(page) {
  await page.goto('/#session=session-one');
  await page.locator('#access-key').fill('browser-test-access-key-123456789');
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#goal-button')).toBeEnabled();
  const current = await (await page.request.get('/api/threads/session-one/goal')).json();
  if (current.goal) await page.request.post('/api/threads/session-one/goal', { data: { action: 'clear', version: current.version } });
  if (await page.locator('#interrupt').isVisible()) await page.locator('#interrupt').click();
  await page.locator('#goal-button').click(); await expect(page.locator('#goal-objective')).toBeEnabled();
}
async function create(page) {
  await page.locator('#goal-objective').fill('Finish the synthetic Goal');
  await page.locator('#goal-budget').fill('40000');
  await page.locator('#goal-save').click(); await expect(page.locator('#goal-state')).toHaveText('Aktivt');
  await expect(page.locator('#goal-pause')).toBeEnabled();
}
test('Goal remains the feature name in Danish and English; native lifecycle, form edits, drafts and mobile layout work', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await login(page); await create(page);
  await page.locator('#goal-objective').fill('An unsaved edit');
  await page.locator('#goal-pause').click(); await expect(page.locator('#goal-state')).toHaveText('På pause');
  await expect(page.locator('#goal-objective')).toHaveValue('An unsaved edit'); await expect(page.locator('#goal-save')).toBeEnabled();
  await page.locator('#goal-refresh').click(); await expect(page.locator('#goal-objective')).toHaveValue('Finish the synthetic Goal');
  await page.locator('#goal-budget').fill(''); await page.locator('#goal-save').click();
  await expect(page.locator('#goal-facts')).toContainText('Intet budget');
  await page.locator('#goal-resume').click(); await expect(page.locator('#goal-state')).toHaveText('Aktivt');
  await page.locator('#goal-complete').click(); await expect(page.locator('#goal-state')).toHaveText('Færdigt');
  await page.locator('#goal-close').click(); await page.locator('#message').fill('Keep my chat draft');
  await page.locator('#goal-button').click(); await page.locator('#goal-clear').click();
  await expect(page.locator('#goal-clear-confirm')).toBeVisible();
  await page.locator('#goal-clear-yes').click(); await expect(page.locator('#goal-state')).toHaveText('Intet Goal i denne session');
  await page.locator('#goal-close').click(); await expect(page.locator('#message')).toHaveValue('Keep my chat draft');
  await expect(page.locator('#goal-button')).toHaveText('Goal');
  await page.locator('#workspace [data-language-select]').selectOption('en');
  await expect(page.locator('#goal-button')).toHaveText('Goal');
  await page.setViewportSize({ width: 320, height: 844 });
  if (await page.locator('#close-changes').isVisible()) await page.locator('#close-changes').click();
  await page.locator('#goal-button').click();
  await expect(page.locator('#goal-state')).toHaveText('No Goal in this session');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.getElementById('goal-dialog').scrollWidth <= document.getElementById('goal-dialog').clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/goal-mobile.png' });
  expect(errors).toEqual([]);
});

test('external Goal updates preserve typed edits and stale reads cannot undo live state', async ({ page }) => {
  await login(page); await create(page);
  await page.locator('#goal-objective').fill('Local unsaved objective');
  await page.locator('#goal-clear').click(); await expect(page.locator('#goal-clear-confirm')).toBeVisible();
  const old = await (await page.request.get('/api/threads/session-one/goal')).json();
  await page.request.post('/api/threads/session-one/goal', { data: { action: 'update', version: old.version, objective: '<img src=x onerror=alert(1)> Other client', tokenBudget: 50000 } });
  await expect(page.locator('#goal-current')).toHaveText('<img src=x onerror=alert(1)> Other client');
  await expect(page.locator('#goal-clear-confirm')).toBeHidden();
  await expect(page.locator('#goal-objective')).toHaveValue('Local unsaved objective');
  await expect(page.locator('#goal-error')).toContainText('ændret siden'); await expect(page.locator('#goal-save')).toBeDisabled();
  expect(await page.locator('#goal-current img').count()).toBe(0);
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/session-one/goal', async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }); });
  try {
    await page.locator('#goal-refresh').click();
    const current = await (await page.request.get('/api/threads/session-one/goal')).json();
    await page.request.post('/api/threads/session-one/goal', { data: { action: 'status', version: current.version, status: 'paused' } });
    await expect(page.locator('#goal-dot')).toHaveAttribute('data-status', 'paused');
  } finally { release(); }
  await expect(page.locator('#goal-state')).toHaveText('På pause'); await expect(page.locator('#goal-save')).toBeDisabled();
  await page.unroute('**/session-one/goal');
});

test('failed acknowledgements read back without replay and stopping a turn is separate from pausing a Goal', async ({ page }) => {
  await login(page); await create(page);
  let count = 0;
  await page.route('**/session-one/goal', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    ++count; await route.fetch(); await route.fulfill({ status: 502, json: { error: 'Synthetic lost acknowledgement' } });
  });
  await page.locator('#goal-pause').click(); await expect(page.locator('#goal-error')).toContainText('Handlingen kunne ikke bekræftes');
  await expect(page.locator('#goal-state')).toHaveText('På pause'); expect(count).toBe(1);
  await page.unroute('**/session-one/goal'); await page.locator('#goal-close').click();
  await page.locator('#message').fill('long'); await page.locator('#send').click(); await expect(page.locator('#interrupt')).toBeVisible();
  await page.locator('#goal-button').click(); await expect(page.locator('#goal-stop')).toBeEnabled();
  await page.locator('#goal-stop').click(); await expect(page.locator('#goal-stop')).toBeDisabled();
  await expect(page.locator('#goal-state')).toHaveText('På pause');
  await page.locator('#goal-close').click(); await page.locator('#message').fill('/goal'); await page.locator('#send').click();
  await expect(page.locator('#goal-dialog')).toBeVisible(); await expect(page.locator('#message')).toHaveValue('');
});

test('switching sessions and logout ignore delayed Goal replies; unavailable servers leave chat usable', async ({ page }) => {
  await login(page); await create(page); await page.locator('#goal-close').click();
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/session-one/goal', async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }); });
  try {
    await page.locator('#goal-button').click(); await page.locator('#goal-close').click();
    await page.getByRole('button', { name: /Mit andet projekt/ }).click(); await page.locator('#goal-button').click();
    await expect(page.locator('#goal-state')).toHaveText('Intet Goal i denne session');
  } finally { release(); }
  await expect(page.locator('#goal-objective')).toHaveValue(''); await expect(page.locator('#goal-dot')).toBeHidden();
  await page.locator('#goal-close').click();
  await page.route('**/session-two/goal', route => route.fulfill({ status: 502, json: { error: 'Unsupported method' } }));
  await page.locator('#goal-button').click(); await expect(page.locator('#goal-error')).toContainText('Unsupported method');
  await expect(page.locator('#goal-save')).toBeDisabled(); await page.locator('#goal-close').click();
  await page.locator('#message').fill('Chat still works'); await expect(page.locator('#send')).toBeEnabled();
  await page.request.post('/api/logout', { data: {} }); await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('#goal-objective')).toHaveValue(''); await expect(page.locator('#goal-dialog')).toBeHidden();
});
