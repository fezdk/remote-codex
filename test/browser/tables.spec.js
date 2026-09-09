import { test, expect } from '@playwright/test';

async function openMessage(page, text) {
  await page.route('**/session-one/turns', route => route.fulfill({ json: { data: [{ id: 'table-turn', status: 'completed', items: [{ id: 'table-item', type: 'agentMessage', text }] }], nextCursor: null } }));
  await page.goto('/#session=session-one');
  await page.locator('#access-key').fill('browser-test-access-key-123456789');
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#messages')).not.toBeEmpty();
}

test('tables support alignment, inline formatting, optional borders and literal HTML without changing code blocks', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await openMessage(page, [
    'Before the table.',
    '',
    '| Feature | State | Count |',
    '| :--- | :---: | ---: |',
    '| **Tables** | `ready` | 3 |',
    '| Escaped \\| pipe | `a|b` | 4 |',
    '| [Docs](https://example.com/docs) | <img src=x onerror="window.compromised=true"> | 5 |',
    '| Missing cells |',
    '| Extra | cells | here | ignored |',
    '',
    'After the table.',
    '',
    'Name | Value',
    '--- | ---',
    'One | Two',
    '',
    '```markdown',
    '| Literal | Code |',
    '| --- | --- |',
    '| Do not | render |',
    '```',
    '',
    '| Not | a table |',
    '| invalid | separator |',
  ].join('\n'));
  const tables = page.locator('#messages table'); await expect(tables).toHaveCount(2);
  const table = tables.first();
  await expect(table.locator('th[scope=col]')).toHaveCount(3);
  expect(await table.locator('th').evaluateAll(cells => cells.map(cell => getComputedStyle(cell).textAlign))).toEqual(['left', 'center', 'right']);
  await expect(table.locator('strong')).toHaveText('Tables');
  await expect(table.locator('code')).toHaveText(['ready', 'a|b']);
  await expect(table.locator('tbody tr').nth(1).locator('td').first()).toHaveText('Escaped | pipe');
  await expect(table.locator('a')).toHaveAttribute('href', 'https://example.com/docs');
  await expect(table.locator('img')).toHaveCount(0); expect(await page.evaluate(() => window.compromised)).toBeUndefined();
  await expect(table.locator('tbody tr').nth(3).locator('td')).toHaveText(['Missing cells', '', '']);
  await expect(table.locator('tbody tr').nth(4).locator('td')).toHaveText(['Extra', 'cells', 'here']);
  await expect(page.locator('#messages pre code')).toContainText('| Literal | Code |');
  await expect(page.locator('#messages')).toContainText('Before the table.');
  await expect(page.locator('#messages')).toContainText('After the table.');
  await expect(page.locator('#messages')).toContainText('| invalid | separator |');
  expect(errors).toEqual([]);
});

test('wide tables scroll within the conversation on mobile in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openMessage(page, '| Feature | Description | Status | Owner | Date |\n| --- | --- | --- | --- | --- |\n| Tables | Works on mobile | Ready | Demo | Today |');
  const wrapper = page.locator('.markdown-table'); await expect(wrapper).toBeVisible();
  for (let i = 0; i < 2; i++) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await wrapper.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    await wrapper.focus(); await wrapper.press('End');
    await wrapper.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    expect(await wrapper.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    await page.locator('#workspace [data-theme-toggle]').click();
  }
  await wrapper.evaluate(el => { el.scrollLeft = 0; });
  await page.screenshot({ path: 'test-results/markdown-table-mobile.png' });
});

test('streamed table completion renders once and table DOM stays bounded for large responses', async ({ page }) => {
  await page.addInitScript(() => { const Native = window.EventSource; window.EventSource = class extends Native { constructor(url) { super(url); window.tablesStream = this; } }; });
  await openMessage(page, '| A | B |\n| ---');
  await expect(page.locator('#messages table')).toHaveCount(0);
  await page.evaluate(text => window.tablesStream.dispatchEvent(new MessageEvent('codex', { data: JSON.stringify({ method: 'item/completed', params: { threadId: 'session-one', turnId: 'table-turn', item: { id: 'table-item', type: 'agentMessage', text } } }) })), '| A | B |\n| --- | --- |\n| first | second |');
  await expect(page.locator('#messages table')).toHaveCount(1);
  await expect(page.locator('#messages td')).toHaveText(['first', 'second']);
  await page.evaluate(text => window.tablesStream.dispatchEvent(new MessageEvent('codex', { data: JSON.stringify({ method: 'item/completed', params: { threadId: 'session-one', turnId: 'table-turn', item: { id: 'table-item', type: 'agentMessage', text } } }) })), '| A | B |\n| --- | --- |\n' + '| x | y |\n'.repeat(10000));
  await expect(page.locator('#messages th, #messages td')).toHaveCount(5000);
  await page.locator('#message').fill('Still responsive'); await expect(page.locator('#send')).toBeEnabled();
});
