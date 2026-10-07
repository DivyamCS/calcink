import { expect, test, type Page } from '@playwright/test';
import { drawStrokes, openApp, settled, write } from './helpers.ts';

const app = <T>(page: Page, key: string): Promise<T> =>
  page.evaluate((k) => (window as unknown as { calcink: { app: Record<string, unknown> } }).calcink.app[k] as T, key);

/** a hand-ruled line: long, almost flat, slightly wobbly */
const rule = (x0: number, x1: number, y: number) => ({
  points: Array.from({ length: 12 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / 11, y: y + Math.sin(i) * 1.5 })),
  lineWidth: 4,
  char: -1,
});

test.beforeEach(async ({ page }) => {
  await openApp(page, '?delay=300');
});

test('15 / 30 / + 80 written close together, a line under them -> 125', async ({ page }) => {
  test.setTimeout(90_000);
  const size = 48;
  await write(page, '15', { x: 190, y: 120, size, seed: 1 });
  await write(page, '30', { x: 190, y: 178, size, seed: 2 });
  await write(page, '+80', { x: 140, y: 236, size, seed: 3 });
  await drawStrokes(page, [rule(120, 290, 300)]);
  await settled(page);
  await expect.poll(() => app<string[]>(page, 'columns'), { timeout: 20_000 }).toEqual(['125']);
  // the rows themselves get no answer or "?" of their own
  expect(await app<string[]>(page, 'painted')).toEqual(['column', 'column', 'column']);
  await page.screenshot({ path: 'test-results/column.png' });
});

test('per-row signs: 90 + 30 - 45 = 75', async ({ page }) => {
  test.setTimeout(90_000);
  const size = 48;
  await write(page, '12+3=', { x: 560, y: 120, size, seed: 7 });
  await write(page, '90', { x: 190, y: 120, size, seed: 4 });
  await write(page, '+30', { x: 140, y: 178, size, seed: 6 });
  await write(page, '-45', { x: 140, y: 236, size, seed: 5 });
  await drawStrokes(page, [rule(120, 290, 300)]);
  const a = await settled(page);
  expect(a.some((x) => x.kind === 'value' && x.text === '15')).toBe(true);
  await expect.poll(() => app<string[]>(page, 'columns'), { timeout: 20_000 }).toEqual(['75']);
});

test('without the rule, stacked numbers are just numbers (no column sum)', async ({ page }) => {
  await write(page, '15', { x: 190, y: 120, size: 48, seed: 1 });
  await write(page, '30', { x: 190, y: 220, size: 48, seed: 2 });
  await settled(page);
  expect(await app<string[]>(page, 'columns')).toEqual([]);
});
