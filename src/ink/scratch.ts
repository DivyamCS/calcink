// Scratch-to-erase: scribbling back and forth over ink erases it.
import { pointsBBox, rectHeight, rectWidth } from './geometry.ts';
import type { Point, Rect, Stroke } from './types.ts';

const MIN_POINTS = 12;
const MIN_EXTENT = 24; // px along the scribbling axis
const MIN_REVERSALS = 4; // 5 passes
const MIN_PATH_TO_EXTENT = 5; // path must be at least this many times the extent

function pathLength(points: readonly Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return len;
}

/** Count direction reversals of a 1-D signal, ignoring wiggles smaller than `amplitude`. */
export function countReversals(values: readonly number[], amplitude: number): number {
  if (values.length === 0) return 0;
  let dir = 0;
  let anchor = values[0];
  let reversals = 0;
  for (const v of values) {
    if (dir === 0) {
      if (Math.abs(v - anchor) >= amplitude) {
        dir = v > anchor ? 1 : -1;
        anchor = v;
      }
    } else if (dir === 1) {
      if (v > anchor) anchor = v;
      else if (anchor - v >= amplitude) {
        dir = -1;
        reversals++;
        anchor = v;
      }
    } else if (v < anchor) {
      anchor = v;
    } else if (v - anchor >= amplitude) {
      dir = 1;
      reversals++;
      anchor = v;
    }
  }
  return reversals;
}

/** At least 5 back-and-forth sweeps over a small area. Normal digits and letters never get close. */
export function isScratchGesture(points: readonly Point[]): boolean {
  if (points.length < MIN_POINTS) return false;
  const box = pointsBBox(points);
  const w = rectWidth(box);
  const h = rectHeight(box);
  const len = pathLength(points);

  const axes: Array<{ values: number[]; extent: number; cross: number }> = [
    { values: points.map((p) => p.x), extent: w, cross: h },
    { values: points.map((p) => p.y), extent: h, cross: w },
  ];
  return axes.some(({ values, extent, cross }) => {
    if (extent < MIN_EXTENT) return false;
    if (cross > extent * 2) return false; // a long wavy line, not a scribble
    if (len < extent * MIN_PATH_TO_EXTENT) return false;
    return countReversals(values, Math.max(8, extent * 0.3)) >= MIN_REVERSALS;
  });
}

function insideRect(p: Point, r: Rect, margin: number): boolean {
  return p.x >= r.minX - margin && p.x <= r.maxX + margin && p.y >= r.minY - margin && p.y <= r.maxY + margin;
}

/** Strokes with at least `coverage` of their points inside the scribble's box. */
export function strokesUnderScratch(
  strokes: readonly Stroke[],
  scratch: readonly Point[],
  coverage = 0.6,
  margin = 6,
): Stroke[] {
  const box = pointsBBox(scratch);
  return strokes.filter((s) => {
    if (s.points.length === 0) return false;
    const inside = s.points.filter((p) => insideRect(p, box, margin)).length;
    return inside / s.points.length >= coverage;
  });
}
