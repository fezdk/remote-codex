import { test, expect } from '@playwright/test';

const turn = items => ({ id: 'delivery-turn', status: 'inProgress', startedAt: 2000000000, items });
const user = (id, clientId, text) => ({ id, clientId, type: 'userMessage', content: [{ type: 'text', text }] });
const copies = (page, text) => page.locator('#messages .message.user .message-body, #queue-list .queue-text').filter({ hasText: text });
async function event(page, method, params) {
  await page.evaluate(message => window.deliveryStream.dispatchEvent(new MessageEvent('codex', { data: JSON.stringify(message) })), { method, params: { threadId: 'session-one', ...params } });
}
async function start(page) {
  await page.addInitScript(() => { const Native = window.EventSource; window.EventSource = class extends Native { constructor(url) { super(url); window.deliveryStream = this; } }; });
  await page.route('**/session-one/turns', route => route.fulfill({ json: { data: [], nextCursor: null } }));
  await page.route('**/session-one/queue', route => route.fulfill({ json: { data: [], nextCursor: null } }));
  await page.goto('/#session=session-one'); await page.locator('#access-key').fill('browser-test-access-key-123456789');
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#session-status')).toHaveText('Klar');
}

for (const send of ['arrow', 'Enter']) test(`${send}: live delivery and history show one message before a delayed acknowledgement`, async ({ page }) => {
  await start(page);
  let release, submitted, stored = [], reads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/session-one/turns', route => { reads++; return route.fulfill({ json: { data: stored, nextCursor: null } }); });
  await page.route('**/session-one/message', async route => {
    submitted = route.request().postDataJSON(); await gate;
    await route.fulfill({ json: { turn: turn([user('ack-user', submitted.clientId, submitted.text)]) } });
  });
  try {
    await page.locator('#message').fill('A synthetic normal submission');
    if (send === 'arrow') await page.locator('#send').click(); else await page.locator('#message').press('Enter');
    await expect.poll(() => submitted?.clientId).toMatch(/^[a-f0-9]{32}$/);
    const live = user('live-user', submitted.clientId, submitted.text);
    stored = [turn([{ ...live, id: 'history-user' }])];
    // No individual item event: a full turn itself acknowledges receipt.
    await event(page, 'turn/started', { turn: turn([live]) });
    await expect(copies(page, submitted.text)).toHaveCount(1);
    await expect(page.locator('#queue-area')).toBeHidden();
    await expect.poll(() => reads).toBeGreaterThan(0);
    await event(page, 'item/completed', { turnId: 'delivery-turn', item: { ...live, id: 'persisted-user' } });
    await expect(copies(page, submitted.text)).toHaveCount(1);
    await page.locator('#message').fill('Keep the next draft');
  } finally { release(); }
  await expect(page.locator('#send')).toBeEnabled();
  await expect(copies(page, submitted.text)).toHaveCount(1);
  await expect(page.locator('#message')).toHaveValue('Keep the next draft');
  await expect(page.locator('#interrupt')).toBeVisible();
});

test('a queue listing replaces its pending card and a live message replaces a stale queue listing', async ({ page }) => {
  await start(page); await event(page, 'turn/started', { turn: turn([]) });
  let release, submitted, queued = [];
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/session-one/queue', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { data: queued, nextCursor: null } });
    submitted = route.request().postDataJSON();
    queued = [{ id: 'native-queued', clientUserMessageId: submitted.clientId, input: [{ type: 'text', text: submitted.text }] }];
    await gate; await route.fulfill({ json: { queuedSubmission: queued[0] } });
  });
  try {
    await page.locator('#message').fill('A synthetic queued submission'); await page.locator('#send').click();
    await expect.poll(() => submitted?.clientId).toMatch(/^[a-f0-9]{32}$/);
    await event(page, 'thread/queue/changed', {});
    await expect(page.locator('[data-queue-id="native-queued"]')).toBeVisible();
    await expect(copies(page, submitted.text)).toHaveCount(1);
    await event(page, 'item/completed', { turnId: 'delivery-turn', item: user('delivered-user', submitted.clientId, submitted.text) });
    await expect(page.locator('#queue-area')).toBeHidden();
    await expect(copies(page, submitted.text)).toHaveCount(1);
  } finally { release(); }
  await expect(page.locator('#message')).toHaveValue('');
  // Refresh still returns the stale queue item, but must not render it again.
  const response = page.waitForResponse(response => response.url().endsWith('/session-one/queue') && response.request().method() === 'GET');
  await event(page, 'thread/queue/changed', {}); await response;
  await expect(page.locator('#queue-area')).toBeHidden();
  await expect(copies(page, submitted.text)).toHaveCount(1);
});

test('wide windows align queued cards and pending steers with the conversation column', async ({ page }) => {
  await page.setViewportSize({ width: 2200, height: 1200 });
  await start(page);
  await event(page, 'turn/started', { turn: turn([user('initial-user', 'initial-client', 'An ordinary user message')]) });
  await page.route('**/session-one/queue', route => route.fulfill({ json: { data: [{ id: 'queued', clientUserMessageId: 'queued-client', input: [{ type: 'text', text: 'An instruction waiting in the queue' }] }], nextCursor: null } }));
  await event(page, 'thread/queue/changed', {});
  await page.route('**/session-one/message', route => route.fulfill({ json: { turnId: 'delivery-turn' } }));
  await page.locator('#message').fill('A pending steer instruction'); await page.locator('#steer').click();
  await expect(page.locator('.pending-steer')).toHaveAttribute('data-delivery-state', 'accepted');
  await expect(page.locator('#queue-area')).toBeVisible();
  const ordinary = await page.locator('[data-item-id="initial-user"]').boundingBox();
  const pending = await page.locator('.pending-steer').boundingBox();
  const queue = await page.locator('#queue-area').boundingBox();
  expect(Math.abs(pending.x - ordinary.x)).toBeLessThan(2);
  expect(Math.abs(pending.width - ordinary.width)).toBeLessThan(2);
  expect(Math.abs(queue.x - ordinary.x)).toBeLessThan(2);
  expect(Math.abs(queue.width - ordinary.width)).toBeLessThan(20); // timeline scrollbar gutter
  await page.screenshot({ path: 'test-results/delivery-wide.png' });
});
