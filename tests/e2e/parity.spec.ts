import { expect, test } from '@playwright/test';
import { ACCURACY_SET, handwrite } from './handwriting.ts';

test('worker preprocessing produces the same tensor as ink-on', async ({ page }) => {
  await page.goto('http://localhost:5173/tests/e2e/fixtures/parity.html');
  await expect(page).toHaveTitle('ready', { timeout: 60_000 });
  for (const text of ACCURACY_SET.slice(0, 12)) {
    for (const lineWidth of [2, 4, 9]) {
      const strokes = handwrite(text, { seed: 7, lineWidth }).map(({ points, lineWidth: w }) => ({ points, lineWidth: w }));
      const r = await page.evaluate((s) => (window as any).parity(s), strokes);
      expect(r.shapeOurs, text).toEqual(r.shape);
      expect(r.maskEqual, text).toBe(true);
      expect(r.inkPixels, text).toBeGreaterThan(100);
      // identical drawing commands on the same canvas implementation: allow only 1/255 rounding noise
      expect(r.maxDiffDom, text).toBeLessThanOrEqual(1 / 255 + 1e-6);
      expect(r.maxDiffOffscreen, text).toBeLessThanOrEqual(1 / 255 + 1e-6);
    }
  }
});
