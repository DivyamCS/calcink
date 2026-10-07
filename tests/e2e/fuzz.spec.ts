import { expect, test, type Page } from '@playwright/test';
import { handwrite, rng } from './handwriting.ts';
import { answers, drawStrokes, openApp, settled } from './helpers.ts';

type Box = { minX: number; minY: number; maxX: number; maxY: number };
type Expect = { text: string; kind: string } | { kinds: string[] };

/** text -> what its line must show while it is intact (x-dependent ones: only the kind) */
const POOL: Record<string, Expect> = {
  '12+3=': { kind: 'value', text: '15' },
  '6×7=': { kind: 'value', text: '42' },
  '9-4=': { kind: 'value', text: '5' },
  '8÷2=': { kind: 'value', text: '4' },
  '3²=': { kind: 'value', text: '9' },
  '2.5×2=': { kind: 'value', text: '5' },
  '15+30=': { kind: 'value', text: '45' },
  '7×8=': { kind: 'value', text: '56' },
  '100-1=': { kind: 'value', text: '99' },
  '4.5+1=': { kind: 'value', text: '5.5' },
  '0.5+0.25=': { kind: 'value', text: '0.75' },
  'x=4': { kinds: ['assigned'] },
  'y=x²': { kinds: ['plot', 'assigned', 'value'] }, // a formula; with x = 4 above it, still a formula (plot)
  '2x+4=10': { kinds: ['solved', 'value'] }, // solved, or (x known above) evaluated
};
const TEXTS = Object.keys(POOL);
const ROWS = 12;
const ROW_Y = (k: number): number => 130 + k * 105; // page y of a row's top
const COL_X = [110, 660];
const SIZE = 40;

interface Written {
  text: string;
  slot: number;
  /** first point of each stroke, page coordinates (identifies the strokes on the canvas) */
  starts: Array<{ x: number; y: number }>;
  region: Box;
}

const app = <T,>(page: Page, js: string): Promise<T> => page.evaluate(js) as Promise<T>;
const scrollY = (page: Page): Promise<number> => app<number>(page, 'window.calcink.app.canvas.scrollY');
const strokeStarts = (page: Page): Promise<Array<{ x: number; y: number }>> =>
  app(page, 'window.calcink.app.canvas.currentStrokes.map((s) => ({ x: s.points[0].x, y: s.points[0].y }))');
const near = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => Math.abs(a.x - b.x) < 0.6 && Math.abs(a.y - b.y) < 0.6;
const inside = (p: { x: number; y: number }, b: Box): boolean => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
const hits = (a: Box, b: Box): boolean => a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;

async function scrollTo(page: Page, y: number): Promise<void> {
  await page.evaluate((v) => (window as any).calcink.app.canvas.scrollTo(v), y);
  await page.waitForTimeout(60);
}

async function check(page: Page, written: Written[], step: string): Promise<void> {
  const a = await settled(page);
  expect(a.every((x) => x.kind !== 'pending'), `${step}: a line was left unread`).toBe(true);
  const status = (await page.textContent('#status-text')) ?? '';
  expect(status, `${step}: status`).not.toMatch(/Couldn't|error/i);

  // untouched calculations show exactly their answer
  const starts = await strokeStarts(page);
  const views = await app<Array<{ bbox: Box; n: number; kind?: string; text?: string }>>(
    page,
    'window.calcink.app.recognizer.views.map((v) => ({ bbox: v.line.bbox, n: v.line.strokes.length, kind: v.result?.answer.kind, text: v.result?.answer.text }))',
  );
  for (const w of written) {
    const present = w.starts.every((s) => starts.some((t) => near(s, t)));
    const others = starts.filter((t) => inside(t, w.region) && !w.starts.some((s) => near(s, t)));
    if (!present || others.length > 0) continue; // erased, damaged or written over: no promise
    const v = views.find((x) => x.n === w.starts.length && w.starts.every((s) => inside(s, { minX: x.bbox.minX - 1, minY: x.bbox.minY - 1, maxX: x.bbox.maxX + 1, maxY: x.bbox.maxY + 1 })));
    expect(v, `${step}: "${w.text}" in row ${w.slot} is not one line of its own`).toBeTruthy();
    const e = POOL[w.text];
    if ('text' in e) expect({ kind: v!.kind, text: v!.text }, `${step}: "${w.text}"`).toEqual({ kind: e.kind, text: e.text });
    else expect(e.kinds, `${step}: "${w.text}" kind`).toContain(v!.kind);
  }

  // graph cards never cover ink, answers or each other
  const l = await app<{ cards: Box[]; texts: Box[]; ink: Box[] }>(page, 'window.calcink.app.layout');
  l.cards.forEach((c, i) => {
    l.cards.forEach((d, j) => j > i && expect(hits(c, d), `${step}: card ${i} overlaps card ${j}`).toBe(false));
    l.ink.forEach((k) => expect(hits(c, k), `${step}: card ${i} covers ink`).toBe(false));
    l.texts.forEach((t) => expect(hits(c, t), `${step}: card ${i} covers an answer`).toBe(false));
  });
}

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  await openApp(page, '?delay=300');
});
test.afterEach(() => expect(errors).toEqual([]));

for (const seed of (process.env.FUZZ_SEEDS ?? '11,23,37').split(',').map(Number)) {
  test(`random session ${seed}: 45 actions, invariants after every step`, async ({ page }) => {
    test.setTimeout(900_000);
    const r = rng(seed);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
    const written: Written[] = [];
    const log: string[] = [];

    const occupied = async (): Promise<Written[]> => {
      const starts = await strokeStarts(page);
      return written.filter((w) => w.starts.some((s) => starts.some((t) => near(s, t))));
    };

    for (let step = 0; step < 45; step++) {
      const roll = r();
      let action: string;
      const sy = await scrollY(page);
      const visible = (k: number): boolean => ROW_Y(k) - sy > 100 && ROW_Y(k) - sy < 600;

      if (roll < 0.36) {
        // write into a free slot that is on screen (scroll to one if needed)
        const taken = await occupied();
        const free: number[] = [];
        for (let k = 0; k < ROWS; k++) for (let c = 0; c < 2; c++) if (!taken.some((w) => w.slot === k * 2 + c)) free.push(k * 2 + c);
        if (free.length === 0) {
          action = 'skip (page full)';
        } else {
          const slot = pick(free);
          const k = Math.floor(slot / 2);
          if (!visible(k)) await scrollTo(page, Math.max(0, ROW_Y(k) - 250));
          const s2 = await scrollY(page);
          const text = pick(TEXTS);
          const strokes = handwrite(text, { x: COL_X[slot % 2], y: ROW_Y(k) - s2, size: SIZE, seed: 1 + (step % 3) });
          await drawStrokes(page, strokes);
          const pts = strokes.flatMap((st) => st.points);
          written.push({
            text,
            slot,
            starts: strokes.map((st) => ({ x: st.points[0].x, y: st.points[0].y + s2 })),
            region: { minX: COL_X[slot % 2] - 30, minY: ROW_Y(k) - 30, maxX: COL_X[slot % 2] + 500, maxY: ROW_Y(k) + 80 },
          });
          action = `write "${text}" in slot ${slot} (bbox y ${Math.round(Math.min(...pts.map((p) => p.y)))})`;
        }
      } else if (roll < 0.56) {
        // erase something on screen with one of the three erasers
        const onScreen = (await occupied()).filter((w) => visible(Math.floor(w.slot / 2)));
        if (onScreen.length === 0) action = 'skip (nothing to erase on screen)';
        else {
          const w = pick(onScreen);
          const s2 = await scrollY(page);
          const y0 = w.region.minY + 30 - s2;
          const x0 = COL_X[w.slot % 2];
          const kind = pick(['stroke', 'scribble', 'rubout']);
          if (kind === 'scribble') {
            await page.keyboard.press('s');
            await page.mouse.move(x0 - 5, y0 - 5);
            await page.mouse.down();
            for (let i = 0; i < 5; i++) {
              await page.mouse.move(x0 + 180, y0 + i * 9, { steps: 6 });
              await page.mouse.move(x0 - 5, y0 + i * 9 + 5, { steps: 6 });
            }
            await page.mouse.up();
            await page.keyboard.press('p');
          } else {
            await page.click(kind === 'stroke' ? '[data-tool="stroke-eraser"]' : '[data-tool="pixel-eraser"]');
            await page.mouse.move(x0 - 5, y0 + 20);
            await page.mouse.down();
            await page.mouse.move(x0 + 240, y0 + 22, { steps: 25 });
            await page.mouse.up();
            await page.click('[data-tool="pen"]');
          }
          action = `${kind}-erase "${w.text}" in slot ${w.slot}`;
        }
      } else if (roll < 0.68) {
        const n = 1 + Math.floor(r() * 3);
        for (let i = 0; i < n; i++) await page.keyboard.press('Control+z');
        action = `undo ×${n}`;
      } else if (roll < 0.76) {
        const n = 1 + Math.floor(r() * 2);
        for (let i = 0; i < n; i++) await page.keyboard.press('Control+Shift+z');
        action = `redo ×${n}`;
      } else if (roll < 0.94) {
        const key = pick(['g', 'g', 't', 'b', 'c', 'wheel-down', 'wheel-up', 'pagedown', 'pageup']);
        if (key === 'wheel-down' || key === 'wheel-up') {
          await page.mouse.move(900, 400);
          await page.mouse.wheel(0, key === 'wheel-down' ? 500 : -500);
          await page.waitForTimeout(300);
        } else if (key === 'pagedown' || key === 'pageup') await page.keyboard.press(key === 'pagedown' ? 'PageDown' : 'PageUp');
        else await page.keyboard.press(key);
        action = `key ${key}`;
      } else if (roll < 0.97) {
        await page.click('#clear');
        action = 'clear';
      } else {
        if (await page.isEnabled('#undo')) {
          await page.click('#undo');
          action = 'undo button';
        } else action = 'undo button (disabled: nothing to undo)';
      }
      log.push(`${step}: ${action}`);
      await check(page, written, `seed ${seed}, step ${step} (${action})\n${log.slice(-6).join('\n')}`);
    }

    // undo everything: an empty page; redo everything: the very same answers
    const before = (await answers(page)).map((a) => `${a.kind}:${a.text ?? ''}`);
    const n = (await strokeStarts(page)).length;
    let undos = 0;
    while (await app<boolean>(page, 'window.calcink.app.canvas.canUndo')) {
      await page.keyboard.press('Control+z');
      undos++;
      if (undos > 400) break;
    }
    expect((await strokeStarts(page)).length).toBe(0);
    for (let i = 0; i < undos; i++) await page.keyboard.press('Control+Shift+z');
    expect((await strokeStarts(page)).length).toBe(n);
    const after = (await settled(page)).map((a) => `${a.kind}:${a.text ?? ''}`);
    expect(after).toEqual(before);
    // and the app still calculates
    await scrollTo(page, 0);
    await page.click('#clear');
    await drawStrokes(page, handwrite('7×8=', { x: 110, y: 200, size: SIZE, seed: 2 }));
    expect((await settled(page))[0]).toMatchObject({ kind: 'value', text: '56' });
  });
}
