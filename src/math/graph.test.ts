import { describe, expect, it } from 'vitest';
import {
  cleanNumber,
  contour,
  features,
  findZeros,
  frameX,
  graphFunction,
  graphImplicit,
  graphSides,
  niceStep,
  niceTicks,
  solveX,
  tickLabel,
  type Graph,
} from './graph.ts';

const points = (g: Graph) => g.curves.flatMap((c) => c.segments.flat());

describe('ticks', () => {
  it('uses 1/2/5 steps', () => {
    expect(niceStep(0, 10)).toBe(2);
    expect(niceStep(-4, 4)).toBe(1);
    expect(niceStep(0, 100)).toBe(20);
    expect(niceStep(0, 0.3)).toBeCloseTo(0.05);
  });
  it('includes 0 and stays inside the range', () => {
    const t = niceTicks(-4.3, 7.9);
    expect(t).toContain(0);
    expect(Math.min(...t)).toBeGreaterThanOrEqual(-4.3);
    expect(Math.max(...t)).toBeLessThanOrEqual(7.9);
  });
  it('labels are short', () => {
    expect(tickLabel(0)).toBe('0');
    expect(tickLabel(-2.5)).toBe('−2.5');
    expect(tickLabel(100000)).toBe('1e5');
  });
});

describe('zeros and solving', () => {
  it('finds roots and refines them', () => {
    const z = findZeros((x) => x * x - 4, -10, 10);
    expect(z).toHaveLength(2);
    expect(z[0]).toBeCloseTo(-2, 9);
    expect(z[1]).toBeCloseTo(2, 9);
  });
  it('a pole is not a zero (1/x, tan x)', () => {
    expect(findZeros((x) => 1 / x, -5, 5)).toEqual([]);
    const tanZeros = findZeros(Math.tan, -4, 4);
    for (const z of tanZeros) expect(Math.abs(Math.tan(z))).toBeLessThan(1e-6);
    expect(tanZeros.map((z) => Math.round(z / Math.PI))).toEqual([-1, 0, 1]);
  });
  it('solves linear and transcendental equations', () => {
    expect(solveX((x) => 2 * x + 4, () => 10)).toEqual([3]);
    const s = solveX(Math.sin, (x) => x / 2);
    expect(s).toHaveLength(3);
    expect(s[1]).toBe(0);
    expect(s[2]).toBeCloseTo(1.895494, 5);
  });
  it('looks further out when nothing is near 0', () => {
    expect(solveX((x) => x, () => 250)).toEqual([250]);
  });
  it('no real solution -> empty', () => {
    expect(solveX((x) => x * x, () => -1)).toEqual([]);
  });
  it('cleans numbers that are integers up to noise', () => {
    expect(cleanNumber(2.9999999999)).toBe(3);
    expect(cleanNumber(1.8954942670339807)).toBe(1.895494267);
  });
});

describe('y = f(x) framing', () => {
  it('x² is framed around its vertex with the x-axis in view', () => {
    const g = graphFunction((x) => x * x);
    expect(g.view.xMin).toBeLessThan(0);
    expect(g.view.xMax).toBeGreaterThan(0);
    expect(g.view.yMin).toBeLessThanOrEqual(0);
    expect(g.marks.some((m) => m.kind === 'root' && Math.abs(m.x) < 1e-6)).toBe(true);
  });
  it('a far-away root is still shown (y = x + 100)', () => {
    const g = graphFunction((x) => x + 100);
    expect(g.view.xMin).toBeLessThan(-100);
    expect(g.marks.some((m) => m.kind === 'root' && Math.abs(m.x + 100) < 1e-6)).toBe(true);
  });
  it('turning points are found (x³ - 3x)', () => {
    const t = features((x) => x ** 3 - 3 * x).filter((m) => m.kind === 'turning');
    expect(t.map((m) => Math.round(m.x * 100) / 100).sort()).toEqual([-1, 1]);
  });
  it('1/x: the curve breaks at the asymptote, y-range is not blown up', () => {
    const g = graphFunction((x) => 1 / x);
    expect(g.curves[0].segments.length).toBeGreaterThanOrEqual(2);
    expect(g.view.yMax).toBeLessThan(1000);
  });
  it('sin x shows a few periods', () => {
    const g = graphFunction(Math.sin);
    expect(g.view.xMax - g.view.xMin).toBeGreaterThan(2 * Math.PI);
    expect(g.view.yMax).toBeLessThan(2);
    expect(g.view.yMin).toBeGreaterThan(-2);
  });
  it('a function that is undefined everywhere gives an empty curve, not a crash', () => {
    const g = graphFunction(() => NaN);
    expect(points(g)).toEqual([]);
  });
  it('frameX keeps a minimum width', () => {
    const f = frameX([{ x: 1, y: 0, kind: 'root' }]);
    expect(f.xMax - f.xMin).toBeGreaterThanOrEqual(8);
  });
});

describe('both sides of an x-only equation', () => {
  it('draws two curves and marks the solutions', () => {
    const sols = solveX(Math.sin, (x) => x / 2);
    const g = graphSides(Math.sin, (x) => x / 2, sols);
    expect(g.curves.map((c) => c.tone)).toEqual([0, 1]);
    expect(g.marks).toHaveLength(3);
    for (const m of g.marks) expect(m.kind).toBe('solution');
  });
});

describe('F(x, y) = 0 by marching squares', () => {
  it('circle x² + y² = 25', () => {
    const g = graphImplicit((x, y) => x * x + y * y - 25);
    const pts = points(g);
    expect(pts.length).toBeGreaterThan(50);
    for (const p of pts) expect(Math.hypot(p.x, p.y)).toBeCloseTo(5, 1);
    expect(g.equalAspect).toBe(true);
    expect(g.view.xMax).toBeGreaterThan(5);
    expect(g.view.yMax).toBeGreaterThan(5); // the whole circle is in view
    expect(g.view.yMin).toBeLessThan(-5);
  });
  it('a small circle fills the card; a big one is not clipped', () => {
    const small = graphImplicit((x, y) => x * x + y * y - 1);
    expect(small.view.xMax - small.view.xMin).toBeLessThan(6);
    const big = graphImplicit((x, y) => x * x + y * y - 64);
    expect(big.view.yMax).toBeGreaterThan(8);
    expect(big.view.yMin).toBeLessThan(-8);
    expect(points(big).length).toBeGreaterThan(50);
  });
  it('a straight line keeps the ±10 window', () => {
    const g = graphImplicit((x, y) => x + y - 1);
    expect(g.view.xMin).toBe(-10);
  });
  it('x = sin(y): a curve that is not a function of x', () => {
    const g = graphImplicit((x, y) => x - Math.sin(y));
    const pts = points(g);
    expect(pts.length).toBeGreaterThan(50);
    for (const p of pts) expect(p.x - Math.sin(p.y)).toBeCloseTo(0, 1);
  });
  it('y = tan x: no false segments across the poles', () => {
    const segs = contour((x, y) => y - Math.tan(x), { xMin: -3, xMax: 3, yMin: -5, yMax: 5 }, 120, 80);
    for (const s of segs) for (const p of s) expect(Math.abs(p.y - Math.tan(p.x))).toBeLessThan(0.5);
  });
  it('a far-away curve is found by widening the window', () => {
    const g = graphImplicit((x, y) => (x - 300) ** 2 + y * y - 400);
    expect(points(g).length).toBeGreaterThan(10);
  });
  it('no real points (x² + y² = -1) -> empty, no crash', () => {
    expect(points(graphImplicit((x, y) => x * x + y * y + 1))).toEqual([]);
  });
});

describe('a value of x given below the formula', () => {
  it('y = x² with x = 3: the point (3, 9) is marked and in view', () => {
    const g = graphFunction((x) => x * x, 3);
    const m = g.marks.find((k) => k.kind === 'solution');
    expect(m).toMatchObject({ x: 3, y: 9 });
    expect(g.view.xMax).toBeGreaterThan(3);
    expect(g.view.yMax).toBeGreaterThanOrEqual(9);
  });
  it('a far value (x = 40) widens the window to include it', () => {
    const g = graphFunction((x) => 2 * x + 1, 40);
    expect(g.view.xMax).toBeGreaterThan(40);
    expect(g.marks.some((k) => k.kind === 'solution' && k.x === 40 && k.y === 81)).toBe(true);
  });
  it('a value where f is undefined marks nothing', () => {
    const g = graphFunction((x) => Math.sqrt(x), -4);
    expect(g.marks.some((k) => k.kind === 'solution')).toBe(false);
  });
});

describe('edge cases: double roots, underflow, far roots', () => {
  it('double roots (f touches 0 without crossing) are found', () => {
    const z = solveX((x) => (3 * x - 1) ** 2, () => 0);
    expect(z).toHaveLength(1);
    expect(z[0]).toBeCloseTo(1 / 3, 6);
    expect(solveX((x) => (x - 0.3) ** 2, () => 0)).toEqual([0.3]);
    expect(solveX((x) => 1e6 * (x - 2.5) ** 2, () => 0)).toEqual([2.5]);
  });
  it('no phantom solutions from underflow: e^x = 0 has none', () => {
    expect(solveX(Math.exp, () => 0)).toEqual([]);
    expect(solveX((x) => Math.exp(-x), () => 0)).toEqual([]);
  });
  it('a near miss is not a root: x² + 1e-6 = 0', () => {
    expect(solveX((x) => x * x + 1e-6, () => 0)).toEqual([]);
  });
  it('y = x² − 2500 keeps both roots in view', () => {
    const g = graphFunction((x) => x * x - 2500);
    expect(g.view.xMin).toBeLessThan(-50);
    expect(g.view.xMax).toBeGreaterThan(50);
  });
});
