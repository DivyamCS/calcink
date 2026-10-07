import { expect, test } from '@playwright/test';
import { openApp, settled, write } from './helpers.ts';

test.use({ viewport: { width: 390, height: 844 } });

test('phone screen: toolbar fits, answers and a graph card stay on the page', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openApp(page, '?delay=300');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const tb = (await page.locator('.toolbar').boundingBox())!;
  expect(tb.x).toBeGreaterThanOrEqual(0);
  expect(tb.x + tb.width).toBeLessThanOrEqual(390);
  await page.click('#graphs');
  await write(page, '6×7=', { x: 30, y: 200, size: 40, seed: 4 });
  await write(page, 'y=x²', { x: 30, y: 330, size: 40, seed: 3 });
  const a = await settled(page);
  expect(a[0]).toMatchObject({ kind: 'value', text: '42' });
  expect(a[1]).toMatchObject({ kind: 'plot' });
  await expect.poll(() => page.evaluate(() => (window as any).calcink.app.drawnGraphs.length), { timeout: 8000 }).toBe(1);
  const l = await page.evaluate(() => (window as any).calcink.app.layout);
  for (const c of l.cards) {
    expect(c.minX).toBeGreaterThanOrEqual(0);
    expect(c.maxX).toBeLessThanOrEqual(390);
  }
  for (const t of l.texts) expect(t.maxX).toBeLessThanOrEqual(390);
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/mobile.png' });
  expect(errors).toEqual([]);
});

test('big writing on a phone', async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page, '?delay=300');
  // a calculation written the size of the screen (it used to be read as "4 × 1 = 7")
  await write(page, '4×7=', { x: 20, y: 160, size: 120, seed: 2 });
  expect((await settled(page))[0]).toMatchObject({ kind: 'value', text: '28' });
  await page.evaluate(() => (window as any).calcink.app.canvas.clear());
  // a column with big digits, a rule drawn with a slight upward tilt
  await write(page, '50', { x: 150, y: 140, size: 100, seed: 1 });
  await write(page, '+60', { x: 80, y: 260, size: 100, seed: 2 });
  await write(page, '-10', { x: 80, y: 380, size: 100, seed: 3 });
  await page.mouse.move(70, 530);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) await page.mouse.move(70 + i * 17, 530 - i * 2.2);
  await page.mouse.up();
  await settled(page);
  await expect.poll(() => page.evaluate(() => (window as any).calcink.app.columns), { timeout: 20_000 }).toEqual(['100']);
  await page.screenshot({ path: 'test-results/mobile-big.png' });
});
