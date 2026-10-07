import { expect, test } from '@playwright/test';
import { answers, charBox, drawStrokes, openApp, settled, write } from './helpers.ts';
import { handwrite } from './handwriting.ts';

test.beforeEach(async ({ page }) => {
  await openApp(page, '?delay=300');
});

test('18+4×3= shows 30 next to the equals sign', async ({ page }) => {
  await write(page, '18+4×3=', { x: 120, y: 160, seed: 3 });
  const [a] = await settled(page);
  expect(a).toMatchObject({ kind: 'value', text: '30' });
});

test('division by zero shows Undefined, never a crash', async ({ page }) => {
  await write(page, '9÷0=', { x: 120, y: 160, seed: 1 });
  expect((await settled(page))[0]).toMatchObject({ kind: 'undefined', text: 'Undefined' });
});

test('several lines are read independently', async ({ page }) => {
  await write(page, '12+34=', { x: 120, y: 140, seed: 1 });
  await write(page, '7×8=', { x: 120, y: 260, seed: 2 });
  await write(page, '2.5×4=', { x: 120, y: 380, seed: 3 });
  const a = await settled(page);
  expect(a.map((x) => x.text)).toEqual(['46', '56', '10']);
});

test('editing a number updates the answer', async ({ page }) => {
  const strokes = await write(page, '12+3=', { x: 120, y: 160, seed: 5 });
  expect((await settled(page))[0]).toMatchObject({ text: '15' });

  // erase the "3" with the stroke eraser
  const box = charBox(strokes, 3);
  await page.click('[data-tool="stroke-eraser"]');
  await page.mouse.move(box.minX + 4, (box.minY + box.maxY) / 2);
  await page.mouse.down();
  for (let y = box.minY; y <= box.maxY; y += 4) await page.mouse.move((box.minX + box.maxX) / 2, y);
  await page.mouse.up();
  await page.click('[data-tool="pen"]');
  // and write a 4 where it was
  await drawStrokes(page, handwrite('4', { x: box.minX, y: 160, seed: 6 }));
  expect((await settled(page))[0]).toMatchObject({ text: '16' });

  // undo the "4" (two strokes) and the erase: the old answer is back instantly (cached, no new model run)
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
  expect((await settled(page))[0]).toMatchObject({ text: '15' });
  // redo everything
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+Shift+z');
  expect((await settled(page))[0]).toMatchObject({ text: '16' });
});

test('pixel eraser splits a stroke', async ({ page }) => {
  const strokes = await write(page, '17+1=', { x: 120, y: 160, seed: 2 });
  await settled(page);
  const before = await page.evaluate(() => (window as any).calcink.app.canvas.currentStrokes.length);
  const plus = charBox(strokes, 2);
  await page.click('[data-tool="pixel-eraser"]');
  await page.keyboard.press('['); // smallest eraser that still cuts
  await page.mouse.move(plus.minX + 3, plus.minY - 6);
  await page.mouse.down();
  await page.mouse.move(plus.minX + 3, plus.maxY + 6, { steps: 10 }); // a vertical cut through the left of "+"
  await page.mouse.up();
  const after = await page.evaluate(() => (window as any).calcink.app.canvas.currentStrokes.length);
  expect(after).toBeGreaterThanOrEqual(before); // the bar was shortened or split, never lost entirely
  const lines = await settled(page);
  expect(lines[0].latex).toBeTruthy(); // the changed line was recognised again
  await page.keyboard.press('Control+z'); // one undo step for the whole cut
  expect(await page.evaluate(() => (window as any).calcink.app.canvas.currentStrokes.length)).toBe(before);
});

test('clear removes everything and is undoable', async ({ page }) => {
  await write(page, '6×7=', { x: 120, y: 160, seed: 1 });
  expect((await settled(page))[0]).toMatchObject({ text: '42' });
  await page.click('#clear');
  expect(await answers(page)).toEqual([]);
  await page.click('#undo');
  expect((await settled(page))[0]).toMatchObject({ text: '42' });
});

test('scratch-to-erase: scribbling over a line rubs it out', async ({ page }) => {
  await write(page, '5+5=', { x: 120, y: 160, seed: 1 });
  expect((await settled(page))[0]).toMatchObject({ text: '10' });
  // a back-and-forth scribble covering the whole line (writing spans y 160..216)
  await page.mouse.move(105, 150);
  await page.mouse.down();
  for (let i = 0; i < 8; i++) {
    await page.mouse.move(400, 150 + i * 10, { steps: 10 });
    await page.mouse.move(105, 155 + i * 10, { steps: 10 });
  }
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).calcink.app.canvas.currentStrokes.length)).toBe(0);
});

test('scribble eraser', async ({ page }) => {
  const strokes = await write(page, '12+3=', { x: 120, y: 160, seed: 5 });
  expect((await settled(page))[0]).toMatchObject({ text: '15' });
  const before = await page.evaluate(() => (window as any).calcink.app.canvas.currentStrokes.length);
  const three = charBox(strokes, 3);
  await page.keyboard.press('s');
  await expect(page.locator('button[data-tool="scribble-eraser"]')).toHaveAttribute('aria-pressed', 'true');
  // a small zig-zag (too small for automatic scratch-to-erase): the tool counts it anyway
  await page.mouse.move(three.minX - 2, three.minY - 2);
  await page.mouse.down();
  await page.mouse.move(three.maxX + 2, (three.minY + three.maxY) / 2, { steps: 6 });
  await page.mouse.move(three.minX - 2, three.maxY + 2, { steps: 6 });
  await page.mouse.move(three.maxX + 2, three.maxY + 2, { steps: 6 });
  await page.mouse.up();
  const after = await page.evaluate(() => (window as any).calcink.app.canvas.currentStrokes.length);
  expect(after).toBeLessThan(before);
  await page.keyboard.press('p');
  await drawStrokes(page, handwrite('4', { x: three.minX, y: 160, seed: 6 }));
  expect((await settled(page))[0]).toMatchObject({ text: '16' });
  for (let i = 0; i < 2; i++) await page.keyboard.press('Control+z'); // the "4" (two strokes)
  await page.keyboard.press('Control+z'); // the scribble erase is one step
  expect(await page.evaluate(() => (window as any).calcink.app.canvas.currentStrokes.length)).toBe(before);
});

test('variables: x = 10 then x + 5 =', async ({ page }) => {
  const def = await write(page, 'x=10', { x: 120, y: 140, seed: 1 });
  await write(page, 'x+5=', { x: 120, y: 280, seed: 2 });
  let a = await settled(page);
  expect(a[0]).toMatchObject({ kind: 'assigned', text: '10' });
  expect(a[1]).toMatchObject({ kind: 'value', text: '15' });

  // change "10" into "20": rub out the number with the stroke eraser and write the new one in its place
  const one = charBox(def, 2);
  const zero = charBox(def, 3);
  await page.click('[data-tool="stroke-eraser"]');
  await page.mouse.move(one.minX - 2, (one.minY + one.maxY) / 2);
  await page.mouse.down();
  await page.mouse.move(zero.maxX + 2, (zero.minY + zero.maxY) / 2, { steps: 20 });
  await page.mouse.up();
  await page.click('[data-tool="pen"]');
  await drawStrokes(page, handwrite('20', { x: one.minX, y: 140, seed: 3 }));
  a = await settled(page);
  expect(a[0]).toMatchObject({ kind: 'assigned', text: '20' });
  expect(a[1]).toMatchObject({ kind: 'value', text: '25' });
});

test('graph: y = x² draws a curve next to the equation', async ({ page }) => {
  await page.click('#graphs'); // graphs are off by default
  await write(page, 'y=x²', { x: 120, y: 200, seed: 1 });
  expect((await settled(page))[0]).toMatchObject({ kind: 'plot' });
  await page.waitForTimeout(700); // let the curve finish its write-on animation
  // the graph card has blue ink: sample the overlay canvas right of the equation
  const blue = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.overlay-layer') as HTMLCanvasElement;
    const d = (c.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 140 && d[i] < 80 && d[i + 3] > 200) n++;
    return n;
  });
  expect(blue).toBeGreaterThan(200);
});

test('two calculations side by side on one row get one answer each', async ({ page }) => {
  await write(page, '2+3=', { x: 120, y: 160, seed: 1 });
  await write(page, '4×5=', { x: 700, y: 165, seed: 2 });
  const a = await settled(page);
  expect(a.map((x) => x.text)).toEqual(['5', '20']);
});

test('negative numbers: 5×−3 and −7×−2 (a "×" the model reads as the letter x)', async ({ page }) => {
  await write(page, '5×-3=', { x: 120, y: 140, seed: 1 });
  await write(page, '-7×-2=', { x: 120, y: 280, seed: 2 });
  await write(page, '-4+2=', { x: 120, y: 420, seed: 3 });
  const a = await settled(page);
  expect(a.map((x) => x.text)).toEqual(['-15', '14', '-2']);
});

test('HiDPI backing store', async ({ page }) => {
  const r = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.ink-layer') as HTMLCanvasElement;
    return { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight, dpr: devicePixelRatio };
  });
  expect(r.dpr).toBe(2);
  expect(r.w).toBe(Math.round(r.cw * r.dpr));
  expect(r.h).toBe(Math.round(r.ch * r.dpr));
});

test('toolbar: pen width keys and tidy toggle', async ({ page }) => {
  await page.keyboard.press(']');
  expect(await page.inputValue('#width')).toBe('5');
  await expect(page.locator('#tidy')).toHaveAttribute('aria-pressed', 'false'); // your own ink by default
  await page.keyboard.press('t');
  await expect(page.locator('#tidy')).toHaveAttribute('aria-pressed', 'true');
});
