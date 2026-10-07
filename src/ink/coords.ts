/**
 * Coordinate-space conversions for crisp rendering on high-DPI screens.
 */
import type { Point, Size } from './types.ts';

export interface ClientRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const MIN_DPR = 1;
export const MAX_DPR = 4; // beyond this the backing store gets silly for no visible gain

/** Sanitise window.devicePixelRatio (can be 0/NaN in odd environments, fractional on zoom). */
export function normalizeDpr(raw: number | undefined | null): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return MIN_DPR;
  return Math.min(MAX_DPR, Math.max(MIN_DPR, raw));
}

/** Backing-store size in physical pixels for a CSS-pixel layout size. */
export function backingStoreSize(css: Size, dpr: number): Size {
  const d = normalizeDpr(dpr);
  return {
    width: Math.max(1, Math.round(css.width * d)),
    height: Math.max(1, Math.round(css.height * d)),
  };
}

/** Pointer position -> CSS px inside the canvas. `cssSize` is used to undo any CSS scaling of the element. */
export function clientToCss(clientX: number, clientY: number, rect: ClientRect, cssSize?: Size): Point {
  const sx = cssSize && rect.width > 0 ? cssSize.width / rect.width : 1;
  const sy = cssSize && rect.height > 0 ? cssSize.height / rect.height : 1;
  return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
}

export function cssToDevice(p: Point, dpr: number): Point {
  const d = normalizeDpr(dpr);
  return { x: p.x * d, y: p.y * d };
}

export function deviceToCss(p: Point, dpr: number): Point {
  const d = normalizeDpr(dpr);
  return { x: p.x / d, y: p.y / d };
}

/** Clamp a point to the drawing surface. */
export function clampToSize(p: Point, size: Size): Point {
  return {
    x: Math.min(size.width, Math.max(0, p.x)),
    y: Math.min(size.height, Math.max(0, p.y)),
  };
}
