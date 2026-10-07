import * as ort from 'onnxruntime-web';
import { InferenceEngine, loadVocab, preprocessStrokes } from 'ink-on/core';

// only the .wasm from /ort/: in the dev server the .mjs glue must come from node_modules (Vite rewrites /ort imports)
ort.env.wasm.wasmPaths = { wasm: '/ort/ort-wasm-simd-threaded.wasm' };
const engine = new InferenceEngine({
  encoderUrl: '/models/comer/encoder_int8.onnx',
  decoderUrl: '/models/comer/decoder_int8.onnx',
  beamWidth: 3,
  executionProvider: 'wasm',
});
const vocabPromise = loadVocab('/models/comer/vocab.json');

type Strokes = Array<{ points: Array<{ x: number; y: number }>; lineWidth: number }>;
async function read(strokes: Strokes): Promise<{ latex: string; ms: number }> {
  const r = await engine.recognize(preprocessStrokes(strokes), await vocabPromise, 'number');
  return { latex: r.latex, ms: r.totalMs };
}
(window as unknown as { inkon: typeof read }).inkon = read;
void engine.init().then(() => (document.title = 'ready'));
