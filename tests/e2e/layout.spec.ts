import { expect, test, type Page } from '@playwright/test';
import { handwrite } from './handwriting.ts';
import { drawStrokes, openApp, settled, write } from './helpers.ts';

type Box = { minX: number; minY: number; maxX: number; maxY: number };
type Layout = { width: number; height: number; cards: Box[]; texts: Box[]; ink: Box[]; skipped: number; faded: number };

const layout = (page: Page): Promise<Layout> =>
  page.evaluate(() => (window as unknown as { calcink: { app: { layout: Layout } } }).calcink.app.layout);
const hits = (a: Box, b: Box): boolean => a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;

async function chrome(page: Page): Promise<Box[]> {
  const boxes: Box[] = [];
  for (const sel of ['.toolbar', '.status']) {
    const r = await page.locator(sel).first().boundingBox();
    if (r) boxes.push({ minX: r.x, minY: r.y, maxX: r.x + r.width, maxY: r.y + r.height });
  }
  return boxes;
}

/** wait for every card to be built, then check the layout strictly */
async function checkCards(page: Page, expected: number, name: string): Promise<Layout> {
  await expect.poll(async () => { const l = await layout(page); return l.cards.length + l.skipped; }, { timeout: 10_000 }).toBe(expected);
  await page.waitForTimeout(900); // idle-time graph builds + write-on animation
  const l = await layout(page);
  const ui = await chrome(page);
  const status = await page.locator('.status').getAttribute('data-covered');
  await page.screenshot({ path: `test-results/layout-${name}.png` });
  const problems: string[] = [];
  l.cards.forEach((c, i) => {
    if (c.minX < 0 || c.minY < 0 || c.maxX > l.width || c.maxY > l.height) problems.push(`card ${i} off the page ${JSON.stringify(c)}`);
    l.cards.forEach((d, j) => j > i && hits(c, d) && problems.push(`card ${i} overlaps card ${j}`));
    l.ink.forEach((k, j) => hits(c, k) && problems.push(`card ${i} covers ink of line ${j}`));
    l.texts.forEach((t, j) => hits(c, t) && problems.push(`card ${i} covers answer ${j}`));
    if (hits(c, ui[0])) problems.push(`card ${i} under the toolbar`);
    // the status pill floats over the page: if a card is under it, the pill must have faded out of the way
    if (ui[1] && hits(c, ui[1]) && status !== 'true') problems.push(`card ${i} under the status pill, which did not fade`);
  });
  l.texts.forEach((t, i) => l.ink.forEach((k, j) => hits(t, k) && problems.push(`answer ${i} covers ink of line ${j}`)));
  expect(problems).toEqual([]);
  return l;
}

test.beforeEach(async ({ page }) => {
  await openApp(page, '?delay=300');
  await page.click('#graphs');
});

test('four stacked equations, no overlaps', async ({ page }) => {
  test.setTimeout(120_000);
  await write(page, 'y=x²', { x: 100, y: 140, seed: 3, size: 44 });
  await write(page, 'y=sin(x)', { x: 100, y: 260, seed: 4, size: 44 });
  await write(page, '2x+4=10', { x: 100, y: 380, seed: 5, size: 44 });
  await write(page, 'x²+y²=25', { x: 100, y: 500, seed: 6, size: 44 });
  const a = await settled(page);
  expect(a.map((x) => x.kind)).toEqual(['plot', 'plot', 'solved', 'curve']);
  await checkCards(page, 4, 'four');
});

test('equations written close together and a calculation in between', async ({ page }) => {
  test.setTimeout(120_000);
  await write(page, 'y=2x+1', { x: 90, y: 130, seed: 7, size: 40 });
  await write(page, '12+30=', { x: 90, y: 215, seed: 8, size: 40 });
  await write(page, 'y=x²-4', { x: 90, y: 300, seed: 9, size: 40 });
  await write(page, '3x=12', { x: 90, y: 385, seed: 10, size: 40 });
  const a = await settled(page);
  expect(a.map((x) => x.kind)).toEqual(['plot', 'value', 'plot', 'solved']);
  await checkCards(page, 3, 'close');
});

test('two columns of work: equations on the left and on the right', async ({ page }) => {
  test.setTimeout(120_000);
  await write(page, 'y=x²', { x: 90, y: 140, seed: 3, size: 44 });
  await write(page, 'y=2x', { x: 700, y: 140, seed: 4, size: 44 });
  await write(page, '5+7=', { x: 90, y: 420, seed: 5, size: 44 });
  const a = await settled(page);
  expect(a.filter((x) => x.kind === 'plot')).toHaveLength(2);
  await checkCards(page, 2, 'sides');
});

test('an equation near the bottom of the page still gets a card on the page', async ({ page }) => {
  test.setTimeout(120_000);
  await write(page, 'y=x²', { x: 100, y: 610, seed: 3, size: 44 });
  await settled(page);
  await checkCards(page, 1, 'bottom');
});

test('full page of six equations', async ({ page }) => {
  test.setTimeout(150_000);
  const eqs = ['y=x²', 'y=2x+1', 'y=x³', 'y=sin(x)', 'y=3x', 'y=x-2'];
  for (let i = 0; i < eqs.length; i++) await write(page, eqs[i], { x: 100, y: 110 + i * 100, seed: 20 + i, size: 40 });
  const a = await settled(page);
  expect(a.every((x) => x.kind === 'plot')).toBe(true);
  const l = await checkCards(page, 6, 'full');
  expect(l.cards.length).toBeGreaterThanOrEqual(5);
});

test('writing over a card', async ({ page }) => {
  test.setTimeout(120_000);
  await write(page, 'y=x²', { x: 100, y: 140, seed: 3, size: 44 });
  await settled(page);
  const [card] = (await checkCards(page, 1, 'before-over')).cards;
  // start a stroke inside the card and keep the pen down
  const s = handwrite('5+5=', { x: card.minX + 20, y: card.maxY - 60, seed: 2, size: 44 });
  await page.mouse.move(s[0].points[0].x, s[0].points[0].y);
  await page.mouse.down();
  for (const p of s[0].points.slice(1)) await page.mouse.move(p.x, p.y);
  await expect.poll(async () => (await layout(page)).faded).toBe(1);
  await page.mouse.up();
  await drawStrokes(page, s.slice(1));
  const a = await settled(page);
  expect(a.some((x) => x.kind === 'value' && x.text === '10')).toBe(true);
  expect((await layout(page)).faded).toBe(0);
  await checkCards(page, 1, 'after-over'); // strict: the card no longer covers any ink
});
