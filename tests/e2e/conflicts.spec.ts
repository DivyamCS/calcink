import { expect, test, type Page } from '@playwright/test';
import { handwrite } from './handwriting.ts';
import { charBox, drawStrokes, openApp, settled, write } from './helpers.ts';

type Box = { minX: number; minY: number; maxX: number; maxY: number };
const app = <T>(page: Page, key: string): Promise<T> =>
  page.evaluate((k) => (window as unknown as { calcink: { app: Record<string, unknown> } }).calcink.app[k] as T, key);
const strokeCount = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { calcink: { app: { canvas: { currentStrokes: unknown[] } } } }).calcink.app.canvas.currentStrokes.length);
const cards = async (page: Page): Promise<number> => (await app<{ cards: Box[] }>(page, 'layout')).cards.length;
const rule = (x0: number, x1: number, y: number) => ({
  points: Array.from({ length: 12 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / 11, y: y + Math.sin(i) * 1.5 })),
  lineWidth: 4,
  char: -1,
});

/** a column: 15 / 30 / + 80 and a rule at y = 300 */
async function column(page: Page): Promise<{ thirty: Box }> {
  await write(page, '15', { x: 190, y: 120, size: 48, seed: 1 });
  const thirty = await write(page, '30', { x: 190, y: 178, size: 48, seed: 2 });
  await write(page, '+80', { x: 140, y: 236, size: 48, seed: 3 });
  await drawStrokes(page, [rule(120, 290, 300)]);
  const all = thirty.flatMap((s) => s.points);
  return { thirty: { minX: Math.min(...all.map((p) => p.x)), minY: Math.min(...all.map((p) => p.y)), maxX: Math.max(...all.map((p) => p.x)), maxY: Math.max(...all.map((p) => p.y)) } };
}

/** drag the stroke eraser through a box */
async function eraseBox(page: Page, b: Box): Promise<void> {
  await page.click('[data-tool="stroke-eraser"]');
  await page.mouse.move(b.minX, (b.minY + b.maxY) / 2);
  await page.mouse.down();
  for (let x = b.minX; x <= b.maxX; x += 4) await page.mouse.move(x, b.minY + ((x * 7) % (b.maxY - b.minY + 1)));
  await page.mouse.up();
  await page.click('[data-tool="pen"]');
}

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  await openApp(page, '?delay=300');
});
test.afterEach(() => {
  expect(errors).toEqual([]);
});

test('column: erase the rule -> no sum (and no stray "?"); undo -> the sum is back', async ({ page }) => {
  test.setTimeout(120_000);
  await column(page);
  await settled(page);
  await expect.poll(() => app<string[]>(page, 'columns')).toEqual(['125']);
  await eraseBox(page, { minX: 130, minY: 296, maxX: 280, maxY: 304 });
  await settled(page);
  expect(await app<string[]>(page, 'columns')).toEqual([]);
  await page.waitForTimeout(2800); // past the "?" delay
  expect(await app<string[]>(page, 'painted')).not.toContain('error'); // numbers without "=" are not errors
  await page.keyboard.press('Control+z');
  await settled(page);
  await expect.poll(() => app<string[]>(page, 'columns')).toEqual(['125']);
});

test('column: rub out the 30, write 40 -> 135; undo twice -> 125', async ({ page }) => {
  test.setTimeout(120_000);
  const { thirty } = await column(page);
  await settled(page);
  await expect.poll(() => app<string[]>(page, 'columns')).toEqual(['125']);
  const before = await strokeCount(page);
  await eraseBox(page, thirty);
  expect(await strokeCount(page)).toBeLessThan(before);
  const four = handwrite('40', { x: 190, y: 178, size: 48, seed: 8 });
  await drawStrokes(page, four);
  await settled(page);
  await expect.poll(() => app<string[]>(page, 'columns'), { timeout: 20_000 }).toEqual(['135']);
  for (let i = 0; i < four.length + 1; i++) await page.keyboard.press('Control+z');
  await settled(page);
  await expect.poll(() => app<string[]>(page, 'columns')).toEqual(['125']);
});

test('column next to a variable and a calculation', async ({ page }) => {
  test.setTimeout(120_000);
  await write(page, 'x=5', { x: 140, y: 40, size: 40, seed: 11 });
  await column(page);
  await write(page, 'x+2=', { x: 560, y: 160, size: 48, seed: 12 });
  const a = await settled(page);
  expect(a.some((x) => x.kind === 'value' && x.text === '7')).toBe(true);
  await expect.poll(() => app<string[]>(page, 'columns')).toEqual(['125']);
});

test('erasing an equation removes its card', async ({ page }) => {
  test.setTimeout(150_000);
  await page.click('#graphs');
  await write(page, 'y=x²', { x: 100, y: 130, seed: 3, size: 44 });
  const eq2 = await write(page, 'y=2x', { x: 100, y: 330, seed: 4, size: 44 });
  await settled(page);
  await expect.poll(() => cards(page), { timeout: 10_000 }).toBe(2);
  // scribble eraser over the second equation
  const b = { minX: charBox(eq2, 0).minX, minY: Math.min(...eq2.flatMap((s) => s.points.map((p) => p.y))), maxX: charBox(eq2, 3).maxX, maxY: Math.max(...eq2.flatMap((s) => s.points.map((p) => p.y))) };
  await page.keyboard.press('s');
  await page.mouse.move(b.minX - 4, b.minY);
  await page.mouse.down();
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(b.maxX + 4, b.minY + ((i + 0.5) * (b.maxY - b.minY)) / 6, { steps: 8 });
    await page.mouse.move(b.minX - 4, b.minY + ((i + 1) * (b.maxY - b.minY)) / 6, { steps: 8 });
  }
  await page.mouse.up();
  await page.keyboard.press('p');
  await settled(page);
  await expect.poll(() => cards(page), { timeout: 10_000 }).toBe(1);
  await page.keyboard.press('Control+z');
  await settled(page);
  await expect.poll(() => cards(page), { timeout: 10_000 }).toBe(2);
  // graphs off: no cards, y = x² still feeds the lines below
  await page.keyboard.press('g');
  await expect.poll(() => cards(page)).toBe(0);
  await write(page, 'x=3', { x: 100, y: 470, seed: 5, size: 44 });
  await write(page, 'y+1=', { x: 100, y: 580, seed: 6, size: 44 });
  const a = await settled(page);
  expect(a[a.length - 1]).toMatchObject({ kind: 'value', text: '7' }); // y = 2x is the latest formula: 2·3 + 1
  await page.keyboard.press('g');
  await expect.poll(() => cards(page), { timeout: 10_000 }).toBe(3); // y = x², y = 2x, and the line x = 3
});

test('clear with a column and graphs on -> nothing left; undo -> everything back', async ({ page }) => {
  test.setTimeout(120_000);
  await page.click('#graphs');
  await column(page);
  await write(page, 'y=x²', { x: 600, y: 160, seed: 3, size: 44 });
  await settled(page);
  await expect.poll(() => app<string[]>(page, 'columns')).toEqual(['125']);
  await expect.poll(() => cards(page), { timeout: 10_000 }).toBe(1);
  await page.click('#clear');
  await expect.poll(() => cards(page)).toBe(0);
  expect(await app<string[]>(page, 'columns')).toEqual([]);
  await page.click('#undo');
  await settled(page);
  await expect.poll(() => app<string[]>(page, 'columns')).toEqual(['125']);
  await expect.poll(() => cards(page), { timeout: 10_000 }).toBe(1);
});

test('tidy text, colours and paper while writing', async ({ page }) => {
  test.setTimeout(120_000);
  await page.keyboard.press('t');
  await write(page, '6×7=', { x: 560, y: 140, size: 48, seed: 4 });
  await page.keyboard.press('c');
  await page.keyboard.press('b');
  await column(page);
  await page.keyboard.press('b');
  const a = await settled(page);
  expect(a.some((x) => x.kind === 'value' && x.text === '42')).toBe(true);
  await expect.poll(() => app<string[]>(page, 'columns')).toEqual(['125']);
  expect(await app<string[]>(page, 'painted')).toContain('value');
  await page.screenshot({ path: 'test-results/conflicts-tidy.png' });
});

test('undo everything, redo everything: the same answers come back', async ({ page }) => {
  test.setTimeout(120_000);
  await write(page, '8+5=', { x: 560, y: 140, size: 48, seed: 2 });
  await column(page);
  await settled(page);
  await expect.poll(() => app<string[]>(page, 'columns')).toEqual(['125']);
  const n = await strokeCount(page);
  for (let i = 0; i < n; i++) await page.keyboard.press('Control+z');
  expect(await strokeCount(page)).toBe(0);
  expect(await app<string[]>(page, 'columns')).toEqual([]);
  for (let i = 0; i < n; i++) await page.keyboard.press('Control+Shift+z');
  const a = await settled(page);
  expect(a.some((x) => x.kind === 'value' && x.text === '13')).toBe(true);
  await expect.poll(() => app<string[]>(page, 'columns')).toEqual(['125']);
});
