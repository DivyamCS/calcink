import { describe, expect, it } from 'vitest';
import { overlaps, placeCard, type Box } from './place.ts';

const page: Box = { minX: 12, minY: 12, maxX: 1268, maxY: 848 };
const box = (minX: number, minY: number, maxX: number, maxY: number): Box => ({ minX, minY, maxX, maxY });

describe('placeCard', () => {
  it('an empty page: exactly at the anchor, full size', () => {
    expect(placeCard({ x: 300, y: 100 }, 280, 190, [], page)).toEqual({ box: box(300, 100, 580, 290), scale: 1 });
  });

  it('never overlaps an obstacle (with margin) and stays on the page', () => {
    const obstacles = [box(250, 80, 700, 300), box(0, 0, 1280, 60), box(900, 100, 1100, 600)];
    const p = placeCard({ x: 300, y: 100 }, 280, 190, obstacles, page);
    expect(p).not.toBeNull();
    for (const o of obstacles) expect(overlaps(p!.box, o, 8)).toBe(false);
    expect(p!.box.minX).toBeGreaterThanOrEqual(page.minX);
    expect(p!.box.maxY).toBeLessThanOrEqual(page.maxY);
  });

  it('prefers staying on the row (to the right) over dropping far down', () => {
    const p = placeCard({ x: 300, y: 100 }, 280, 190, [box(290, 90, 500, 200)], page)!;
    expect(p.box.minY).toBe(100);
    expect(p.box.minX).toBeGreaterThan(500);
  });

  it('shrinks the card when only a smaller one fits near its equation', () => {
    // a 150 px high gap between two bands of writing, the rest of the page is full
    const obstacles = [box(0, 0, 1280, 100), box(0, 260, 1280, 860)];
    const p = placeCard({ x: 300, y: 110 }, 280, 190, obstacles, page)!;
    expect(p.scale).toBeLessThan(1);
    for (const o of obstacles) expect(overlaps(p.box, o, 8)).toBe(false);
  });

  it('gives up (null) when nothing fits at any size', () => {
    expect(placeCard({ x: 300, y: 100 }, 280, 190, [box(0, 0, 1280, 860)], page)).toBeNull();
    expect(placeCard({ x: 0, y: 0 }, 3000, 190, [], page)).toBeNull();
  });

  it('several cards placed one after another never overlap each other', () => {
    const placed: Box[] = [];
    const ink = [0, 1, 2, 3, 4, 5].map((i) => box(100, 120 + i * 112, 360, 170 + i * 112));
    for (let i = 0; i < 6; i++) {
      const p = placeCard({ x: 376, y: 114 + i * 112 }, 280, 190, [...ink, ...placed], page);
      if (p) placed.push(p.box);
    }
    expect(placed.length).toBeGreaterThanOrEqual(4);
    placed.forEach((a, i) => placed.forEach((b, j) => i < j && expect(overlaps(a, b)).toBe(false)));
  });
});

describe('softBottom: stay on the screen of the equation', () => {
  it('prefers beside the equation over below the screen', () => {
    const ink = [box(100, 560, 400, 620)];
    const free = placeCard({ x: 416, y: 554 }, 280, 190, ink, { ...page, maxY: 1400 });
    expect(free!.box.maxY).toBeGreaterThan(700); // without a screen bottom it just hangs down
    const kept = placeCard({ x: 416, y: 554 }, 280, 190, ink, { ...page, maxY: 1400 }, { softBottom: 700 });
    expect(kept!.box.maxY).toBeLessThanOrEqual(700);
  });
});
