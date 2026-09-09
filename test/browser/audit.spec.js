import { test, expect } from '@playwright/test';

async function login(page) {
  await page.goto('/');
  await page.locator('#access-key').fill('browser-test-access-key-123456789');
  await page.getByRole('button', { name: 'Forbind til Codex' }).click();
  await page.getByRole('button', { name: /Byg et browser-UI/ }).click();
  await expect(page.locator('#message')).toBeEnabled();
  await expect(page.locator('#session-status')).toHaveText('Klar');
}
async function startLong(page) {
  await page.locator('#message').fill('long'); await page.locator('#send').click();
  await expect(page.locator('#interrupt')).toBeVisible();
  await expect(page.locator('#message')).toHaveValue('');
}
async function stop(page) {
  await page.locator('#interrupt').click(); await expect(page.locator('#session-status')).toHaveText('Klar');
}

test('late send acknowledgement preserves the next draft across session switches', async ({ page }) => {
  await login(page); await startLong(page);
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/message', async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }); });
  try {
    await page.locator('#message').fill('sent before switching'); await page.locator('#steer').click();
    await expect(page.locator('#messages')).toContainText('sent before switching');
    await page.locator('#message').fill('keep this next draft');
    await page.getByRole('button', { name: /Mit andet projekt/ }).click();
    await expect(page.locator('#session-title')).toHaveText('Mit andet projekt');
  } finally { release(); }
  await expect(page.locator('#queue-list')).toBeEmpty();
  await page.getByRole('button', { name: /Byg et browser-UI/ }).click();
  await expect(page.locator('#message')).toHaveValue('keep this next draft');
  await stop(page);
});

test('withdrawing and finishing an edit keeps displaced drafts recoverable', async ({ page }) => {
  await login(page); await startLong(page);
  await page.locator('#message').fill('queued text'); await page.locator('#send').click();
  await expect(page.locator('#queue-list')).toContainText('queued text');
  await page.locator('#message').fill('original composer draft');
  await page.getByRole('button', { name: 'Tag ud af kø og redigér', exact: true }).click();
  await expect(page.locator('#message')).toHaveValue('queued text');
  await expect(page.locator('#queue-list')).toContainText('original composer draft');
  await page.locator('#message').fill('edited withdrawn text'); await page.locator('#done-editing').click();
  await expect(page.locator('#message')).toHaveValue('original composer draft');
  await expect(page.locator('#queue-list')).toContainText('edited withdrawn text');
  await expect(page.locator('#edit-mode')).toBeHidden(); await stop(page);
});

test('logout invalidates in-flight queue actions and closes the project dialog on expiry', async ({ page }) => {
  await login(page); await startLong(page);
  await page.locator('#message').fill('do not steer after logout'); await page.locator('#send').click();
  await expect(page.locator('#queue-list')).toContainText('do not steer after logout');
  let release, deleted; const gate = new Promise(resolve => { release = resolve; }); const deletion = new Promise(resolve => { deleted = resolve; });
  let sends = 0; page.on('request', request => { if (request.url().endsWith('/message')) sends++; });
  await page.route('**/queue/*/delete', async route => { const response = await route.fetch(); deleted(); await gate; await route.fulfill({ response }).catch(() => {}); });
  try {
    await page.getByRole('button', { name: 'Send som steer', exact: true }).click(); await deletion;
    await page.locator('#logout').click(); await expect(page.locator('#login')).toBeVisible();
  } finally { release(); }
  await page.unroute('**/queue/*/delete', { behavior: 'wait' });
  expect(sends).toBe(0); await expect(page.locator('#queue-list')).toBeEmpty();
  await page.locator('#access-key').fill('browser-test-access-key-123456789'); await page.getByRole('button', { name: 'Forbind til Codex' }).click();
  await page.getByRole('button', { name: /Byg et browser-UI/ }).click(); await stop(page);
  await page.locator('#new-session').click(); await expect(page.locator('#new-dialog')).toBeVisible();
  await page.route('**/api/projects?**', route => route.fulfill({ status: 401, json: { error: 'Expired', errorKey: 'error.login' } }));
  await page.locator('#cwd').fill('/synthetic-expired-session');
  await expect(page.locator('#login')).toBeVisible(); await expect(page.locator('#new-dialog')).not.toBeVisible();
  await expect(page.locator('#messages')).toBeEmpty(); await expect(page.locator('#message')).toHaveValue('');
});

test('question answers and focus survive arrival of an independent approval', async ({ page }) => {
  await page.addInitScript(() => { const Native = window.EventSource; window.EventSource = class extends Native { constructor(...args) { super(...args); window.auditStream = this; } }; });
  await login(page);
  await page.locator('#message').fill('question'); await page.locator('#send').click();
  await page.getByLabel('Hvilken farve?', { exact: true }).fill('retain my unfinished answer');
  await page.evaluate(() => window.auditStream.dispatchEvent(new MessageEvent('codex', { data: JSON.stringify({ id: 99, requestToken: 'synthetic-second-request', method: 'item/commandExecution/requestApproval', params: { threadId: 'session-one', command: 'synthetic second command', availableDecisions: ['decline'] } }) })));
  await expect(page.locator('#requests')).toContainText('synthetic second command');
  await expect(page.getByLabel('Hvilken farve?', { exact: true })).toHaveValue('retain my unfinished answer');
  await expect(page.getByLabel('Hvilken farve?', { exact: true })).toBeFocused();
  await page.getByRole('button', { name: /Mit andet projekt/ }).click();
  await page.getByRole('button', { name: /Byg et browser-UI/ }).click();
  await expect(page.getByLabel('Hvilken farve?', { exact: true })).toHaveValue('retain my unfinished answer');
  await page.getByRole('button', { name: 'Send svar', exact: true }).click();
  await page.evaluate(() => window.auditStream.dispatchEvent(new MessageEvent('codex', { data: JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 'session-one', requestId: 99 } }) })));
  await expect(page.locator('#session-status')).toHaveText('Klar');
});

test('hostile markdown and newline-heavy patches remain bounded and render as text', async ({ page }) => {
  await login(page);
  await page.route('**/session-one/turns', route => route.fulfill({ json: { data: [{ id: 'synthetic-turn', status: 'completed', items: [{ id: 'synthetic-item', type: 'agentMessage', text: '['.repeat(100000) + '\n' + '`'.repeat(100000) + '\n<script>window.compromised=true</script>\n' + 'x'.repeat(100000) }] }], nextCursor: null } }));
  await page.route('**/session-one/changes', route => route.fulfill({ json: { files: [{ path: 'large.txt', kind: 'update', added: 100000, removed: 0, patches: [{ turnId: 'synthetic', diff: '+\n'.repeat(100000) }] }] } }));
  await page.reload();
  await expect(page.locator('#messages')).toContainText('Visningen er forkortet', { timeout: 5000 });
  await page.locator('.changed-file').click();
  await expect(page.locator('.diff-line')).toHaveCount(5000);
  await expect(page.locator('#change-detail')).toContainText('Visningen er begrænset');
  expect(await page.evaluate(() => window.compromised)).toBeUndefined();
  await page.locator('#message').fill('UI remains responsive'); await expect(page.locator('#send')).toBeEnabled();
});

test('a created session still opens when refreshing the session list fails', async ({ page }) => {
  await login(page); await page.locator('#new-session').click();
  await expect(page.locator('#create-session')).toBeEnabled();
  await page.route('**/api/threads?**', route => route.fulfill({ status: 503, json: { error: 'Synthetic list failure' } }));
  let creates = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/threads')) creates++; });
  await page.locator('#create-session').click();
  await expect(page.locator('#new-dialog')).not.toBeVisible(); await expect(page.locator('#session-title')).toHaveText('Ny session');
  await expect(page.locator('#message')).toBeEnabled(); expect(creates).toBe(1);
  await expect(page.locator('#notice')).toContainText('Synthetic list failure');
});

test('an unconfirmed send remains recoverable after typing another draft', async ({ page }) => {
  await login(page);
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/message', async route => { await gate; await route.fulfill({ status: 503, json: { error: 'Synthetic uncertain delivery' } }); });
  try {
    await page.locator('#message').fill('keep this unconfirmed message'); await page.locator('#send').click();
    await expect(page.locator('#queue-list')).toContainText('Sender…');
    await page.locator('#message').fill('a different next draft');
  } finally { release(); }
  await expect(page.locator('#queue-list')).toContainText('keep this unconfirmed message');
  await expect(page.locator('#queue-list')).toContainText('Afsendelsen blev ikke bekræftet');
  await expect(page.locator('#message')).toHaveValue('a different next draft');
});

test('a stalled browser event stream reconnects and resynchronizes after its heartbeat deadline', async ({ page }) => {
  await page.addInitScript(() => { const Native = window.EventSource; window.auditStreams = []; window.EventSource = class extends Native { constructor(...args) { super(...args); window.auditStreams.push(this); } }; });
  await page.clock.install(); await login(page);
  await page.clock.fastForward(46000);
  await expect.poll(() => page.evaluate(() => window.auditStreams.length)).toBe(2);
  await expect(page.locator('#connection-label')).toHaveText('Forbundet');
  await expect(page.locator('#message')).toBeEnabled();
  expect(await page.evaluate(() => window.auditStreams[0].readyState)).toBe(2);
});
