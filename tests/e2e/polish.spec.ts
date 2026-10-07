import { expect, test, type Page } from '@playwright/test';
import { answers, openApp, settled, write } from './helpers.ts';

const painted = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...(window as unknown as { calcink: { app: { painted: string[] } } }).calcink.app.painted]);

test.beforeEach(async ({ page }) => {
  await openApp(page, '?delay=300');
});

test('a "?" waits for a real pause instead of flickering in while you write', async ({ page }) => {
  await write(page, '+×=', { x: 120, y: 160, seed: 2 }); // not arithmetic: will be an error
  const [a] = await settled(page);
  expect(a.kind).toBe('error');
  // keep writing on another line: every change restarts the clock, so the "?" stays away
  await write(page, '1', { x: 120, y: 320, seed: 3 });
  const lastStroke = Date.now();
  expect((await painted(page))[0]).toBe('hidden');
  await page.waitForTimeout(1200);
  expect((await painted(page))[0]).toBe('hidden');
  // after a real pause it shows up
  await expect.poll(async () => (await painted(page))[0], { timeout: 8000 }).toBe('error');
  expect(Date.now() - lastStroke).toBeGreaterThanOrEqual(2000);
});

test('a correct answer still appears right away', async ({ page }) => {
  await write(page, '6×7=', { x: 120, y: 160, seed: 4 });
  expect((await settled(page))[0]).toMatchObject({ kind: 'value', text: '42' });
  expect(await painted(page)).toEqual(['value']);
});

test('pen colours', async ({ page }) => {
  await page.click('#color');
  await expect(page.locator('#palette')).toBeVisible();
  await page.click('[data-color="#d23a2f"]');
  await expect(page.locator('#palette')).toBeHidden();
  await write(page, '8+5=', { x: 120, y: 160, seed: 6 });
  expect((await settled(page))[0]).toMatchObject({ kind: 'value', text: '13' });
  const colours = await page.evaluate(() =>
    (window as unknown as { calcink: { app: { canvas: { currentStrokes: Array<{ color?: string }> } } } }).calcink.app.canvas.currentStrokes.map((s) => s.color),
  );
  expect(colours.every((c) => c === '#d23a2f')).toBe(true);
  await page.keyboard.press('c'); // next colour (purple) for new strokes only
  const next = await page.evaluate(() => (window as unknown as { calcink: { app: { canvas: { color: string } } } }).calcink.app.canvas.color);
  expect(next).toBe('#7b3fc4');
  await page.screenshot({ path: 'test-results/colours.png' });
});

test('graphs: y = sin(x), a circle, and equations solved where both sides meet', async ({ page }) => {
  test.setTimeout(120_000);
  await page.click('#graphs');
  await write(page, 'y=sin(x)', { x: 100, y: 140, seed: 3, size: 48 });
  await write(page, '2x+4=10', { x: 100, y: 330, seed: 4, size: 48 });
  await write(page, 'sin(x)=x÷2', { x: 100, y: 520, seed: 5, size: 48 });
  const a = await settled(page);
  expect(a[0]).toMatchObject({ kind: 'plot' });
  expect(a[1]).toMatchObject({ kind: 'solved', text: 'x = 3' });
  expect(a[2]).toMatchObject({ kind: 'solved', text: 'x ≈ −1.895, 0, 1.895' });
  await page.waitForTimeout(1200); // cards are built in idle time, then drawn
  await page.screenshot({ path: 'test-results/graphs.png' });
  expect(await painted(page)).toEqual(['plot', 'solved', 'solved']);
});

test('an equation in x and y is drawn as a curve (x² + y² = 25)', async ({ page }) => {
  await page.keyboard.press('g');
  await write(page, 'x²+y²=25', { x: 100, y: 160, seed: 3, size: 48 });
  expect((await settled(page))[0]).toMatchObject({ kind: 'curve' });
});

const drawnGraphs = (page: Page): Promise<Array<{ caption: string; marks: Array<{ x: number; y: number; kind: string }> }>> =>
  page.evaluate(() => (window as unknown as { calcink: { app: { drawnGraphs: Array<{ caption: string; marks: Array<{ x: number; y: number; kind: string }> }> } } }).calcink.app.drawnGraphs);
const cards = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { calcink: { app: { cards: number } } }).calcink.app.cards);

test('graph button toggles cards', async ({ page }) => {
  await write(page, 'y=x²', { x: 100, y: 140, seed: 3, size: 48 });
  await write(page, 'x=3', { x: 100, y: 300, seed: 4, size: 48 });
  await write(page, 'y+1=', { x: 100, y: 460, seed: 5, size: 48 });
  const a = await settled(page);
  expect(a[0]).toMatchObject({ kind: 'plot' });
  expect(a[2]).toMatchObject({ kind: 'value', text: '10' });
  await page.waitForTimeout(800);
  expect(await cards(page)).toBe(0);
  await expect(page.locator('#graphs')).toHaveAttribute('aria-pressed', 'false');
  await page.click('#graphs');
  // two cards: y = x² with the point x = 3 marked on it, and the line x = 3
  await expect.poll(async () => (await drawnGraphs(page)).length, { timeout: 5000 }).toBe(2);
  const g = await drawnGraphs(page);
  expect(g.map((c) => c.caption)).toEqual(['y = x²', 'x = 3']);
  expect(g[0].marks).toContainEqual({ x: 3, y: 9, kind: 'solution' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'test-results/graph-x3.png' });
  // remembered after a reload
  await page.reload();
  await expect(page.locator('#graphs')).toHaveAttribute('aria-pressed', 'true');
});

test('paper styles: lines, boxes, dots, plain; remembered after a reload', async ({ page }) => {
  const surface = page.locator('#surface');
  await expect(surface).toHaveAttribute('data-paper', 'lines');
  await page.click('#paper');
  await page.click('[data-paper="grid"]');
  await expect(surface).toHaveAttribute('data-paper', 'grid');
  await page.keyboard.press('b');
  await expect(surface).toHaveAttribute('data-paper', 'dots');
  await page.keyboard.press('b');
  await expect(surface).toHaveAttribute('data-paper', 'plain');
  await page.screenshot({ path: 'test-results/paper-plain.png' });
  await page.reload();
  await expect(surface).toHaveAttribute('data-paper', 'plain');
});

test('the empty page suggests one of several examples', async ({ page }) => {
  const text = await page.locator('#hint-eq').textContent();
  expect(['√144 + 3² =', '2.5 × (8 − 3) =', '(15 + 30) × 2 =', '7² − 4 × 6 =', '3/4 + 0.25 =', '2x + 4 = 10']).toContain(text);
});

test('graphs on: "x = 5" is drawn as the line x = 5 and still works as a variable below', async ({ page }) => {
  await page.click('#graphs');
  await write(page, 'x=5', { x: 120, y: 160, seed: 3, size: 48 });
  await write(page, 'x+1=', { x: 120, y: 420, seed: 4, size: 48 });
  const a = await settled(page);
  expect(a[0]).toMatchObject({ kind: 'assigned' });
  expect(a[1]).toMatchObject({ kind: 'value', text: '6' });
  await expect.poll(async () => (await drawnGraphs(page)).length, { timeout: 5000 }).toBe(1);
  const g = await drawnGraphs(page);
  expect(g[0].caption).toBe('x = 5');
  expect(g[0].marks).toContainEqual({ x: 5, y: 0, kind: 'root' });
  await page.screenshot({ path: 'test-results/graph-x5.png' });
});

test('graphs on: "y = 8" is drawn as the horizontal line y = 8, framed so it is clearly visible', async ({ page }) => {
  await page.click('#graphs');
  await write(page, 'y=8', { x: 120, y: 160, seed: 3, size: 48 });
  await write(page, 'y+1=', { x: 120, y: 420, seed: 4, size: 48 });
  const a = await settled(page);
  expect(a[0]).toMatchObject({ kind: 'assigned' });
  expect(a[1]).toMatchObject({ kind: 'value', text: '9' });
  await expect.poll(async () => (await drawnGraphs(page)).length, { timeout: 5000 }).toBe(1);
  const g = await drawnGraphs(page);
  expect(g[0].caption).toBe('y = 8');
  expect(g[0].marks).toContainEqual({ x: 0, y: 8, kind: 'intercept' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'test-results/graph-y8.png' });
});

test('the page survives a reload', async ({ page }) => {
  await write(page, '6+7=', { x: 120, y: 160, seed: 2 });
  expect((await settled(page)).map((a) => a.text)).toEqual(['13']);
  await page.waitForTimeout(700); // saved shortly after the last change
  await page.reload();
  await expect(page.locator('#status-text')).toContainText('Ready', { timeout: 150_000 });
  expect((await settled(page)).map((a) => a.text)).toEqual(['13']);
  // clear is saved too
  await page.click('#clear');
  await page.waitForTimeout(700);
  await page.reload();
  await expect(page.locator('#status-text')).toContainText('Ready', { timeout: 150_000 });
  expect(await answers(page)).toEqual([]);
});
