import { test, expect } from '@playwright/test';
const user = { id: 'synthetic-user', type: 'userMessage', content: [{ type: 'text', text: 'Use the light screenshot' }] };
const agent = { id: 'synthetic-agent', type: 'agentMessage', text: 'Screenshot updated.' };
const turn = (items, status = 'completed') => ({ id: 'synthetic-turn', status, startedAt: 2000000000, items });
const copies = page => page.locator('#messages .message.user .message-body').filter({ hasText: 'Use the light screenshot' });
async function event(page, method, params) {
  await page.evaluate(message => window.historyStream.dispatchEvent(new MessageEvent('codex', { data: JSON.stringify(message) })), { method, params: { threadId: 'session-one', ...params } });
}
async function login(page) {
  await page.addInitScript(() => { const Native = window.EventSource; window.EventSource = class extends Native { constructor(url) { super(url); window.historyStream = this; } }; });
  await page.goto('/#session=session-one'); await page.locator('#access-key').fill('browser-test-access-key-123456789');
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#session-status')).toHaveText('Klar');
}

test('start acknowledgement retains user input after live completion and lagging history refresh', async ({ page }) => {
  await page.route('**/session-one/turns', route => route.fulfill({ json: { data: [], nextCursor: null } }));
  await login(page);
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/session-one/message', async route => { await gate; await route.fulfill({ json: { turn: turn([user], 'inProgress') } }); });
  try {
    await page.locator('#message').fill(user.content[0].text); await page.locator('#send').click();
    await event(page, 'turn/started', { turn: turn([], 'inProgress') });
    await event(page, 'item/completed', { turnId: 'synthetic-turn', item: agent });
    await event(page, 'turn/completed', { turn: turn([agent]) });
    await page.locator('#message').fill('Keep this next draft');
  } finally { release(); }
  await expect(copies(page)).toHaveCount(1); await expect(page.locator('#message')).toHaveValue('Keep this next draft');
  await expect(page.locator('#session-status')).toHaveText('Klar');
  await event(page, 'turn/completed', { turn: { ...turn([agent]), itemsView: 'summary' } });
  await expect(copies(page)).toHaveCount(1);
  await page.waitForResponse(response => response.url().endsWith('/session-one/turns'));
  await expect(copies(page)).toHaveCount(1);
  expect(await page.locator('#messages .message').evaluateAll(nodes => nodes.map(n => n.dataset.itemId))).toEqual(['synthetic-user', 'synthetic-agent']);
});

test('completion recovers a missing user event from history and reload renders it once', async ({ page }) => {
  let stored = [];
  await page.route('**/session-one/turns', route => route.fulfill({ json: { data: stored, nextCursor: null } }));
  await login(page);
  await event(page, 'turn/started', { turn: turn([], 'inProgress') });
  await event(page, 'item/completed', { turnId: 'synthetic-turn', item: agent });
  await expect(copies(page)).toHaveCount(0);
  stored = [turn([user, agent])];
  await event(page, 'turn/completed', { turn: turn([agent]) });
  await page.locator('#message').fill('Preserve my draft during recovery');
  await expect(copies(page)).toHaveCount(1);
  await expect(page.locator('#message')).toHaveValue('Preserve my draft during recovery');
  expect(await page.locator('#messages .message').evaluateAll(nodes => nodes.map(n => n.dataset.itemId))).toEqual(['synthetic-user', 'synthetic-agent']);
  await page.reload(); await expect(copies(page)).toHaveCount(1);
});

test('late background history cannot contaminate another session', async ({ page }) => {
  await login(page);
  let release, requested; const gate = new Promise(resolve => { release = resolve; });
  const request = new Promise(resolve => { requested = resolve; });
  await page.route('**/session-one/turns', async route => { requested(); await gate; await route.fulfill({ json: { data: [turn([user, agent])], nextCursor: null } }); });
  try {
    await event(page, 'turn/completed', { turn: turn([]) }); await request;
    await page.getByRole('button', { name: /Mit andet projekt/ }).click();
    await expect(page.locator('#session-title')).toHaveText('Mit andet projekt');
    await page.locator('#message').fill('Other project draft');
  } finally { release(); }
  await expect(copies(page)).toHaveCount(0); await expect(page.locator('#message')).toHaveValue('Other project draft');
});

test('async question titles appear once while distinct prose and choices remain available', async ({ page }) => {
  const title = 'Which screenshot theme should be shown?';
  await page.route('**/session-one/turns', route => route.fulfill({ json: { data: [turn([{ ...agent, text: title, questions: [{ title, options: ['Light', 'Dark'] }] }])], nextCursor: null } }));
  await login(page);
  await expect(page.getByText(title, { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(page.locator('#message')).toHaveValue('Light');
  await event(page, 'item/completed', { turnId: 'synthetic-turn', item: { ...agent, text: 'A preview is ready.', questions: [{ title, options: [] }] } });
  await expect(page.getByText('A preview is ready.', { exact: true })).toHaveCount(1);
  await expect(page.getByText(title, { exact: true })).toHaveCount(1);
});
