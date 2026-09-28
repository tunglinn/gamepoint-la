// End-to-end tests for the editor-first navigation: the side menu, the export
// page, and how both respond to the browser/OS Back button. Run at a phone
// viewport since mobile is the primary target. None of these need a video
// loaded — the menu and export page both work on an empty editor.

import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.beforeEach(async ({ page }) => {
  await page.goto('/app.html');
  await page.waitForFunction(() => typeof openMenu === 'function');
});

test('menu opens from the top-left button and closes via ✕ and the backdrop', async ({ page }) => {
  const menu = page.locator('#side-menu');

  await page.locator('#btn-menu').click();
  await expect(menu).toHaveClass(/open/);
  await page.locator('#side-menu .menu-head .panel-x').click();
  await expect(menu).not.toHaveClass(/open/);

  await page.locator('#btn-menu').click();
  await expect(menu).toHaveClass(/open/);
  // Tap the strip of backdrop to the right of the 300px-wide sheet.
  await page.locator('#side-menu .menu-backdrop').click({ position: { x: 360, y: 400 } });
  await expect(menu).not.toHaveClass(/open/);
});

test('Back closes the menu instead of leaving the app', async ({ page }) => {
  await page.locator('#btn-menu').click();
  await expect(page.locator('#side-menu')).toHaveClass(/open/);

  await page.goBack();
  await expect(page.locator('#side-menu')).not.toHaveClass(/open/);
  expect(new URL(page.url()).pathname).toMatch(/\/app(\.html)?$/);
});

test('export page opens from the top-right button and its back arrow returns to the editor', async ({ page }) => {
  const panel = page.locator('#export-panel');

  await page.locator('#btn-export').click();
  await expect(panel).toHaveClass(/open/);
  await expect(page.locator('button:has-text("Export Video")')).toBeVisible();

  await page.locator('#export-back').click();
  await expect(panel).not.toHaveClass(/open/);
  await expect(page.locator('#btn-export')).toBeVisible();
});

test('Back and Esc close the export page', async ({ page }) => {
  const panel = page.locator('#export-panel');

  await page.locator('#btn-export').click();
  await expect(panel).toHaveClass(/open/);
  await page.goBack();
  await expect(panel).not.toHaveClass(/open/);
  expect(new URL(page.url()).pathname).toMatch(/\/app(\.html)?$/);

  await page.locator('#btn-export').click();
  await expect(panel).toHaveClass(/open/);
  await page.keyboard.press('Escape');
  await expect(panel).not.toHaveClass(/open/);
});

test('in-app closes keep history balanced, so one Back afterwards still leaves nothing open', async ({ page }) => {
  // Open/close each layer via the UI several times; if closes didn't rewind
  // the pushed history entries, Back would now have to be pressed repeatedly
  // (or would re-show nothing while the app sat on a stale entry).
  for (let i = 0; i < 3; i++) {
    await page.locator('#btn-menu').click();
    await page.locator('#side-menu .menu-head .panel-x').click();
    await page.locator('#btn-export').click();
    await page.locator('#export-back').click();
  }
  await page.waitForFunction(() => layers.length === 0 && !(window.history.state && window.history.state.gplDepth));
});

test('swiping the menu left closes it', async ({ page }) => {
  await page.locator('#btn-menu').click();
  await expect(page.locator('#side-menu')).toHaveClass(/open/);

  await page.evaluate(async () => {
    const target = document.querySelector('#side-menu .menu-sheet');
    const fire = (type, x) => {
      const t = new Touch({ identifier: 1, target, clientX: x, clientY: 400 });
      target.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true,
        touches: type === 'touchend' ? [] : [t], changedTouches: [t],
      }));
    };
    fire('touchstart', 250);
    for (let x = 240; x >= 120; x -= 20) fire('touchmove', x);
    fire('touchend', 120);
  });

  await expect(page.locator('#side-menu')).not.toHaveClass(/open/);
});

test('export button is labelled "Export"', async ({ page }) => {
  await expect(page.locator('#btn-export')).toHaveText(/Export/);
});

test('team-name hint opens the menu on the Home field and disappears once a name is set', async ({ page }) => {
  const hint = page.locator('#team-hint');
  await expect(hint).toBeVisible();

  await hint.click();
  await expect(page.locator('#side-menu')).toHaveClass(/open/);
  await expect(page.locator('#inp-home')).toBeFocused();

  await page.keyboard.type('Eagles');
  await expect(hint).toBeHidden();
});

test('team names typed in the menu update the editor scoreboard', async ({ page }) => {
  await page.locator('#btn-menu').click();
  await page.locator('#inp-home').fill('Eagles');
  await page.locator('#inp-away').fill('Hawks');
  await expect(page.locator('#score-teams')).toHaveText('EAGLES vs HAWKS');
});

test('Save Markers in the menu downloads a JSON file and closes the menu', async ({ page }) => {
  await page.locator('#btn-menu').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#menu-save-markers').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.json$/);
  await expect(page.locator('#side-menu')).not.toHaveClass(/open/);
});
