import { describe, expect, it } from 'vitest';
import { countReversals, isScratchGesture, strokesUnderScratch } from './scratch.ts';
import type { Point, Stroke } from './types.ts';

/** Zig-zag across [x0,x1] `passes` times, drifting down by `drift` px per pass. */
function scribble(x0: number, x1: number, y: number, passes: number, drift = 6): Point[] {
  const pts: Point[] = [];
  for (let k = 0; k < passes; k++) {
    const from = k % 2 === 0 ? x0 : x1;
    const to = k % 2 === 0 ? x1 : x0;
    for (let s = 0; s <= 8; s++) {
      pts.push({ x: from + ((to - from) * s) / 8, y: y + k * drift });
    }
  }
  return pts;
}

/** Plausible handwritten shapes, sampled densely. */
function curve(fn: (t: number) => Point, n = 40): Point[] {
  return Array.from({ length: n + 1 }, (_, i) => fn(i / n));
}

describe('countReversals', () => {
  it('counts direction changes beyond the amplitude threshold', () => {
    expect(countReversals([0, 10, 0, 10, 0, 10], 5)).toBe(4);
  });
  it('ignores jitter smaller than the amplitude', () => {
    expect(countReversals([0, 1, 0, 1, 0, 1, 0, 1], 5)).toBe(0);
  });
  it('is zero for monotonic input and for empty input', () => {
    expect(countReversals([1, 2, 3, 4, 5], 1)).toBe(0);
    expect(countReversals([], 1)).toBe(0);
  });
});

describe('isScratchGesture', () => {
  it('recognises a horizontal scribble', () => {
    expect(isScratchGesture(scribble(0, 120, 50, 6))).toBe(true);
  });
  it('recognises a tight scribble over a single digit', () => {
    expect(isScratchGesture(scribble(0, 32, 50, 7, 4))).toBe(true);
  });
  it('recognises a vertical scribble', () => {
    const vertical = scribble(0, 100, 20, 6).map((p) => ({ x: p.y, y: p.x }));
    expect(isScratchGesture(vertical)).toBe(true);
  });
  it('does not fire for too few points', () => {
    expect(isScratchGesture(scribble(0, 120, 50, 1))).toBe(false);
  });

  // The digits and operators we actually write must never be mistaken for a scribble.
  it('does not fire for a digit 8', () => {
    const eight = curve((t) => ({
      x: 20 + 14 * Math.sin(2 * Math.PI * t),
      y: 30 + 25 * Math.sin(Math.PI * t * 2) * Math.cos(Math.PI * t) + 25 * t * 0,
    }));
    expect(isScratchGesture(eight)).toBe(false);
  });
  it('does not fire for a digit 3 / S shape', () => {
    const three = curve((t) => ({ x: 20 + 14 * Math.sin(4 * Math.PI * t), y: 60 * t }));
    expect(isScratchGesture(three)).toBe(false);
  });
  it('does not fire for an M or W written in one stroke', () => {
    const w = curve((t) => ({ x: 80 * t, y: 40 * Math.abs(Math.sin(2 * Math.PI * t)) }));
    expect(isScratchGesture(w)).toBe(false);
  });
  it('does not fire for a plain line, plus sign arm or a long wavy line', () => {
    expect(isScratchGesture(curve((t) => ({ x: 100 * t, y: 5 }))) ).toBe(false);
    expect(isScratchGesture(curve((t) => ({ x: 600 * t, y: 20 * Math.sin(20 * t) }), 200))).toBe(false);
  });
});

describe('strokesUnderScratch', () => {
  const box = (id: number, x: number, y: number): Stroke => ({
    id,
    lineWidth: 3,
    points: [
      { x, y },
      { x: x + 20, y },
      { x: x + 20, y: y + 30 },
      { x, y: y + 30 },
    ],
  });

  it('selects strokes mostly covered by the scribble', () => {
    const scratch = scribble(0, 100, 0, 8, 6); // covers x 0..100, y 0..42
    const strokes = [box(1, 10, 5), box(2, 60, 5), box(3, 400, 5)];
    expect(strokesUnderScratch(strokes, scratch).map((s) => s.id)).toEqual([1, 2]);
  });
  it('does not select a stroke that merely touches the edge', () => {
    const scratch = scribble(0, 100, 0, 8, 6);
    const edge = box(1, 95, 5); // only the left edge points fall inside
    expect(strokesUnderScratch([edge], scratch).length).toBe(0);
  });
  it('selects nothing when nothing is under it', () => {
    expect(strokesUnderScratch([box(1, 500, 500)], scribble(0, 100, 0, 6))).toEqual([]);
  });
});
