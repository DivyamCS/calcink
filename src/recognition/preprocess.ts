// Image preparation follows ink-on's preprocessing (Apache-2.0), see NOTICE.md.

/**
 * Stroke -> tensor pipeline (the bridge between the canvas and the neural network).
 */

export interface PreprocessPoint {
  x: number;
  y: number;
}
export interface PreprocessStroke {
  points: readonly PreprocessPoint[];
  lineWidth: number;
}

export interface PreprocessResult {
  tensor: Float32Array;
  height: number;
  width: number;
  mask: Uint8Array;
  maskHeight: number;
  maskWidth: number;
}

/** Anything with a 2D context: OffscreenCanvas in the worker, HTMLCanvasElement on the main thread. */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: '2d', options?: { willReadFrequently?: boolean }): unknown;
}
export type CanvasFactory = (width: number, height: number) => CanvasLike;

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export const MODEL_H = 256;
export const TARGET_H = 128;
export const MAX_W = 1024;
export const MIN_W = 128;
export const W_ALIGN = 64;
export const PAD = 16;
export const RESAMPLE_PX = 3;
/** Lines taller than this (px) are scaled down first. Very big writing was misread otherwise. */
export const NORMAL_INK_H = 110;
/** Stroke width in the final model image (px at 128 px line height). Picked with the browser accuracy probe. */
export const TARGET_STROKE_PX = 5;

export interface PreprocessOptions {
  /** true (default): normalise the stroke width (see above). false: ink-on's original recipe (parity test only). */
  normalizeWidth?: boolean;
  /** scale lines taller than NORMAL_INK_H down to it before rasterising (default true; the parity test turns it off) */
  normalizeSize?: boolean;
}

/** Width to draw with on the raw canvas so it ends up TARGET_STROKE_PX wide after scaling by `scale`. */
export function rasterLineWidth(scale: number, target = TARGET_STROKE_PX): number {
  return scale > 0 && Number.isFinite(scale) ? Math.max(1, target / scale) : target;
}

/** Re-sample a polyline every `interval` px (keeps first and last point). */
export function resamplePoints(points: readonly PreprocessPoint[], interval = RESAMPLE_PX): PreprocessPoint[] {
  if (points.length < 2) return [...points];
  const out: PreprocessPoint[] = [points[0]];
  let remaining = interval;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= remaining) {
      remaining -= dist;
      continue;
    }
    let covered = remaining;
    while (covered <= dist) {
      const t = covered / dist;
      out.push({ x: prev.x + dx * t, y: prev.y + dy * t });
      covered += interval;
    }
    remaining = covered - dist;
  }
  out.push(points[points.length - 1]);
  return out;
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function strokesBBox(strokes: readonly PreprocessStroke[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of strokes) {
    for (const p of s.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { minX, minY, maxX, maxY };
}

/** Geometry of steps 3-4 (pure, unit-tested). */
export function targetLayout(rawW: number, rawH: number): { dw: number; dh: number; canvasW: number } {
  const scale = Math.min(TARGET_H / rawH, MAX_W / rawW);
  const dw = Math.max(1, Math.round(rawW * scale));
  const dh = Math.max(1, Math.round(rawH * scale));
  const canvasW = Math.min(MAX_W, Math.max(MIN_W, Math.ceil((dw + PAD) / W_ALIGN) * W_ALIGN));
  return { dw, dh, canvasW };
}

/** Step 6 (pure, unit-tested). */
export function buildMask(canvasW: number, contentW: number, contentH: number): Uint8Array {
  const mask = new Uint8Array(MODEL_H * canvasW);
  for (let y = 0; y < MODEL_H; y++) {
    const row = y * canvasW;
    for (let x = 0; x < canvasW; x++) mask[row + x] = y < contentH && x < contentW ? 0 : 1;
  }
  return mask;
}

/** Too small / too short to be writing (a tap or a speck): don't spend a model run on it. */
export function isMeaningful(strokes: readonly PreprocessStroke[]): boolean {
  if (strokes.length === 0) return false;
  const b = strokesBBox(strokes);
  if (b.maxX - b.minX < 8 && b.maxY - b.minY < 8) return false;
  let points = 0;
  let length = 0;
  for (const s of strokes) {
    points += s.points.length;
    for (let i = 1; i < s.points.length; i++) {
      length += Math.hypot(s.points[i].x - s.points[i - 1].x, s.points[i].y - s.points[i - 1].y);
    }
  }
  return points >= 6 && length >= 15;
}

function drawStrokes(ctx: Ctx2D, strokes: readonly PreprocessStroke[], box: Box, fixedWidth: number | null): void {
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const ox = PAD - box.minX;
  const oy = PAD - box.minY;
  for (const stroke of strokes) {
    if (stroke.points.length === 0) continue;
    const pts = resamplePoints(stroke.points);
    ctx.beginPath();
    ctx.lineWidth = fixedWidth ?? Math.max(2, stroke.lineWidth);
    ctx.moveTo(pts[0].x + ox, pts[0].y + oy);
    if (pts.length === 2) {
      ctx.lineTo(pts[1].x + ox, pts[1].y + oy);
    } else if (pts.length > 2) {
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2 + ox;
        const my = (pts[i].y + pts[i + 1].y) / 2 + oy;
        ctx.quadraticCurveTo(pts[i].x + ox, pts[i].y + oy, mx, my);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last.x + ox, last.y + oy);
    }
    ctx.stroke();
  }
}

/** Scale a line's strokes down so its ink is at most NORMAL_INK_H tall (aspect kept). Smaller writing is unchanged. Pure. */
export function normalizeSize(strokes: readonly PreprocessStroke[], cap = NORMAL_INK_H): PreprocessStroke[] {
  const box = strokesBBox(strokes);
  const h = box.maxY - box.minY;
  if (h <= cap) return strokes as PreprocessStroke[];
  const k = cap / h;
  return strokes.map((st) => ({ ...st, points: st.points.map((p) => ({ ...p, x: (p.x - box.minX) * k, y: (p.y - box.minY) * k })) }));
}

/** Full pipeline. `makeCanvas` decides where it runs (OffscreenCanvas in the worker). */
export function preprocessStrokes(
  strokes: readonly PreprocessStroke[],
  makeCanvas: CanvasFactory,
  opts: PreprocessOptions = {},
): PreprocessResult {
  if (opts.normalizeSize !== false) strokes = normalizeSize(strokes);
  const box = strokesBBox(strokes);
  const rawW = Math.max(1, Math.ceil(box.maxX - box.minX)) + PAD * 2;
  const rawH = Math.max(1, Math.ceil(box.maxY - box.minY)) + PAD * 2;

  const raw = makeCanvas(rawW, rawH);
  const rctx = raw.getContext('2d') as Ctx2D;
  rctx.fillStyle = '#000000';
  rctx.fillRect(0, 0, rawW, rawH);
  const { dw, dh, canvasW } = targetLayout(rawW, rawH);
  const scale = Math.min(TARGET_H / rawH, MAX_W / rawW);
  drawStrokes(rctx, strokes, box, opts.normalizeWidth === false ? null : rasterLineWidth(scale));

  const target = makeCanvas(canvasW, MODEL_H);
  const tctx = target.getContext('2d', { willReadFrequently: true }) as Ctx2D;
  tctx.fillStyle = '#000000';
  tctx.fillRect(0, 0, canvasW, MODEL_H);
  tctx.drawImage(raw as unknown as CanvasImageSource, 0, 0, dw, dh);

  const { data } = tctx.getImageData(0, 0, canvasW, MODEL_H);
  const pixels = canvasW * MODEL_H;
  const tensor = new Float32Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    tensor[i] = (data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114) / 255;
  }
  return { tensor, height: MODEL_H, width: canvasW, mask: buildMask(canvasW, dw, dh), maskHeight: MODEL_H, maskWidth: canvasW };
}
