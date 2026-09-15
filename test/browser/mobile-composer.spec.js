import { test, expect } from '@playwright/test';

test('mobile composer grows and shrinks with drafts, folds options, and leaves chat visible with a keyboard-sized viewport', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#session=session-one');
  await page.locator('#access-key').fill('browser-test-access-key-123456789');
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#message')).toBeEnabled();
  if (await page.locator('#close-changes').isVisible()) await page.locator('#close-changes').click();
  if (await page.locator('#interrupt').isVisible()) { await page.locator('#interrupt').click(); await expect(page.locator('#session-status')).toHaveText('Klar'); }
  const input = page.locator('#message'), height = async () => (await input.boundingBox()).height;
  await expect(page.locator('#model-select')).toBeHidden();
  await expect.poll(height).toBeLessThanOrEqual(44);
  await input.fill('First line\nSecond line\nThird line');
  await expect.poll(height).toBeGreaterThan(75);
  await page.locator('#composer-options-toggle').click();
  await expect(page.locator('#model-select')).toBeVisible(); await expect(page.locator('#goal-button')).toBeVisible();
  await expect(input).toHaveValue('First line\nSecond line\nThird line');
  await page.locator('#composer-options-toggle').click();
  await input.fill('Ja'); await expect.poll(height).toBeLessThanOrEqual(44);
  await input.focus();
  // Android keyboards can shrink only visualViewport, leaving innerHeight unchanged.
  await page.evaluate(() => { Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => 360 }); visualViewport.dispatchEvent(new Event('resize')); });
  await expect.poll(async () => (await page.locator('#workspace').boundingBox()).height).toBe(360);
  expect(await page.evaluate(() => innerHeight)).toBe(844);
  await expect.poll(async () => (await page.locator('#timeline').boundingBox()).height).toBeGreaterThan(140);
  await page.evaluate(() => { delete visualViewport.height; visualViewport.dispatchEvent(new Event('resize')); });
  await page.setViewportSize({ width: 390, height: 360 });
  await expect.poll(async () => (await page.locator('#timeline').boundingBox()).height).toBeGreaterThan(140);
  await input.fill('A long draft\n'.repeat(20));
  await expect.poll(height).toBeLessThanOrEqual(101);
  expect(await input.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await input.fill('short'); await expect.poll(height).toBeLessThanOrEqual(44);
  await page.locator('#send').click(); await expect(input).toHaveValue('');
  await expect.poll(height).toBeLessThanOrEqual(44);
  await page.setViewportSize({ width: 320, height: 360 });
  await page.locator('#workspace [data-language-select]').selectOption('en');
  await page.locator('#workspace [data-theme-toggle]').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('#send')).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile-keyboard-viewport.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator('#model-select')).toBeVisible();
  await expect(page.locator('#composer-options-toggle')).toBeHidden();
  expect(errors).toEqual([]);
});
