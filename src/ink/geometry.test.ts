import { describe, expect, it } from 'vitest';
import {
  answerGlyphHeight,
  writingHeight,
  answerPlacement,
  densify,
  distToSegment,
  eraseStrokesAt,
  erasePartAt,
  groupIntoLines,
  isTrivialLine,
  lineSignature,
  median,
  medianGlyphHeight,
  pointsBBox,
  strokeBBox,
  strokeHitsCircle,
  unionRect,
} from './geometry.ts';
import type { Point, Stroke } from './types.ts';

/** Build a stroke from raw coordinates. */
function stroke(id: number, pts: Array<[number, number]>, lineWidth = 2): Stroke {
  return { id, lineWidth, points: pts.map(([x, y]) => ({ x, y })) };
}

/** A box-shaped "glyph" stroke spanning (x,y)-(x+w,y+h). */
function glyph(id: number, x: number, y: number, w: number, h: number): Stroke {
  return stroke(id, [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
    [x, y],
  ]);
}

/** A counter that hands out fresh ids. */
function ids(start = 1000): () => number {
  let n = start;
  return () => n++;
}

describe('rect helpers', () => {
  it('pointsBBox / unionRect', () => {
    const b = pointsBBox([
      { x: 5, y: 9 },
      { x: -2, y: 4 },
      { x: 8, y: 1 },
    ]);
    expect(b).toEqual({ minX: -2, minY: 1, maxX: 8, maxY: 9 });
    expect(unionRect(b, { minX: 0, minY: 0, maxX: 20, maxY: 3 })).toEqual({
      minX: -2,
      minY: 0,
      maxX: 20,
      maxY: 9,
    });
  });
  it('strokeBBox grows by half the pen width', () => {
    expect(strokeBBox(stroke(1, [[10, 10], [20, 20]], 4))).toEqual({ minX: 8, minY: 8, maxX: 22, maxY: 22 });
  });
  it('median', () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('distToSegment', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 0 };
  it('perpendicular distance', () => expect(distToSegment({ x: 5, y: 3 }, a, b)).toBe(3));
  it('distance to the nearest endpoint beyond the segment', () => {
    expect(distToSegment({ x: 13, y: 4 }, a, b)).toBe(5);
    expect(distToSegment({ x: -3, y: -4 }, a, b)).toBe(5);
  });
  it('degenerate zero-length segment', () => expect(distToSegment({ x: 3, y: 4 }, a, a)).toBe(5));
});

describe('strokeHitsCircle', () => {
  const line = stroke(1, [[0, 0], [100, 0]], 4);
  it('hits when the circle overlaps the line', () => {
    expect(strokeHitsCircle(line, { x: 50, y: 5 }, 4)).toBe(true);
  });
  it('misses when clearly away', () => {
    expect(strokeHitsCircle(line, { x: 50, y: 30 }, 4)).toBe(false);
    expect(strokeHitsCircle(line, { x: 300, y: 0 }, 4)).toBe(false);
  });
  it("counts the pen's own thickness (2px each side)", () => {
    expect(strokeHitsCircle(line, { x: 50, y: 5.9 }, 4)).toBe(true); // 5.9 <= 4 + 2
    expect(strokeHitsCircle(line, { x: 50, y: 6.1 }, 4)).toBe(false);
  });
  it('works for a single-point dot (decimal point)', () => {
    const dot = stroke(2, [[10, 10]], 6);
    expect(strokeHitsCircle(dot, { x: 12, y: 10 }, 2)).toBe(true);
    expect(strokeHitsCircle(dot, { x: 40, y: 10 }, 2)).toBe(false);
  });
});

describe('eraseStrokesAt (stroke eraser)', () => {
  const a = stroke(1, [[0, 0], [50, 0]]);
  const b = stroke(2, [[0, 100], [50, 100]]);
  it('removes only the touched strokes', () => {
    const out = eraseStrokesAt([a, b], { x: 25, y: 1 }, 5);
    expect(out).toEqual([b]);
  });
  it('returns the same array when nothing is hit', () => {
    const input = [a, b];
    expect(eraseStrokesAt(input, { x: 500, y: 500 }, 5)).toBe(input);
  });
});

describe('densify', () => {
  it('inserts points so no gap exceeds maxGap', () => {
    const out = densify([{ x: 0, y: 0 }, { x: 10, y: 0 }], 2);
    expect(out.length).toBe(6);
    for (let i = 1; i < out.length; i++) {
      expect(Math.hypot(out[i].x - out[i - 1].x, out[i].y - out[i - 1].y)).toBeLessThanOrEqual(2.0001);
    }
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[out.length - 1]).toEqual({ x: 10, y: 0 });
  });
  it('leaves already-dense strokes alone', () => {
    const pts: Point[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }];
    expect(densify(pts, 5)).toEqual(pts);
  });
});

describe('erasePartAt (pixel eraser)', () => {
  it('pieces keep the stroke colour', () => {
    let n = 500;
    const red: Stroke = { id: 1, lineWidth: 4, color: '#d23a2f', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
    const ink: Stroke = { id: 2, lineWidth: 4, points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] };
    const cutRed = erasePartAt([red], { x: 50, y: 0 }, 5, () => n++);
    expect(cutRed).toHaveLength(2);
    for (const piece of cutRed) expect(piece.color).toBe('#d23a2f');
    for (const piece of erasePartAt([ink], { x: 50, y: 50 }, 5, () => n++)) expect('color' in piece).toBe(false);
  });

  it('cuts a stroke in two and keeps the far pieces', () => {
    const line = stroke(1, [[0, 0], [100, 0]], 2);
    const out = erasePartAt([line], { x: 50, y: 0 }, 10, ids());
    expect(out.length).toBe(2);
    const left = out[0];
    const right = out[1];
    // everything that survives is outside the eraser (radius 10 + half pen width 1)
    for (const s of out) {
      for (const p of s.points) expect(Math.hypot(p.x - 50, p.y)).toBeGreaterThan(10.9);
    }
    expect(pointsBBox(left.points).minX).toBe(0);
    expect(pointsBBox(right.points).maxX).toBe(100);
    // the gap is about the eraser diameter
    const gap = pointsBBox(right.points).minX - pointsBBox(left.points).maxX;
    expect(gap).toBeGreaterThan(20);
    expect(gap).toBeLessThan(26);
  });

  it('gives the new pieces fresh ids and keeps the pen width', () => {
    const line = stroke(7, [[0, 0], [100, 0]], 5);
    const out = erasePartAt([line], { x: 50, y: 0 }, 10, ids(500));
    expect(out.map((s) => s.id)).toEqual([500, 501]);
    expect(out.every((s) => s.lineWidth === 5)).toBe(true);
  });

  it('removes a stroke entirely when the eraser covers all of it', () => {
    const tiny = stroke(1, [[10, 10], [14, 10]], 2);
    expect(erasePartAt([tiny], { x: 12, y: 10 }, 20, ids())).toEqual([]);
  });

  it('trims the end of a stroke without splitting it', () => {
    const line = stroke(1, [[0, 0], [100, 0]], 2);
    const out = erasePartAt([line], { x: 100, y: 0 }, 10, ids());
    expect(out.length).toBe(1);
    expect(pointsBBox(out[0].points).maxX).toBeLessThan(90);
  });

  it('keeps untouched strokes as the same objects', () => {
    const near = stroke(1, [[0, 0], [100, 0]], 2);
    const far = stroke(2, [[0, 200], [100, 200]], 2);
    const out = erasePartAt([near, far], { x: 50, y: 0 }, 10, ids());
    expect(out[out.length - 1]).toBe(far);
  });

  it('returns the SAME array when the eraser touches nothing', () => {
    const input = [stroke(1, [[0, 0], [100, 0]])];
    expect(erasePartAt(input, { x: 50, y: 80 }, 10, ids())).toBe(input);
  });

  it('drops crumbs shorter than the pen width instead of leaving specks', () => {
    // only ~3px of stroke would survive past the eraser edge; the pen is 8px wide
    const line = stroke(1, [[0, 0], [20, 0]], 8);
    expect(erasePartAt([line], { x: 20, y: 0 }, 13, ids())).toEqual([]);
    // ...but a survivor longer than the pen width is kept
    const longer = stroke(2, [[0, 0], [40, 0]], 8);
    const out = erasePartAt([longer], { x: 40, y: 0 }, 13, ids());
    expect(out.length).toBe(1);
    expect(out[0].points.length).toBeGreaterThanOrEqual(2);
  });

  it('handles a long segment crossing the eraser', () => {
    // only two points, both far outside the circle, segment passes through it
    const line = stroke(1, [[0, 0], [200, 0]], 2);
    const out = erasePartAt([line], { x: 100, y: 0 }, 6, ids());
    expect(out.length).toBe(2);
  });
});

describe('groupIntoLines', () => {
  it('returns nothing for an empty canvas', () => {
    expect(groupIntoLines([])).toEqual([]);
  });

  it('keeps glyphs on the same row together, left to right in drawing order', () => {
    const strokes = [glyph(1, 10, 100, 30, 40), glyph(2, 60, 100, 30, 40), glyph(3, 110, 100, 30, 40)];
    const lines = groupIntoLines(strokes);
    expect(lines.length).toBe(1);
    expect(lines[0].strokes.map((s) => s.id)).toEqual([1, 2, 3]);
  });

  it('separates rows that are clearly apart and orders them top to bottom', () => {
    const strokes = [
      glyph(1, 10, 300, 30, 40), // lower row drawn first
      glyph(2, 60, 300, 30, 40),
      glyph(3, 10, 100, 30, 40),
      glyph(4, 60, 100, 30, 40),
    ];
    const lines = groupIntoLines(strokes);
    expect(lines.length).toBe(2);
    expect(lines[0].strokes.map((s) => s.id)).toEqual([3, 4]);
    expect(lines[1].strokes.map((s) => s.id)).toEqual([1, 2]);
  });

  it('keeps small marks (dot, minus, equals bars) with their row', () => {
    const strokes = [
      glyph(1, 10, 100, 30, 40), // digit
      stroke(2, [[50, 138], [51, 139]]), // decimal point at the baseline
      stroke(3, [[60, 120], [90, 120]]), // minus, mid-height
      stroke(4, [[100, 112], [130, 112]]), // equals bar 1
      stroke(5, [[100, 128], [130, 128]]), // equals bar 2
    ];
    expect(groupIntoLines(strokes).length).toBe(1);
  });

  it('keeps a fraction (numerator, bar, denominator) as one line', () => {
    const strokes = [
      glyph(1, 20, 90, 20, 30), // numerator
      stroke(2, [[10, 128], [60, 128]]), // bar
      glyph(3, 20, 136, 20, 30), // denominator
    ];
    expect(groupIntoLines(strokes).length).toBe(1);
  });

  it('keeps a superscript with its line', () => {
    const strokes = [glyph(1, 10, 100, 30, 40), glyph(2, 45, 90, 12, 16)];
    expect(groupIntoLines(strokes).length).toBe(1);
  });

  it('splits two calculations written side by side on one row (left one first)', () => {
    // "2+3=" at x 10..190, then a wide gap, then "4×5=" at x 600..780, both 40 px tall
    const left = [glyph(1, 10, 100, 30, 40), glyph(2, 60, 100, 30, 40), glyph(3, 110, 100, 30, 40), glyph(4, 160, 110, 30, 20)];
    const right = [glyph(5, 600, 102, 30, 40), glyph(6, 650, 102, 30, 40), glyph(7, 700, 102, 30, 40), glyph(8, 750, 112, 30, 20)];
    const lines = groupIntoLines([...right, ...left]);
    expect(lines.length).toBe(2);
    expect(lines[0].strokes.map((s) => s.id)).toEqual([1, 2, 3, 4]);
    expect(lines[1].strokes.map((s) => s.id)).toEqual([5, 6, 7, 8]);
  });

  it('does not split ordinary (even generous) spacing between symbols', () => {
    // gaps of about two characters, as in "18  +  4  ×  3  ="
    const strokes = [0, 1, 2, 3, 4, 5].map((i) => glyph(i + 1, 10 + i * 100, 100, 30, 40));
    expect(groupIntoLines(strokes).length).toBe(1);
  });

  it('computes the union bounding box of the line', () => {
    const lines = groupIntoLines([glyph(1, 10, 100, 30, 40), glyph(2, 100, 105, 30, 30)]);
    expect(lines[0].bbox.minX).toBeLessThan(10);
    expect(lines[0].bbox.maxX).toBeGreaterThan(130);
    expect(lines[0].bbox.minY).toBeLessThan(100);
    expect(lines[0].bbox.maxY).toBeGreaterThan(140);
  });

  it('is stable: the same strokes always give the same line ids', () => {
    const strokes = [glyph(1, 10, 100, 30, 40), glyph(2, 60, 100, 30, 40)];
    expect(groupIntoLines(strokes)[0].id).toBe(groupIntoLines([...strokes])[0].id);
  });

  it('line id changes on add and restores on undo', () => {
    const base = [glyph(1, 10, 100, 30, 40)];
    const before = groupIntoLines(base)[0].id;
    const after = groupIntoLines([...base, glyph(2, 60, 100, 30, 40)])[0].id;
    expect(after).not.toBe(before);
    expect(groupIntoLines(base)[0].id).toBe(before);
  });

  it("an edit to one row doesn't change the other row's id", () => {
    const top = [glyph(1, 10, 100, 30, 40), glyph(2, 60, 100, 30, 40)];
    const bottom = [glyph(3, 10, 300, 30, 40)];
    const idBefore = groupIntoLines([...top, ...bottom]).find((l) => l.strokes[0].id === 1)?.id;
    const idAfter = groupIntoLines([...top, ...bottom, glyph(4, 60, 300, 30, 40)]).find(
      (l) => l.strokes[0].id === 1,
    )?.id;
    expect(idAfter).toBe(idBefore);
  });
});

describe('lineSignature / medianGlyphHeight / isTrivialLine', () => {
  it('signature ignores stroke order', () => {
    const a = glyph(1, 0, 0, 10, 10);
    const b = glyph(2, 20, 0, 10, 10);
    expect(lineSignature([a, b])).toBe(lineSignature([b, a]));
  });
  it('medianGlyphHeight ignores specks and falls back when there are only specks', () => {
    expect(medianGlyphHeight([glyph(1, 0, 0, 10, 40), glyph(2, 20, 0, 10, 40), stroke(3, [[0, 0], [1, 1]])])).toBe(40);
    expect(medianGlyphHeight([stroke(1, [[0, 0], [1, 1]])])).toBe(24);
  });
  it('isTrivialLine flags accidental taps only', () => {
    const [tap] = groupIntoLines([stroke(1, [[10, 10], [11, 11]])]);
    expect(isTrivialLine(tap)).toBe(true);
    const [real] = groupIntoLines([glyph(2, 10, 10, 30, 40)]);
    expect(isTrivialLine(real)).toBe(false);
  });
});

describe('answerPlacement', () => {
  it('puts the answer to the right of the equals sign, level with it', () => {
    const strokes = [
      glyph(1, 10, 100, 30, 40),
      stroke(2, [[100, 112], [130, 112]]), // "=" bar 1
      stroke(3, [[100, 128], [130, 128]]), // "=" bar 2
    ];
    const [line] = groupIntoLines(strokes);
    const place = answerPlacement(line, 40);
    expect(place.x).toBeGreaterThan(line.bbox.maxX);
    expect(Math.abs(place.y - 120)).toBeLessThan(6); // centred between the two bars
  });
  it('scales the font with the handwriting but within sane bounds', () => {
    const [line] = groupIntoLines([glyph(1, 0, 0, 10, 10)]);
    expect(answerPlacement(line, 4).fontSize).toBe(20);
    expect(answerPlacement(line, 40).fontSize).toBeCloseTo(38, 5);
    expect(answerPlacement(line, 500).fontSize).toBe(120);
  });
});

describe('answerGlyphHeight', () => {
  it('is not dragged down by many small strokes (division dots, equals bars)', () => {
    const strokes = [
      glyph(1, 0, 0, 40, 130), // 3
      glyph(2, 60, 0, 40, 130), // 2
      glyph(3, 120, 40, 10, 14), // division dot
      glyph(4, 120, 90, 10, 14), // division dot
      glyph(5, 160, 0, 40, 130), // 4
      glyph(6, 220, 50, 40, 9), // = bar
      glyph(7, 220, 70, 40, 9), // = bar
    ];
    expect(answerGlyphHeight(strokes)).toBe(130);
  });
  it('falls back when there are only specks', () => {
    expect(answerGlyphHeight([stroke(1, [[0, 0], [1, 1]])])).toBe(24);
  });
});

describe('writingHeight (answer size)', () => {
  let id = 1000;
  const seg = (x1: number, y1: number, x2: number, y2: number): Stroke => ({
    id: id++,
    lineWidth: 3,
    points: [{ x: x1, y: y1 }, { x: x2, y: y2 }],
  });
  const box = (x: number, y: number, w: number, h: number): Stroke => ({
    id: id++,
    lineWidth: 3,
    points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
  });
  it('7×8= is measured at the real writing height, not half of it (regression)', () => {
    const strokes = [
      seg(0, 0, 30, 0), seg(30, 0, 10, 60), //            7 (two strokes, 60 high)
      seg(45, 20, 75, 50), seg(75, 20, 45, 50), //        × (two 30-high diagonals)
      box(90, 0, 30, 28), box(88, 30, 34, 30), //         8 drawn as two loops
      seg(135, 25, 170, 25), seg(135, 38, 170, 38), //    =
    ];
    expect(writingHeight(strokes)).toBeGreaterThanOrEqual(58);
  });
  it('x + 5 = : short glyphs (x, +) do not shrink the answer', () => {
    const strokes = [
      seg(0, 28, 26, 56), seg(26, 28, 0, 56), //        x (half height)
      seg(36, 42, 66, 42), seg(51, 27, 51, 57), //      +
      box(80, 0, 30, 56), //                            5 (full height)
      seg(125, 25, 160, 25), seg(125, 38, 160, 38), //  =
    ];
    expect(writingHeight(strokes)).toBe(56);
  });
  it('flat symbols alone fall back to a default', () => {
    expect(writingHeight([seg(0, 10, 40, 10)])).toBe(24);
    expect(writingHeight([])).toBe(24);
  });
});
