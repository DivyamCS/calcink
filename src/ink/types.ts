/** A point in CSS pixels, relative to the top-left of the drawing surface. */
export interface Point {
  x: number;
  y: number;
  /** stylus pressure 0..1 (only recorded for pens; mouse and touch strokes have a constant width) */
  p?: number;
}

/** One pen stroke (same shape as ink-on's Stroke plus an id). Never mutated after it is committed. */
export interface Stroke {
  readonly id: number;
  readonly points: readonly Point[];
  readonly lineWidth: number;
  /** pen colour (CSS colour). Missing = the default ink. Recognition ignores colour entirely. */
  readonly color?: string;
}

export interface Rect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface Size {
  width: number;
  height: number;
}

export type Tool = 'pen' | 'stroke-eraser' | 'pixel-eraser' | 'scribble-eraser';

/** One handwritten line of maths: the strokes that sit on the same baseline band. */
export interface Line {
  /** Stable signature of the stroke set; changes whenever strokes are added/removed. */
  readonly id: string;
  readonly strokes: readonly Stroke[];
  readonly bbox: Rect;
}
