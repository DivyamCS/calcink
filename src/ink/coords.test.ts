import { describe, expect, it } from 'vitest';
import {
  MAX_DPR,
  backingStoreSize,
  clampToSize,
  clientToCss,
  cssToDevice,
  deviceToCss,
  normalizeDpr,
} from './coords.ts';

describe('normalizeDpr', () => {
  it('passes sensible values through', () => {
    expect(normalizeDpr(1)).toBe(1);
    expect(normalizeDpr(2)).toBe(2);
    expect(normalizeDpr(1.25)).toBe(1.25);
  });
  it('falls back to 1 for junk', () => {
    expect(normalizeDpr(0)).toBe(1);
    expect(normalizeDpr(-2)).toBe(1);
    expect(normalizeDpr(NaN)).toBe(1);
    expect(normalizeDpr(Infinity)).toBe(1);
    expect(normalizeDpr(undefined)).toBe(1);
    expect(normalizeDpr(null)).toBe(1);
  });
  it('never goes below 1 (no blurry downsampled backing store)', () => {
    expect(normalizeDpr(0.5)).toBe(1);
  });
  it('is capped to a sane maximum', () => {
    expect(normalizeDpr(10)).toBe(MAX_DPR);
  });
});

describe('backingStoreSize (Retina / HiDPI)', () => {
  it('equals the CSS size at 1x', () => {
    expect(backingStoreSize({ width: 800, height: 600 }, 1)).toEqual({ width: 800, height: 600 });
  });
  it('doubles at 2x (Retina)', () => {
    expect(backingStoreSize({ width: 800, height: 600 }, 2)).toEqual({ width: 1600, height: 1200 });
  });
  it('rounds fractional device pixels (125% / 150% Windows scaling)', () => {
    expect(backingStoreSize({ width: 801, height: 601 }, 1.25)).toEqual({ width: 1001, height: 751 });
    expect(backingStoreSize({ width: 333, height: 333 }, 1.5)).toEqual({ width: 500, height: 500 });
  });
  it('never returns a zero-sized canvas', () => {
    expect(backingStoreSize({ width: 0, height: 0 }, 2)).toEqual({ width: 1, height: 1 });
  });
});

describe('clientToCss (pointer -> canvas CSS px)', () => {
  const rect = { left: 100, top: 50, width: 800, height: 600 };

  it('subtracts the element offset', () => {
    expect(clientToCss(100, 50, rect)).toEqual({ x: 0, y: 0 });
    expect(clientToCss(300, 250, rect)).toEqual({ x: 200, y: 200 });
  });
  it('allows points outside the element (pointer capture keeps tracking)', () => {
    expect(clientToCss(50, 20, rect)).toEqual({ x: -50, y: -30 });
  });
  it('corrects for a CSS-scaled element (rect larger than layout size)', () => {
    const scaled = { left: 0, top: 0, width: 1600, height: 1200 }; // transform: scale(2)
    expect(clientToCss(800, 600, scaled, { width: 800, height: 600 })).toEqual({ x: 400, y: 300 });
  });
  it('corrects for a shrunken element', () => {
    const scaled = { left: 10, top: 10, width: 400, height: 300 }; // transform: scale(0.5)
    expect(clientToCss(210, 160, scaled, { width: 800, height: 600 })).toEqual({ x: 400, y: 300 });
  });
  it('does not divide by zero for a collapsed element', () => {
    const p = clientToCss(5, 5, { left: 0, top: 0, width: 0, height: 0 }, { width: 100, height: 100 });
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });
});

describe('css <-> device conversions', () => {
  it('scales by the device pixel ratio', () => {
    expect(cssToDevice({ x: 10, y: 20 }, 2)).toEqual({ x: 20, y: 40 });
    expect(deviceToCss({ x: 20, y: 40 }, 2)).toEqual({ x: 10, y: 20 });
  });
  it('round-trips', () => {
    const p = { x: 123.456, y: 78.9 };
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      const back = deviceToCss(cssToDevice(p, dpr), dpr);
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });
  it('treats an invalid ratio as 1', () => {
    expect(cssToDevice({ x: 5, y: 5 }, NaN)).toEqual({ x: 5, y: 5 });
  });
});

describe('clampToSize', () => {
  it('keeps points on the surface', () => {
    const size = { width: 100, height: 50 };
    expect(clampToSize({ x: -5, y: 70 }, size)).toEqual({ x: 0, y: 50 });
    expect(clampToSize({ x: 30, y: 20 }, size)).toEqual({ x: 30, y: 20 });
  });
});
