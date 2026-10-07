// Geometry for ink: bounding boxes, hit testing, erasers and grouping strokes into lines. No DOM.
import type { Line, Point, Rect, Stroke } from './types.ts';

export function pointsBBox(points: readonly Point[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function unionRect(a: Rect, b: Rect): Rect {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export const rectWidth = (r: Rect): number => r.maxX - r.minX;
export const rectHeight = (r: Rect): number => r.maxY - r.minY;

/** Visible extent of a stroke: its points grown by half the pen width. */
export function strokeBBox(stroke: Stroke): Rect {
  const b = pointsBBox(stroke.points);
  const h = stroke.lineWidth / 2;
  return { minX: b.minX - h, minY: b.minY - h, maxX: b.maxX + h, maxY: b.maxY + h };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Hit testing & erasing

/** Distance from point p to the segment a-b. */
export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Does the eraser circle touch the stroke (accounting for the pen's own thickness)? */
export function strokeHitsCircle(stroke: Stroke, center: Point, radius: number): boolean {
  const reach = radius + stroke.lineWidth / 2;
  const b = pointsBBox(stroke.points);
  if (
    center.x < b.minX - reach ||
    center.x > b.maxX + reach ||
    center.y < b.minY - reach ||
    center.y > b.maxY + reach
  ) {
    return false;
  }
  const pts = stroke.points;
  if (pts.length === 1) return Math.hypot(center.x - pts[0].x, center.y - pts[0].y) <= reach;
  for (let i = 1; i < pts.length; i++) {
    if (distToSegment(center, pts[i - 1], pts[i]) <= reach) return true;
  }
  return false;
}

/** Stroke eraser: drop every stroke touched by the circle. Returns the same array if nothing was hit. */
export function eraseStrokesAt(
  strokes: readonly Stroke[],
  center: Point,
  radius: number,
): readonly Stroke[] {
  let hit = false;
  const kept = strokes.filter((s) => {
    const h = strokeHitsCircle(s, center, radius);
    if (h) hit = true;
    return !h;
  });
  return hit ? kept : strokes;
}

/** Insert points so that no two consecutive points are further apart than maxGap. */
export function densify(points: readonly Point[], maxGap: number): Point[] {
  if (points.length < 2 || maxGap <= 0) return [...points];
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.ceil(d / maxGap);
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const q: Point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      if (a.p !== undefined && b.p !== undefined) q.p = a.p + (b.p - a.p) * t;
      out.push(q);
    }
    out.push(b);
  }
  return out;
}

function pathLength(points: readonly Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return len;
}

/**
 * Pixel eraser: cut out the part of each stroke inside the circle. Untouched strokes keep the same object
 * (so the recognition cache stays valid), and the same array is returned if nothing changed.
 */
export function erasePartAt(
  strokes: readonly Stroke[],
  center: Point,
  radius: number,
  newId: () => number,
): readonly Stroke[] {
  let changed = false;
  const out: Stroke[] = [];

  for (const stroke of strokes) {
    if (!strokeHitsCircle(stroke, center, radius)) {
      out.push(stroke);
      continue;
    }
    changed = true;
    const cut = radius + stroke.lineWidth / 2;
    // 1px sampling keeps the cut within a pixel of the eraser's edge, however sparse the input was
    const dense = densify(stroke.points, 1);
    let run: Point[] = [];
    const flush = (): void => {
      // discard crumbs shorter than the pen is wide: they would render as specks
      if (run.length >= 2 && pathLength(run) >= stroke.lineWidth) {
        // pieces keep the colour of the stroke they were cut from
        out.push({ id: newId(), points: run, lineWidth: stroke.lineWidth, ...(stroke.color ? { color: stroke.color } : {}) });
      }
      run = [];
    };
    for (const p of dense) {
      if (Math.hypot(p.x - center.x, p.y - center.y) > cut) run.push(p);
      else flush();
    }
    flush();
  }
  return changed ? out : strokes;
}

// Grouping strokes into lines

const MIN_GLYPH_HEIGHT = 6; // ignore dots/dashes when estimating glyph size
const FALLBACK_GLYPH_HEIGHT = 24;
const MIN_PAD = 6;

/** Stable identity of a stroke set. */
export function lineSignature(strokes: readonly Stroke[]): string {
  return strokes
    .map((s) => s.id)
    .sort((a, b) => a - b)
    .join(',');
}

/** Typical height of a written character on the surface (ignores dots and tall brackets). */
export function medianGlyphHeight(strokes: readonly Stroke[]): number {
  const heights = strokes.map((s) => rectHeight(pointsBBox(s.points))).filter((h) => h >= MIN_GLYPH_HEIGHT);
  return heights.length ? median(heights) : FALLBACK_GLYPH_HEIGHT;
}

/** Answer size: 75th percentile of stroke heights (dots and "=" bars would pull the median down). */
export function answerGlyphHeight(strokes: readonly Stroke[]): number {
  const heights = strokes
    .map((s) => rectHeight(pointsBBox(s.points)))
    .filter((h) => h >= MIN_GLYPH_HEIGHT)
    .sort((a, b) => a - b);
  if (heights.length === 0) return FALLBACK_GLYPH_HEIGHT;
  return heights[Math.min(heights.length - 1, Math.floor(heights.length * 0.75))];
}

/**
 * Writing height of a line. Strokes are grouped into glyphs first, since "×", "+" or "8" are several short
 * strokes, and only full-height glyphs are used.
 */
export function writingHeight(strokes: readonly Stroke[]): number {
  if (strokes.length === 0) return FALLBACK_GLYPH_HEIGHT;
  const boxes = strokes.map((s) => pointsBBox(s.points)).sort((a, b) => a.minX - b.minX);
  const glyphs: Rect[] = [];
  for (const b of boxes) {
    const last = glyphs[glyphs.length - 1];
    if (last) {
      const overlap = Math.min(last.maxX, b.maxX) - Math.max(last.minX, b.minX);
      const narrower = Math.max(1, Math.min(rectWidth(last), rectWidth(b)));
      if (overlap > narrower * 0.3) {
        glyphs[glyphs.length - 1] = unionRect(last, b);
        continue;
      }
    }
    glyphs.push(b);
  }
  const heights = glyphs.map(rectHeight).filter((h) => h >= MIN_GLYPH_HEIGHT);
  if (heights.length === 0) return FALLBACK_GLYPH_HEIGHT;
  const tallest = Math.max(...heights);
  // only full-height glyphs (digits, brackets) count: "x", "+", "×" and "²" are naturally shorter
  return median(heights.filter((h) => h >= tallest * 0.7));
}

// Column arithmetic: numbers stacked in rows with a line drawn under

function strokePathLength(points: readonly Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return len;
}

/** A stroke that is a straight line (points close to the chord) with a gentle slope. */
function isStraightRule(points: readonly Point[], width: number): boolean {
  const a = points[0];
  const b = points[points.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1 || Math.abs(dy) > Math.abs(dx) * 0.25) return false;
  let worst = 0;
  for (const p of points) worst = Math.max(worst, Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len);
  return worst <= Math.max(6, width * 0.06);
}

/**
 * The ruled line under a column of numbers: long, straight and flat, with ink stacked above it, nothing next to
 * it on the same row (that would be a minus) and nothing right under it (that would be a fraction bar).
 */
export function findRules(strokes: readonly Stroke[]): Stroke[] {
  if (strokes.length < 3) return [];
  const glyph = medianGlyphHeight(strokes);
  const boxes = strokes.map((s) => pointsBBox(s.points));
  const rules: Stroke[] = [];
  strokes.forEach((s, i) => {
    const b = boxes[i];
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    if (w < Math.max(50, glyph * 1.6)) return;
    // straight and roughly horizontal: a hand-ruled line on a phone is often a little tilted (up to about 14 degrees)
    if (!isStraightRule(s.points, w) || h > Math.max(8, w * 0.3)) return;
    if (strokePathLength(s.points) > w * 1.35) return; // a scribble, not a ruled line
    const cy = (b.minY + b.maxY) / 2;
    let above = 0;
    for (let j = 0; j < strokes.length; j++) {
      if (j === i) continue;
      const o = boxes[j];
      const overlapsX = o.maxX > b.minX - glyph * 0.6 && o.minX < b.maxX + glyph * 0.3;
      if (!overlapsX) {
        // beside it on its own row: this is a minus sign or a bar inside an expression
        const sameRow = o.maxY > cy - glyph * 0.35 && o.minY < cy + glyph * 0.35;
        if (sameRow && (o.maxX > b.minX - glyph * 1.2 && o.minX < b.maxX + glyph * 1.2)) return;
        continue;
      }
      if (o.minY > b.maxY - 2 && o.minY < b.maxY + glyph * 0.9) return; // right below: a fraction bar
      if (o.maxY <= b.minY + glyph * 0.35 && o.maxY >= b.minY - glyph * 1.8) above++;
      else if (o.maxY > cy - glyph * 0.35 && o.minY < cy + glyph * 0.35) return; // crossed by other ink
    }
    if (above >= 2) rules.push(s);
  });
  return rules;
}

/** Where the rows of a column are written: right above the rule, a little wider than it. */
export function columnZone(rule: Stroke, glyph: number): Rect {
  const b = pointsBBox(rule.points);
  return { minX: b.minX - glyph * 1.4, minY: b.minY - glyph * 9, maxX: b.maxX + glyph * 0.6, maxY: b.minY + glyph * 0.4 };
}

const insideRect = (box: Rect, z: Rect): boolean => box.minX >= z.minX && box.maxX <= z.maxX && box.minY >= z.minY && box.maxY <= z.maxY;

/**
 * Group strokes into lines by vertical overlap (each stroke padded by part of a glyph height, then merged), so
 * superscripts, fraction bars and "=" stay with their line. Lines come out top to bottom.
 */
export function groupIntoLines(strokes: readonly Stroke[]): Line[] {
  if (strokes.length === 0) return [];
  // column arithmetic: the rule is never read, and the rows stacked right above it are split with a tight gap
  // (stacked rows are written much closer together than separate lines)
  const rules = findRules(strokes);
  if (rules.length === 0) return groupRows(strokes, 0.25);
  const glyph = medianGlyphHeight(strokes);
  const ruleSet = new Set(rules);
  const claimed = new Set<Stroke>();
  const stacked: Line[] = [];
  for (const rule of rules) {
    const zone = columnZone(rule, glyph);
    const inZone = strokes.filter((st) => !ruleSet.has(st) && !claimed.has(st) && insideRect(pointsBBox(st.points), zone));
    for (const row of columnStack(groupRows(inZone, 0.04, glyph), pointsBBox(rule.points).minY, glyph)) {
      stacked.push(row);
      for (const st of row.strokes) claimed.add(st);
    }
  }
  const rest = strokes.filter((st) => !ruleSet.has(st) && !claimed.has(st));
  const lines = [...groupRows(rest, 0.25), ...stacked];
  return lines.sort((a, b) => a.bbox.minY - b.bbox.minY || a.bbox.minX - b.bbox.minX);
}

/** Rows of a column, walking up from the rule; a short piece (an "=" bar) ends the stack. */
function columnStack(rows: readonly Line[], ruleTop: number, glyph: number): Line[] {
  const out: Line[] = [];
  let edge = ruleTop;
  for (const row of [...rows].sort((a, b) => b.bbox.maxY - a.bbox.maxY)) {
    if (edge - row.bbox.maxY > glyph * (out.length === 0 ? 1.6 : 1.3)) break;
    if (row.bbox.maxY - row.bbox.minY < glyph * 0.45) break;
    out.push(row);
    edge = Math.min(edge, row.bbox.minY);
  }
  return out;
}

/** Interval-merge strokes into rows, padding each stroke vertically by `padGlyphs` × the glyph height. */
function groupRows(strokes: readonly Stroke[], padGlyphs: number, glyphHint?: number): Line[] {
  if (strokes.length === 0) return [];
  const pad = Math.max(padGlyphs >= 0.2 ? MIN_PAD : 1, (glyphHint ?? medianGlyphHeight(strokes)) * padGlyphs);
  const items = strokes.map((stroke, order) => {
    const box = pointsBBox(stroke.points);
    return { stroke, order, box, top: box.minY - pad, bottom: box.maxY + pad };
  });
  items.sort((a, b) => a.top - b.top);

  const clusters: Array<{ bottom: number; members: typeof items }> = [];
  for (const item of items) {
    const current = clusters[clusters.length - 1];
    if (current && item.top <= current.bottom) {
      current.members.push(item);
      current.bottom = Math.max(current.bottom, item.bottom);
    } else {
      clusters.push({ bottom: item.bottom, members: [item] });
    }
  }

  // Two calculations written side by side on the same row ("2+3=      4×5=") are separate lines: split a row
  // wherever the horizontal gap between ink is much wider than a character.
  const gap = Math.max(MIN_COLUMN_GAP, medianGlyphHeight(strokes) * COLUMN_GAP_GLYPHS);
  const rows = clusters.flatMap(({ members }) => {
    const byX = [...members].sort((a, b) => a.box.minX - b.box.minX);
    const parts: Array<typeof items> = [];
    let right = -Infinity;
    for (const m of byX) {
      if (parts.length === 0 || m.box.minX - right > gap) parts.push([]);
      parts[parts.length - 1].push(m);
      right = Math.max(right, m.box.maxX);
    }
    return parts;
  });

  return rows.map((members) => {
    members.sort((a, b) => a.order - b.order);
    const ordered = members.map((m) => m.stroke);
    let bbox = strokeBBox(ordered[0]);
    for (let i = 1; i < ordered.length; i++) bbox = unionRect(bbox, strokeBBox(ordered[i]));
    return { id: lineSignature(ordered), strokes: ordered, bbox };
  });
}

/** A horizontal gap wider than this many glyph heights starts a new calculation on the same row. */
export const COLUMN_GAP_GLYPHS = 3;
const MIN_COLUMN_GAP = 60;

/** True when every stroke is a speck (accidental tap): not worth recognising. */
export function isTrivialLine(line: Line, minExtent = 6): boolean {
  return line.strokes.every((s) => {
    const b = pointsBBox(s.points);
    return Math.max(rectWidth(b), rectHeight(b)) < minExtent;
  });
}

// Answer placement

export interface AnswerPlacement {
  /** left edge of the answer text */
  x: number;
  /** vertical centre of the answer text */
  y: number;
  /** suggested font size in CSS px */
  fontSize: number;
}

/** Answer position: right of the final "=", vertically centred on it. */
export function answerPlacement(line: Line, glyphHeight: number): AnswerPlacement {
  const fontSize = Math.min(120, Math.max(20, glyphHeight * 0.95));
  // The last-drawn stroke on the line is the second bar of "=" (or the pen lift that ended it).
  // The vertical centre of the right-most strokes keeps the answer level with "=".
  const rightMost = [...line.strokes].sort((a, b) => strokeBBox(b).maxX - strokeBBox(a).maxX)[0];
  const rb = strokeBBox(rightMost);
  const nearEdge = line.strokes.filter((s) => strokeBBox(s).maxX >= rb.maxX - glyphHeight * 0.6);
  const ys = nearEdge.map((s) => {
    const b = strokeBBox(s);
    return (b.minY + b.maxY) / 2;
  });
  return { x: line.bbox.maxX + Math.max(12, glyphHeight * 0.35), y: median(ys), fontSize };
}
