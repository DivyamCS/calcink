export interface Pt {
  x: number;
  y: number;
}

export interface Viewport {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface Mark {
  x: number;
  y: number;
  kind: 'root' | 'turning' | 'intercept' | 'solution';
}

export interface Curve {
  /** continuous pieces (a gap or asymptote starts a new piece) */
  segments: Pt[][];
  /** 0 = main colour, 1 = second colour (the right-hand side of an x-only equation) */
  tone: 0 | 1;
}

export interface Graph {
  view: Viewport;
  curves: Curve[];
  marks: Mark[];
  /** draw with equal units on both axes (implicit curves: a circle must look round) */
  equalAspect: boolean;
}

/** A real function of one variable; may return NaN or ±Infinity, may never throw. */
export type F1 = (x: number) => number;
/** A real function of two variables; same rules. */
export type F2 = (x: number, y: number) => number;

const safe1 = (f: F1): F1 => (x) => {
  try {
    const v = f(x);
    return typeof v === 'number' ? v : NaN;
  } catch {
    return NaN;
  }
};
const safe2 = (f: F2): F2 => (x, y) => {
  try {
    const v = f(x, y);
    return typeof v === 'number' ? v : NaN;
  } catch {
    return NaN;
  }
};

// Axis ticks

/** "Nice" step (1, 2 or 5 × 10^k) giving about `target` intervals over [min, max]. */
export function niceStep(min: number, max: number, target = 6): number {
  const span = Math.abs(max - min);
  if (!(span > 0) || !Number.isFinite(span)) return 1;
  const raw = span / Math.max(1, target);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * pow;
}

/** Tick positions inside [min, max] at a nice step (0 is always a tick when in range). */
export function niceTicks(min: number, max: number, target = 6): number[] {
  const step = niceStep(min, max, target);
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
    if (out.length > 200) break;
  }
  return out;
}

/** Short tick label: 0, 2.5, -10, 1e4, 0.001 */
export function tickLabel(v: number): string {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) return v.toExponential(0).replace('e+', 'e');
  return String(Number(v.toPrecision(4))).replace('-', '−');
}

// Helpers

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

function linspace(a: number, b: number, n: number): number[] {
  return Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
}

/** Find x in [a, b] with f(x) = 0 by bisection, given a sign change. */
export function bisect(f: F1, a: number, b: number, iterations = 60): number {
  let fa = f(a);
  for (let i = 0; i < iterations; i++) {
    const m = (a + b) / 2;
    const fm = f(m);
    if (fm === 0 || !Number.isFinite(fm)) return m;
    if (Math.sign(fm) === Math.sign(fa)) {
      a = m;
      fa = fm;
    } else b = m;
  }
  return (a + b) / 2;
}

/** below this a value is floating-point underflow (e^-800 is exactly 0), not a meaningful zero */
const UNDERFLOW = 1e-250;

/** The x in [a, b] where |f| is smallest (golden-section search; |f| is unimodal there). */
function minimizeAbs(f: F1, a: number, b: number): number {
  const k = (Math.sqrt(5) - 1) / 2;
  let c = b - k * (b - a);
  let d = a + k * (b - a);
  for (let i = 0; i < 90; i++) {
    if (Math.abs(f(c)) < Math.abs(f(d))) b = d;
    else a = c;
    c = b - k * (b - a);
    d = a + k * (b - a);
  }
  return (a + b) / 2;
}

/**
 * Zeros of f on [a, b]: sign changes refined by bisection, skipping poles (|f| large) and underflow,
 * plus touching roots like (3x - 1)² = 0 found as dips of |f| to 0.
 */
export function findZeros(f: F1, a: number, b: number, samples = 2000): number[] {
  const g = safe1(f);
  const xs = linspace(a, b, samples);
  const ys = xs.map(g);
  const zeros: number[] = [];
  const h = (b - a) / samples;
  for (let i = 0; i < samples; i++) {
    const y0 = ys[i];
    const y1 = ys[i + 1];
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) continue;
    if (y0 === 0) {
      const around = [ys[i - 1], ys[i + 1]].filter((v): v is number => v !== undefined && Number.isFinite(v));
      // also look just next to it: with coarse samples (e^x near -750) the neighbours can be far away
      const e = h * 1e-3;
      const near = Math.abs(g(xs[i] - e)) >= UNDERFLOW || Math.abs(g(xs[i] + e)) >= UNDERFLOW;
      if (near && around.some((v) => Math.abs(v) >= UNDERFLOW)) zeros.push(xs[i]);
      continue;
    }
    if (Math.sign(y0) === Math.sign(y1) || y1 === 0) continue;
    const r = bisect(g, xs[i], xs[i + 1]);
    const yr = g(r);
    // a real zero: f is small at the refined point compared with the samples around it
    if (Number.isFinite(yr) && Math.abs(yr) <= 1e-6 * Math.max(1, Math.abs(y0), Math.abs(y1)) + 1e-9) zeros.push(r);
  }
  if (ys[samples] === 0 && Math.abs(ys[samples - 1]) >= UNDERFLOW) zeros.push(b);
  // f touches 0 without crossing it: a local minimum of |f| between samples of the same sign
  for (let i = 1; i < samples; i++) {
    const l = ys[i - 1];
    const m = ys[i];
    const r = ys[i + 1];
    if (!Number.isFinite(l) || !Number.isFinite(m) || !Number.isFinite(r) || m === 0) continue;
    if (Math.sign(l) !== Math.sign(m) || Math.sign(r) !== Math.sign(m)) continue;
    if (Math.abs(m) > Math.abs(l) || Math.abs(m) > Math.abs(r)) continue;
    const scale = Math.max(Math.abs(l), Math.abs(r));
    if (scale < UNDERFLOW) continue;
    const x = minimizeAbs(g, xs[i - 1], xs[i + 1]);
    const v = Math.abs(g(x));
    // a true touch: |f| at the bottom is negligible next to how much f rises a small step away. Independent of
    // the sampling step, so x² + 1e-12 (bottom 1e-12, rise 1e-8) is no root however coarse the search
    const d = 1e-4 * Math.max(1, Math.abs(x));
    const rise = Math.min(Math.abs(g(x - d)), Math.abs(g(x + d))) - v;
    if (Number.isFinite(v) && rise > 0 && v < rise * 1e-6) zeros.push(x);
  }
  zeros.sort((p, q) => p - q);
  // merge zeros closer than two samples (a double root sampled on both sides)
  const merged: number[] = [];
  for (const z of zeros) if (!merged.length || z - merged[merged.length - 1] > 2 * h) merged.push(z);
  return merged;
}

/** Round a solution for display: exact-looking numbers become exact (2.9999999999 -> 3). */
export function cleanNumber(v: number): number {
  const r = Math.round(v);
  if (Math.abs(v - r) < 1e-7 * Math.max(1, Math.abs(v))) return r;
  return Number(v.toPrecision(10));
}

// y = f(x)

/** Interesting x positions of f: roots, turning points, y-intercept, poles (searching wider if nothing is near 0). */
export function features(f: F1): Mark[] {
  const g = safe1(f);
  const marks: Mark[] = [];
  const near = 10;
  for (const x of findZeros(g, -near, near)) marks.push({ x, y: 0, kind: 'root' });

  // turning points: sign changes of the slope on a fine grid (ignoring poles and flat stretches)
  const n = 2000;
  const xs = linspace(-near, near, n);
  const ys = xs.map(g);
  for (let i = 1; i < n; i++) {
    const a = ys[i - 1];
    const b = ys[i];
    const c = ys[i + 1];
    if (![a, b, c].every(Number.isFinite)) continue;
    const d1 = b - a;
    const d2 = c - b;
    if (d1 === 0 && d2 === 0) continue;
    if ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) {
      const span = Math.max(Math.abs(d1), Math.abs(d2));
      if (span > 1e6) continue; // a pole, not a peak
      marks.push({ x: xs[i], y: b, kind: 'turning' });
    }
  }

  const y0 = g(0);
  if (Number.isFinite(y0)) marks.push({ x: 0, y: y0, kind: 'intercept' });

  // nothing near the origin (e.g. y = x + 100): look further out for a root
  if (!marks.some((m) => m.kind === 'root')) {
    for (const r of [100, 1000, 10000]) {
      const far = findZeros(g, -r, r, 4000);
      if (far.length) {
        const nearest = far.sort((p, q) => Math.abs(p) - Math.abs(q))[0];
        marks.push({ x: nearest, y: 0, kind: 'root' });
        // y = x² - 2500: the root on the other side is as interesting; keep it in view when comparably near
        const other = far.find((z) => Math.sign(z) !== Math.sign(nearest));
        if (other !== undefined && Math.abs(other) <= 3 * Math.abs(nearest)) marks.push({ x: other, y: 0, kind: 'root' });
        break;
      }
    }
  }
  return marks;
}

/** x-window around the interesting points: every feature visible, centred, not absurdly narrow or wide. */
export function frameX(marks: readonly Mark[], minWidth = 8): { xMin: number; xMax: number } {
  if (marks.length === 0) return { xMin: -10, xMax: 10 };
  // with many features (sin x has a root every π) keep the ones nearest the origin
  const xs = marks
    .map((m) => m.x)
    .sort((a, b) => Math.abs(a) - Math.abs(b))
    .slice(0, 12)
    .sort((a, b) => a - b);
  const lo = xs[0];
  const hi = xs[xs.length - 1];
  const span = hi - lo;
  const width = Math.max(minWidth, span * 1.5);
  const mid = (lo + hi) / 2;
  return { xMin: mid - width / 2, xMax: mid + width / 2 };
}

/** y-range of samples: ignores the extreme 3 % (asymptotes), keeps the x-axis when close, padded. */
export function frameY(ys: readonly number[], extra: readonly number[] = []): { yMin: number; yMax: number } {
  const finite = ys.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return { yMin: -5, yMax: 5 };
  let lo = quantile(finite, 0.03);
  let hi = quantile(finite, 0.97);
  for (const e of extra) {
    if (Number.isFinite(e)) {
      lo = Math.min(lo, e);
      hi = Math.max(hi, e);
    }
  }
  if (lo > 0 && lo < (hi - lo) * 0.6) lo = 0;
  if (hi < 0 && -hi < (hi - lo) * 0.6) hi = 0;
  if (hi - lo < 1e-9) {
    const pad = Math.max(1, Math.abs(lo) * 0.5);
    return { yMin: lo - pad, yMax: hi + pad };
  }
  const pad = (hi - lo) * 0.12;
  return { yMin: lo - pad, yMax: hi + pad };
}

/** Split samples into drawable pieces at gaps, jumps and asymptotes. */
function pieces(xs: readonly number[], ys: readonly number[], view: Viewport): Pt[][] {
  const span = view.yMax - view.yMin;
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  for (let i = 0; i < xs.length; i++) {
    const y = ys[i];
    const prev = cur[cur.length - 1];
    const jump = prev !== undefined && Number.isFinite(y) && Math.abs(y - prev.y) > span * 2.5;
    const flip =
      prev !== undefined &&
      Number.isFinite(y) &&
      Math.sign(y - view.yMin - span / 2) !== Math.sign(prev.y - view.yMin - span / 2) &&
      (Math.abs(y) > span * 4 || Math.abs(prev.y) > span * 4);
    if (!Number.isFinite(y) || jump || flip) {
      if (cur.length > 1) out.push(cur);
      cur = Number.isFinite(y) ? [{ x: xs[i], y }] : [];
      continue;
    }
    cur.push({ x: xs[i], y });
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/** The graph card for y = f(x): framed on its roots, turning points and intercept. */
export function graphFunction(f: F1, at?: number): Graph {
  const g = safe1(f);
  const feats = features(g);
  let { xMin, xMax } = frameX(feats);
  // "x = 3" written below "y = x²": the point (3, 9) is marked and kept in view
  const point = at !== undefined && Number.isFinite(at) && Number.isFinite(g(at)) ? { x: at, y: g(at), kind: 'solution' as const } : null;
  if (point && (point.x < xMin || point.x > xMax)) {
    const pad = (Math.max(xMax, point.x) - Math.min(xMin, point.x)) * 0.12;
    xMin = Math.min(xMin, point.x - pad);
    xMax = Math.max(xMax, point.x + pad);
  }
  const xs = linspace(xMin, xMax, 1000);
  const ys = xs.map(g);
  const all = point ? [point, ...feats] : feats;
  const { yMin, yMax } = frameY(ys, all.filter((m) => m.x >= xMin && m.x <= xMax).map((m) => m.y));
  const view = { xMin, xMax, yMin, yMax };
  const marks = dedupeMarks(all.filter((m) => inView(m, view)), view);
  return { view, curves: [{ segments: pieces(xs, ys, view), tone: 0 }], marks, equalAspect: false };
}

const inView = (m: Pt, v: Viewport): boolean => m.x >= v.xMin && m.x <= v.xMax && m.y >= v.yMin && m.y <= v.yMax;

/** At most `max` marks, none closer than ~4 % of the window to another (roots win over turning points). */
function dedupeMarks(marks: readonly Mark[], v: Viewport, max = 6): Mark[] {
  const rank = { solution: 0, root: 1, intercept: 2, turning: 3 } as const;
  const sorted = [...marks].sort((a, b) => rank[a.kind] - rank[b.kind] || Math.abs(a.x) - Math.abs(b.x));
  const out: Mark[] = [];
  const dx = (v.xMax - v.xMin) * 0.04;
  const dy = (v.yMax - v.yMin) * 0.04;
  for (const m of sorted) {
    if (out.some((o) => Math.abs(o.x - m.x) < dx && Math.abs(o.y - m.y) < dy)) continue;
    out.push(m);
    if (out.length === max) break;
  }
  return out;
}

// L(x) = R(x): both sides, and where they meet

/** Solutions of L(x) = R(x): near the origin first, further out only if there are none. */
export function solveX(left: F1, right: F1): number[] {
  const l = safe1(left);
  const r = safe1(right);
  const d: F1 = (x) => l(x) - r(x);
  for (const range of [10, 100, 1000, 1e4, 1e5, 1e6]) {
    const z = findZeros(d, -range, range, range === 10 ? 4000 : 8000);
    if (z.length) return z.map(cleanNumber);
  }
  return [];
}

/** Graph of an equation in x only: both sides drawn, crossings marked. */
export function graphSides(left: F1, right: F1, solutions: readonly number[]): Graph {
  const l = safe1(left);
  const r = safe1(right);
  const sols: Mark[] = solutions.map((x) => ({ x, y: l(x), kind: 'solution' }));
  const { xMin, xMax } = frameX(sols.length ? sols : [...features(l), ...features(r)]);
  const xs = linspace(xMin, xMax, 1000);
  const yl = xs.map(l);
  const yr = xs.map(r);
  const { yMin, yMax } = frameY([...yl, ...yr], sols.map((s) => s.y));
  const view = { xMin, xMax, yMin, yMax };
  return {
    view,
    curves: [
      { segments: pieces(xs, yl, view), tone: 0 },
      { segments: pieces(xs, yr, view), tone: 1 },
    ],
    marks: dedupeMarks(sols.filter((m) => inView(m, view)), view, 8),
    equalAspect: false,
  };
}

// F(x, y) = 0: marching squares

/** Marching squares over `view`. Crossings next to a pole (|F| not small) are dropped. */
export function contour(F: F2, view: Viewport, nx: number, ny: number): Pt[][] {
  const f = safe2(F);
  const xs = linspace(view.xMin, view.xMax, nx);
  const ys = linspace(view.yMin, view.yMax, ny);
  const v: Float64Array[] = ys.map((y) => Float64Array.from(xs, (x) => f(x, y)));
  const segs: Pt[][] = [];

  const crossing = (x0: number, y0: number, f0: number, x1: number, y1: number, f1: number): Pt | null => {
    if (!Number.isFinite(f0) || !Number.isFinite(f1)) return null;
    if ((f0 > 0) === (f1 > 0)) return null;
    const t = f0 / (f0 - f1);
    const p = { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t };
    const fp = f(p.x, p.y);
    if (!Number.isFinite(fp) || Math.abs(fp) > 0.5 * Math.max(Math.abs(f0), Math.abs(f1))) return null; // a pole
    return p;
  };

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x0 = xs[i];
      const x1 = xs[i + 1];
      const y0 = ys[j];
      const y1 = ys[j + 1];
      const a = v[j][i]; // (x0, y0)
      const b = v[j][i + 1]; // (x1, y0)
      const c = v[j + 1][i + 1]; // (x1, y1)
      const d = v[j + 1][i]; // (x0, y1)
      const pts = [crossing(x0, y0, a, x1, y0, b), crossing(x1, y0, b, x1, y1, c), crossing(x1, y1, c, x0, y1, d), crossing(x0, y1, d, x0, y0, a)].filter(
        (p): p is Pt => p !== null,
      );
      if (pts.length === 2) segs.push(pts);
      else if (pts.length === 4) {
        // saddle: pair the crossings using the value at the centre
        const centre = f((x0 + x1) / 2, (y0 + y1) / 2);
        if ((centre > 0) === (a > 0)) segs.push([pts[0], pts[1]], [pts[2], pts[3]]);
        else segs.push([pts[0], pts[3]], [pts[1], pts[2]]);
      }
    }
  }
  return segs;
}

function boundsOf(segs: readonly Pt[][]): Viewport | null {
  if (!segs.length) return null;
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const s of segs) {
    for (const p of s) {
      xMin = Math.min(xMin, p.x);
      xMax = Math.max(xMax, p.x);
      yMin = Math.min(yMin, p.y);
      yMax = Math.max(yMax, p.y);
    }
  }
  return { xMin, xMax, yMin, yMax };
}

/** A window of the given aspect (height / width) centred on (cx, cy) with half-width hw. */
function windowAt(cx: number, cy: number, hw: number, aspect: number): Viewport {
  return { xMin: cx - hw, xMax: cx + hw, yMin: cy - hw * aspect, yMax: cy + hw * aspect };
}

/** Graph for F(x, y) = 0: starts at ±10, zooms to fit closed curves, equal units on both axes. */
export function graphImplicit(F: F2, aspect = 0.68, resolution = 150): Graph {
  const nx = resolution;
  const ny = Math.max(20, Math.round(resolution * aspect));
  let view = windowAt(0, 0, 10, aspect);
  let segs = contour(F, view, nx, ny);
  for (const hw of [100, 1000]) {
    if (segs.length) break;
    view = windowAt(0, 0, hw, aspect);
    segs = contour(F, view, nx, ny);
  }
  const touches = (bb: Viewport, v: Viewport): boolean => {
    const ex = (v.xMax - v.xMin) / nx;
    const ey = (v.yMax - v.yMin) / ny;
    return bb.xMin <= v.xMin + 1.5 * ex || bb.xMax >= v.xMax - 1.5 * ex || bb.yMin <= v.yMin + 1.5 * ey || bb.yMax >= v.yMax - 1.5 * ey;
  };
  let b = boundsOf(segs);
  let fits = b !== null && !touches(b, view);
  // a closed curve cut off by the edge (a big circle): zoom out until it fits; lines and other unbounded curves
  // always touch the edge, so they keep the window
  if (b && touches(b, view)) {
    for (const hw of [20, 40, 80]) {
      const wide = windowAt(0, 0, Math.max(hw, (view.xMax - view.xMin) / 2), aspect);
      const ws = contour(F, wide, nx, ny);
      const wb = boundsOf(ws);
      if (wb && !touches(wb, wide)) {
        b = wb;
        fits = true;
        break;
      }
    }
  }
  if (b && fits) {
    // the whole curve is visible: frame it snugly (a small circle fills the card, a big one is not clipped)
    const w = b.xMax - b.xMin;
    const h = b.yMax - b.yMin;
    const cx = (b.xMin + b.xMax) / 2;
    const cy = (b.yMin + b.yMax) / 2;
    const hw = Math.max(1, (Math.max(w, h / aspect) / 2) * 1.3);
    view = windowAt(cx, cy, hw, aspect);
    segs = contour(F, view, nx, ny);
  }
  // otherwise the curve is unbounded (a line, x = sin y...): keep ±10, or the wider window it was found in
  return { view, curves: [{ segments: segs, tone: 0 }], marks: [], equalAspect: true };
}
