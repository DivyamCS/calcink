// Strokes are drawn as quadratic curves through the midpoints of the samples.
import type { Point, Stroke } from './types.ts';

const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function applyPenStyle(ctx: CanvasRenderingContext2D, color: string, width: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

/** Add the smoothed path of `points` to the current path of ctx. */
export function traceStroke(ctx: CanvasRenderingContext2D, points: readonly Point[]): void {
  const n = points.length;
  if (n === 0) return;
  ctx.moveTo(points[0].x, points[0].y);
  if (n === 1) {
    ctx.lineTo(points[0].x, points[0].y); // zero-length + round cap = a dot
    return;
  }
  if (n === 2) {
    ctx.lineTo(points[1].x, points[1].y);
    return;
  }
  const first = mid(points[0], points[1]);
  ctx.lineTo(first.x, first.y);
  for (let i = 1; i < n - 1; i++) {
    const m = mid(points[i], points[i + 1]);
    ctx.quadraticCurveTo(points[i].x, points[i].y, m.x, m.y);
  }
  ctx.lineTo(points[n - 1].x, points[n - 1].y);
}

/** Width at a sample: scaled by stylus pressure (0.5 = normal), constant without pressure data. */
export function pressureWidth(lineWidth: number, p: number | undefined): number {
  if (p === undefined) return lineWidth;
  return lineWidth * (0.55 + 0.9 * Math.min(1, Math.max(0, p)));
}

const hasPressure = (points: readonly Point[]): boolean => points.some((q) => q.p !== undefined);

/** One piece of the smoothed path, stroked with its own width (variable-width strokes). */
function piece(ctx: CanvasRenderingContext2D, width: number, draw: () => void): void {
  ctx.lineWidth = width;
  ctx.beginPath();
  draw();
  ctx.stroke();
}

export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, color: string): void {
  applyPenStyle(ctx, color, stroke.lineWidth);
  const pts = stroke.points;
  if (!hasPressure(pts)) {
    ctx.beginPath();
    traceStroke(ctx, pts);
    ctx.stroke();
    return;
  }
  // the same pieces IncrementalStroke paints live, so committing / redrawing never changes the picture
  const w = (q: Point): number => pressureWidth(stroke.lineWidth, q.p);
  const n = pts.length;
  if (n === 1) return piece(ctx, w(pts[0]), () => (ctx.moveTo(pts[0].x, pts[0].y), ctx.lineTo(pts[0].x, pts[0].y)));
  let cursor = mid(pts[0], pts[1]);
  piece(ctx, w(pts[0]), () => (ctx.moveTo(pts[0].x, pts[0].y), ctx.lineTo(cursor.x, cursor.y)));
  for (let i = 1; i < n - 1; i++) {
    const from = cursor;
    const m = mid(pts[i], pts[i + 1]);
    piece(ctx, w(pts[i]), () => (ctx.moveTo(from.x, from.y), ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y)));
    cursor = m;
  }
  const last = pts[n - 1];
  piece(ctx, w(last), () => (ctx.moveTo(cursor.x, cursor.y), ctx.lineTo(last.x, last.y)));
}

/** Draws a stroke segment by segment as samples arrive (cost per sample is O(1)). */
export class IncrementalStroke {
  readonly points: Point[] = [];
  readonly lineWidth: number;
  private cursor: Point | null = null;
  private readonly ctx: CanvasRenderingContext2D;
  readonly color: string;

  constructor(ctx: CanvasRenderingContext2D, color: string, lineWidth: number) {
    this.ctx = ctx;
    this.color = color;
    this.lineWidth = lineWidth;
  }

  /** Add the first/next sample and paint whatever became final. */
  add(p: Point): void {
    const pts = this.points;
    pts.push(p);
    const n = pts.length;
    const ctx = this.ctx;
    // width of this piece = pressure at its control point (constant when there is no pressure data)
    applyPenStyle(ctx, this.color, pressureWidth(this.lineWidth, (n >= 3 ? pts[n - 2] : pts[0]).p));
    ctx.beginPath();

    if (n === 1) {
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x, p.y); // instant dot under the pen
      this.cursor = p;
    } else if (n === 2) {
      const m = mid(pts[0], pts[1]);
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(m.x, m.y);
      this.cursor = m;
    } else {
      const cur = this.cursor as Point;
      const m = mid(pts[n - 2], pts[n - 1]);
      ctx.moveTo(cur.x, cur.y);
      ctx.quadraticCurveTo(pts[n - 2].x, pts[n - 2].y, m.x, m.y);
      this.cursor = m;
    }
    ctx.stroke();
  }

  /** Paint the final tail (the path ends exactly on the last sample). */
  finish(): void {
    const pts = this.points;
    if (pts.length < 2 || !this.cursor) return;
    const last = pts[pts.length - 1];
    applyPenStyle(this.ctx, this.color, pressureWidth(this.lineWidth, last.p));
    this.ctx.beginPath();
    this.ctx.moveTo(this.cursor.x, this.cursor.y);
    this.ctx.lineTo(last.x, last.y);
    this.ctx.stroke();
  }
}
