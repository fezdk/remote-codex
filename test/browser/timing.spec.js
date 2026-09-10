import { test, expect } from '@playwright/test';
test.use({ timezoneId: 'Europe/Copenhagen' });
const start = Date.parse('2026-09-10T10:00:00Z') / 1000;
const user = { id: 'time-user', type: 'userMessage', content: [{ type: 'text', text: 'Show task timing' }] };
const interim = { id: 'time-interim', type: 'agentMessage', text: 'Working on it.' };
const steer = { id: 'time-steer', type: 'userMessage', content: [{ type: 'text', text: 'Include the duration' }] };
const final = { id: 'time-final', type: 'agentMessage', text: 'Timing is visible.' };
const task = { id: 'time-turn', status: 'completed', startedAt: start, completedAt: start + 133, durationMs: 133450, items: [user, interim, steer, final] };
async function open(page, turns = [task]) {
  await page.addInitScript(() => { const Native = window.EventSource; window.EventSource = class extends Native { constructor(url) { super(url); window.timingStream = this; } }; });
  await page.route('**/session-one/turns', route => route.fulfill({ json: { data: turns, nextCursor: null } }));
  await page.goto('/#session=session-one'); await page.locator('#access-key').fill('browser-test-access-key-123456789');
  await page.locator('#login-form button[type=submit]').click(); await expect(page.locator('#session-status')).toBeVisible();
  await expect(page.locator('#messages .turn-timing')).toHaveCount(turns.length);
}
async function event(page, method, params) {
  await page.evaluate(message => window.timingStream.dispatchEvent(new MessageEvent('codex', { data: JSON.stringify(message) })), { method, params: { threadId: 'session-one', ...params } });
}

test('stored task timestamps and duration survive reload, translate, and fit mobile in both themes', async ({ page }) => {
  await open(page);
  const first = page.locator('[data-item-id=time-user] time');
  const last = page.locator('[data-item-id=time-final] time');
  await expect(first).toHaveText('Start 12.00.00');
  await expect(first).toHaveAttribute('datetime', '2026-09-10T10:00:00.000Z');
  await expect(first).toHaveAttribute('title', /10\. september 2026/);
  await expect(last).toHaveText('Slut 12.02.13');
  await expect(page.locator('.turn-duration')).toHaveText('Varighed: 2 min 13 s');
  await expect(page.locator('[data-item-id=time-interim] .message-time')).toHaveText('—');
  await expect(page.locator('[data-item-id=time-steer] .message-time')).toHaveText('—');
  await page.locator('#workspace [data-language-select]').selectOption('en');
  await expect(first).toHaveText('Started 12:00:00');
  await expect(page.locator('.turn-duration')).toHaveText('Duration: 2 min 13 s');
  await page.reload(); await expect(page.locator('.turn-duration')).toHaveText('Duration: 2 min 13 s');
  await page.setViewportSize({ width: 320, height: 740 });
  if (await page.locator('#close-changes').isVisible()) await page.locator('#close-changes').click();
  for (let i = 0; i < 2; i++) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#workspace [data-theme-toggle]').click();
  }
  await page.locator('.turn-duration').scrollIntoViewIfNeeded();
  await expect(page.locator('.turn-duration')).toBeVisible();
  await page.screenshot({ path: 'test-results/timing-mobile.png' });
});

test('live elapsed time updates without replacing messages or drafts and stops at server completion', async ({ page }) => {
  await page.clock.install({ time: new Date((start + 5) * 1000) });
  await open(page, [{ ...task, status: 'inProgress', completedAt: null, durationMs: null, items: [user] }]);
  await expect(page.locator('.turn-duration')).toHaveText('Forløbet: 5 s');
  await page.locator('#message').fill('Keep my draft');
  await page.evaluate(() => { window.originalTimingMessage = document.querySelector('[data-item-id=time-user]'); });
  await page.clock.runFor(3000);
  await expect(page.locator('.turn-duration')).toHaveText('Forløbet: 8 s');
  expect(await page.evaluate(() => window.originalTimingMessage === document.querySelector('[data-item-id=time-user]'))).toBe(true);
  await expect(page.locator('#message')).toHaveValue('Keep my draft');
  await event(page, 'item/started', { turnId: task.id, item: interim });
  await expect(page.locator('[data-item-id=time-interim] time')).toHaveText('Set 12.00.08');
  await page.clock.runFor(2000);
  await event(page, 'turn/completed', { turn: task });
  await expect(page.locator('.turn-duration')).toHaveText('Varighed: 2 min 13 s');
  await page.clock.runFor(3000);
  await expect(page.locator('.turn-duration')).toHaveText('Varighed: 2 min 13 s');
  await expect(page.locator('[data-item-id=time-interim] time')).toHaveText('Set 12.00.08');
  await expect(page.locator('#message')).toHaveValue('Keep my draft');
});

test('missing timestamps stay unknown, zero duration is valid, and interrupted/failed tasks are labelled', async ({ page }) => {
  await open(page, [
    { ...task, id: 'missing', startedAt: null, completedAt: null, durationMs: null, items: [user] },
    { ...task, id: 'zero', startedAt: null, completedAt: null, durationMs: 0, items: [] },
    { ...task, id: 'interrupted', status: 'interrupted', durationMs: null, items: [] },
    { ...task, id: 'failed', status: 'failed', durationMs: 3601000, items: [] },
  ]);
  await expect(page.locator('[data-item-id=time-user] .message-time')).toHaveText('—');
  await expect(page.locator('.turn-timing[data-turn-id=missing] .turn-duration')).toHaveText('Varighed ikke registreret');
  await expect(page.locator('.turn-timing[data-turn-id=zero] .turn-duration')).toHaveText('Varighed: 0 s');
  await expect(page.locator('.turn-timing[data-turn-id=interrupted] .turn-duration')).toHaveText('Afbrudt efter 2 min 13 s');
  await expect(page.locator('.turn-timing[data-turn-id=failed] .turn-duration')).toHaveText('Fejlet efter 1 t 0 min 1 s');
});
