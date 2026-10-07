export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Placement {
  box: Box;
  /** 1 = full size; smaller when the page is crowded */
  scale: number;
}

export interface PlaceOptions {
  /** card sizes tried, largest first */
  scales?: readonly number[];
  /** grid step of the search, px */
  step?: number;
  /** clear space kept around obstacles, px */
  margin?: number;
  /** Bottom of the visible screen; going below it costs extra so cards stay on their equation's screen. */
  softBottom?: number;
}

const DEFAULTS = { scales: [1, 0.8, 0.62], step: 12, margin: 8 };

export const overlaps = (a: Box, b: Box, m = 0): boolean =>
  a.minX < b.maxX + m && a.maxX > b.minX - m && a.minY < b.maxY + m && a.maxY > b.minY - m;

/**
 * Cheapest free spot for a w x h card near `anchor`. Moving up/down costs more than right, left costs more than
 * right, and smaller sizes cost extra so the card only shrinks when it helps a lot.
 */
export function placeCard(anchor: { x: number; y: number }, w: number, h: number, obstacles: readonly Box[], bounds: Box, opts: PlaceOptions = {}): Placement | null {
  const { scales, step, margin } = { ...DEFAULTS, ...opts };
  const softBottom = opts.softBottom ?? Infinity;
  let best: { box: Box; scale: number; cost: number } | null = null;
  for (const scale of scales) {
    const cw = Math.round(w * scale);
    const ch = Math.round(h * scale);
    const penalty = (1 - scale) * 800;
    if (best && penalty >= best.cost) break; // a smaller card can only cost more from here
    const xs = positions(bounds.minX, bounds.maxX - cw, step, anchor.x);
    const ys = positions(bounds.minY, bounds.maxY - ch, step, anchor.y);
    for (const y of ys) {
      const dy = Math.abs(y - anchor.y) * 2.5;
      if (best && penalty + dy >= best.cost) continue;
      // only the obstacles that reach into this row band matter
      const band = obstacles.filter((o) => o.minY < y + ch + margin && o.maxY > y - margin);
      for (const x of xs) {
        const dx = x >= anchor.x ? x - anchor.x : (anchor.x - x) * 3;
        const cost = penalty + dy + dx + Math.max(0, y + ch - softBottom) * 8;
        if (best && cost >= best.cost) continue;
        const box = { minX: x, minY: y, maxX: x + cw, maxY: y + ch };
        if (band.some((o) => overlaps(box, o, margin))) continue;
        best = { box, scale, cost };
      }
    }
  }
  return best ? { box: best.box, scale: best.scale } : null;
}

/** grid positions from lo to hi, plus the anchor itself (clamped) so the ideal spot is always tried exactly */
function positions(lo: number, hi: number, step: number, anchor: number): number[] {
  if (hi < lo) return [];
  const out = [Math.min(hi, Math.max(lo, anchor))];
  for (let v = lo; v <= hi; v += step) out.push(v);
  return out;
}
