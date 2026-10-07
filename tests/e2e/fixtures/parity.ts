import { preprocessStrokes as inkOnPreprocess } from 'ink-on/core';
import { preprocessStrokes } from '../../../src/recognition/preprocess.ts';

type Strokes = Array<{ points: Array<{ x: number; y: number }>; lineWidth: number }>;

function compare(strokes: Strokes) {
  const ref = inkOnPreprocess(strokes);
  // ink-on's recipe (on-screen pen width) so the port itself can be compared pixel for pixel
  const recipe = { normalizeWidth: false, normalizeSize: false };
  const onDom = preprocessStrokes(strokes, (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }), recipe);
  const onOffscreen = preprocessStrokes(strokes, (w, h) => new OffscreenCanvas(w, h), recipe);
  const diff = (a: Float32Array, b: Float32Array): number => {
    if (a.length !== b.length) return Infinity;
    let m = 0;
    for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
    return m;
  };
  const sameMask = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
  return {
    shape: [ref.height, ref.width],
    shapeOurs: [onOffscreen.height, onOffscreen.width],
    maxDiffDom: diff(ref.tensor, onDom.tensor),
    maxDiffOffscreen: diff(ref.tensor, onOffscreen.tensor),
    maskEqual: sameMask(ref.mask, onDom.mask) && sameMask(ref.mask, onOffscreen.mask),
    inkPixels: ref.tensor.reduce((n, v) => n + (v > 0.5 ? 1 : 0), 0),
  };
}

(window as unknown as { parity: typeof compare }).parity = compare;
document.title = 'ready';
