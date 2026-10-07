import { expect, test, type Page } from '@playwright/test';
import { handwrite } from './handwriting.ts';
import { drawStrokes, openApp, settled, write } from './helpers.ts';

type Box = { minX: number; minY: number; maxX: number; maxY: number };
const canvasState = (page: Page) =>
  page.evaluate(() => {
    const c = (window as unknown as { calcink: { app: { canvas: { scrollY: number; pageHeight: number; size: { height: number }; currentStrokes: Array<{ points: Array<{ y: number }> }> } } } }).calcink.app.canvas;
    return { scrollY: c.scrollY, pageHeight: c.pageHeight, view: c.size.height, ys: c.currentStrokes.map((s) => Math.min(...s.points.map((p) => p.y))) };
  });
/** wheel, then wait until the scroll has settled (Chromium may deliver one big wheel in steps) */
const wheel = async (page: Page, dy: number): Promise<void> => {
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, dy);
  let last = -1;
  await expect
    .poll(async () => {
      const now = (await canvasState(page)).scrollY;
      const stable = now === last;
      last = now;
      return stable;
    }, { intervals: [120] })
    .toBe(true);
};

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  await openApp(page, '?delay=300');
});
test.afterEach(() => expect(errors).toEqual([]));

test('wheel scroll and writing further down', async ({ page }) => {
  await write(page, '8+5=', { x: 120, y: 160, seed: 2 });
  await settled(page);
  await wheel(page, 800); // the browser reports it in css px (Playwright divides by the pixel ratio)
  let s = await canvasState(page);
  const scrolled = s.scrollY;
  expect(scrolled).toBeGreaterThanOrEqual(300);
  await expect(page.locator('#surface')).toHaveAttribute('style', new RegExp(`--scroll-y: ${scrolled}px`));
  await write(page, '6×7=', { x: 120, y: 300, seed: 4 });
  const a = await settled(page);
  expect(a.map((x) => x.text)).toEqual(['13', '42']);
  s = await canvasState(page);
  expect(Math.max(...s.ys)).toBeGreaterThan(300 + scrolled - 40); // stored in page coordinates
  await page.screenshot({ path: 'test-results/scroll-down.png' });
  // back to the top: the first answer is there, the second is below the screen
  await wheel(page, -1000);
  expect((await canvasState(page)).scrollY).toBe(0);
});

test('page end follows the writing', async ({ page }) => {
  await wheel(page, 5000);
  let s = await canvasState(page);
  expect(s.scrollY).toBe(s.pageHeight - s.view); // an empty page still gives some fresh paper below
  await write(page, '1+1=', { x: 120, y: 500, seed: 1 });
  await settled(page);
  await wheel(page, 5000);
  s = await canvasState(page);
  expect(s.scrollY).toBe(s.pageHeight - s.view);
  const deep = s.scrollY;
  for (let i = (await canvasState(page)).ys.length; i > 0; i--) await page.keyboard.press('Control+z');
  s = await canvasState(page);
  expect(s.ys).toHaveLength(0);
  expect(s.scrollY).toBeLessThanOrEqual(Math.max(0, s.pageHeight - s.view));
  expect(s.scrollY).toBeLessThan(deep);
});

test('variables and erasing after scrolling', async ({ page }) => {
  await write(page, 'x=4', { x: 120, y: 160, seed: 1 });
  await settled(page);
  await wheel(page, 500);
  const plus = await write(page, 'x+1=', { x: 120, y: 260, seed: 2 });
  expect((await settled(page))[1]).toMatchObject({ kind: 'value', text: '5' });
  // rub out the "1" (screen coordinates; it lives at page y + 500)
  const one = plus.filter((st) => st.char === 2).flatMap((st) => st.points);
  const b: Box = { minX: Math.min(...one.map((p) => p.x)), minY: Math.min(...one.map((p) => p.y)), maxX: Math.max(...one.map((p) => p.x)), maxY: Math.max(...one.map((p) => p.y)) };
  await page.click('[data-tool="stroke-eraser"]');
  await page.mouse.move((b.minX + b.maxX) / 2, b.minY);
  await page.mouse.down();
  for (let y = b.minY; y <= b.maxY; y += 4) await page.mouse.move((b.minX + b.maxX) / 2, y);
  await page.mouse.up();
  await page.click('[data-tool="pen"]');
  await drawStrokes(page, handwrite('2', { x: b.minX, y: 260, seed: 5 }));
  expect((await settled(page))[1]).toMatchObject({ kind: 'value', text: '6' });
  // the top line was not touched by the eraser
  expect((await settled(page))[0]).toMatchObject({ kind: 'assigned' });
});

test('scrollbar', async ({ page }) => {
  const thumb = page.locator('.scroll-thumb');
  await write(page, '2+2=', { x: 120, y: 160, seed: 3 });
  await settled(page);
  await expect(thumb).toBeVisible(); // there is always fresh paper below
  const box = (await thumb.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 210, { steps: 5 });
  await page.mouse.up();
  expect((await canvasState(page)).scrollY).toBeGreaterThan(100);
  // no stroke was drawn by dragging the scrollbar
  expect((await canvasState(page)).ys).toHaveLength(handwrite('2+2=', { x: 120, y: 160, seed: 3 }).length);
});

test('two-finger scroll and PageUp/PageDown', async ({ page }) => {
  await write(page, '3+3=', { x: 120, y: 160, seed: 3 });
  await settled(page);
  const before = (await canvasState(page)).ys.length;
  await page.evaluate(() => {
    const el = document.querySelector('.ink-layer') as HTMLElement;
    const ev = (type: string, id: number, x: number, y: number) =>
      el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true, isPrimary: id === 11, buttons: type === 'pointerup' ? 0 : 1 }));
    ev('pointerdown', 11, 400, 500);
    ev('pointermove', 11, 400, 495);
    ev('pointerdown', 12, 500, 500);
    for (let k = 1; k <= 10; k++) {
      ev('pointermove', 11, 400, 500 - k * 25);
      ev('pointermove', 12, 500, 500 - k * 25);
    }
    ev('pointerup', 12, 500, 250);
    ev('pointermove', 11, 420, 240); // the finger left behind does not draw
    ev('pointerup', 11, 420, 240);
  });
  await page.waitForTimeout(200);
  const s = await canvasState(page);
  expect(s.scrollY).toBeGreaterThanOrEqual(240);
  expect(s.ys).toHaveLength(before);
  await page.keyboard.press('PageUp');
  await page.waitForTimeout(100);
  expect((await canvasState(page)).scrollY).toBe(0);
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(100);
  expect((await canvasState(page)).scrollY).toBeGreaterThan(0);
});

test('graphs below the first screen', async ({ page }) => {
  await page.click('#graphs');
  await wheel(page, 900);
  const scrolled = (await canvasState(page)).scrollY;
  expect(scrolled).toBeGreaterThanOrEqual(300);
  await write(page, 'y=x²', { x: 120, y: 200, seed: 3, size: 44 });
  await settled(page);
  await expect.poll(async () => (await page.evaluate(() => (window as any).calcink.app.drawnGraphs.length)), { timeout: 8000 }).toBe(1);
  const l = await page.evaluate(() => (window as any).calcink.app.layout);
  const card: Box = l.cards[0];
  expect(card.minY).toBeGreaterThan(scrolled); // page coordinates, below the first screen's top
  const line: Box = l.ink[0];
  expect(card.minX).toBeGreaterThan(line.maxX); // beside its equation, on the same row (not pushed below it)
  expect(card.minY).toBeLessThan(line.maxY);
  for (const ink of l.ink as Box[]) expect(card.minX < ink.maxX && card.maxX > ink.minX && card.minY < ink.maxY && card.maxY > ink.minY).toBe(false);
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/scroll-graph.png' });
});

test('decimals written with a dot: 2.5×2 = 5 and 0.5+0.25 = 0.75', async ({ page }) => {
  await write(page, '2.5×2=', { x: 120, y: 160, seed: 2, size: 48 });
  await write(page, '0.5+0.25=', { x: 120, y: 330, seed: 3, size: 48 });
  const a = await settled(page);
  expect(a.map((x) => x.text)).toEqual(['5', '0.75']);
});

test('writing near the right edge stays reachable when the window gets narrower', async ({ page }) => {
  await write(page, '9+4=', { x: 900, y: 200, seed: 3 });
  expect((await settled(page)).map((x) => x.text)).toEqual(['13']);
  // like zooming the browser in: the page is now narrower than the writing
  await page.setViewportSize({ width: 700, height: 720 });
  const sideways = () =>
    page.evaluate(() => {
      const c = (window as unknown as { calcink: { app: { canvas: { scrollX: number; pageWidth: number; size: { width: number } } } } }).calcink.app.canvas;
      return { x: c.scrollX, page: c.pageWidth, view: c.size.width };
    });
  await expect.poll(async () => (await sideways()).view).toBe(700);
  let s = await sideways();
  expect(s.page).toBeGreaterThan(s.view);
  await expect(page.locator('.scroll-thumb-x')).toBeVisible();
  // shift + wheel scrolls sideways
  await page.mouse.move(350, 400);
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, 2000);
  await page.keyboard.up('Shift');
  await expect.poll(async () => (await sideways()).x).toBe(s.page - s.view);
  // writing after scrolling sideways lands in page coordinates
  s = await sideways();
  await write(page, '2+2=', { x: 300, y: 360, seed: 5 });
  const a = await settled(page);
  expect(a.map((x) => x.text)).toEqual(['13', '4']);
  // a wide window again: no sideways scroll left
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect.poll(async () => (await sideways()).x).toBe(0);
  await expect(page.locator('.scroll-thumb-x')).toBeHidden();
});
