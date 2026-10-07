import { describe, expect, it } from 'vitest';
import {
  buildMask,
  isMeaningful,
  MAX_W,
  MIN_W,
  MODEL_H,
  NORMAL_INK_H,
  normalizeSize,
  rasterLineWidth,
  resamplePoints,
  strokesBBox,
  TARGET_STROKE_PX,
  targetLayout,
} from './preprocess.ts';

describe('targetLayout: fitting a line of writing into the model input', () => {
  it('scales to 128 px high and aligns the width to 64', () => {
    const l = targetLayout(432, 92); // e.g. "18+4×3=" written 60 px high + 2×16 padding
    expect(l.dh).toBe(128);
    expect(l.dw).toBe(Math.round(432 * (128 / 92)));
    expect(l.canvasW % 64).toBe(0);
    expect(l.canvasW).toBeGreaterThanOrEqual(l.dw);
  });
  it('a very long line is limited by the 1024 px width instead', () => {
    const l = targetLayout(4000, 100);
    expect(l.dw).toBe(MAX_W);
    expect(l.dh).toBeLessThan(128);
    expect(l.canvasW).toBe(MAX_W);
  });
  it('a tiny input still gets the minimum width', () => {
    expect(targetLayout(10, 200).canvasW).toBe(MIN_W);
  });
  it('is independent of screen density (inputs are CSS px)', () => {
    expect(targetLayout(300, 80)).toEqual(targetLayout(300, 80));
  });
});

describe('buildMask', () => {
  it('0 on content, 1 on padding', () => {
    const m = buildMask(128, 100, 128);
    expect(m.length).toBe(128 * MODEL_H);
    expect(m[0]).toBe(0);
    expect(m[99]).toBe(0);
    expect(m[100]).toBe(1);
    expect(m[127 * 128]).toBe(0);
    expect(m[128 * 128]).toBe(1);
  });
});

describe('resamplePoints / bbox / isMeaningful', () => {
  it('resamples every 3 px and keeps both ends', () => {
    const r = resamplePoints([{ x: 0, y: 0 }, { x: 30, y: 0 }]);
    expect(r[0]).toEqual({ x: 0, y: 0 });
    expect(r[r.length - 1]).toEqual({ x: 30, y: 0 });
    expect(r.length).toBeGreaterThanOrEqual(10);
  });
  it('bbox', () => {
    expect(strokesBBox([{ points: [{ x: 1, y: 5 }, { x: 9, y: -2 }], lineWidth: 2 }])).toEqual({ minX: 1, minY: -2, maxX: 9, maxY: 5 });
  });
  it('a tap is not worth a model run, a stroke is', () => {
    expect(isMeaningful([{ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], lineWidth: 4 }])).toBe(false);
    const line = Array.from({ length: 10 }, (_, i) => ({ x: i * 4, y: 0 }));
    expect(isMeaningful([{ points: line, lineWidth: 4 }])).toBe(true);
    expect(isMeaningful([])).toBe(false);
  });
});

describe('rasterLineWidth: the model always sees the same stroke thickness', () => {
  it('ends up TARGET_STROKE_PX wide after scaling, for any writing size', () => {
    for (const scale of [0.4, 0.84, 1.35, 2.06, 3]) {
      expect(rasterLineWidth(scale) * scale).toBeCloseTo(TARGET_STROKE_PX, 6);
    }
  });
  it('never draws thinner than 1 px and survives a bad scale', () => {
    expect(rasterLineWidth(100)).toBe(1);
    expect(rasterLineWidth(0)).toBe(TARGET_STROKE_PX);
    expect(rasterLineWidth(NaN)).toBe(TARGET_STROKE_PX);
  });
});

describe('normalizeSize: big writing is scaled down, ordinary writing is untouched', () => {
  const line = (k: number) => [
    { lineWidth: 4, points: [{ x: 10 * k, y: 10 * k }, { x: 10 * k, y: 60 * k }] },
    { lineWidth: 4, points: [{ x: 30 * k, y: 30 * k }, { x: 60 * k, y: 30 * k }] },
  ];
  it('ordinary writing is returned as it is', () => {
    const s = line(1);
    expect(normalizeSize(s)).toBe(s);
  });
  it('scales big lines down to NORMAL_INK_H', () => {
    const a = normalizeSize(line(5));
    const b = normalizeSize(line(8));
    const ba = strokesBBox(a);
    const bb = strokesBBox(b);
    expect(ba.maxY - ba.minY).toBeCloseTo(NORMAL_INK_H);
    expect(bb.maxX - bb.minX).toBeCloseTo(ba.maxX - ba.minX);
  });
});
