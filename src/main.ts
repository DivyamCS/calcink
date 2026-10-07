import '@fontsource/caveat/latin-600.css'; // handwriting font for answers, bundled (OFL-1.1) so it works offline
import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { createApp } from './app.ts';
import { chooseCandidate } from './recognition/choose.ts';
import type { SymbolSet } from './recognition/vocab.ts';
import { WorkerRecognizer } from './recognition/worker-recognizer.ts';

const params = new URLSearchParams(location.search);

/** Absolute URL for a file in /public (the worker resolves relative URLs against its script, so be explicit). */
const asset = (path: string): string => new URL(`${import.meta.env.BASE_URL}${path}`, document.baseURI).href;

/** ?symbols=arithmetic|extended|full (default extended). The old ?mode= values still work. */
function symbolSet(): SymbolSet {
  const s = params.get('symbols');
  if (s === 'arithmetic' || s === 'extended' || s === 'full') return s;
  const legacy = params.get('mode');
  if (legacy === 'number') return 'arithmetic';
  if (legacy === 'auto' || legacy === 'expression') return 'full';
  return 'extended';
}

/** Cheaper decoding on weak devices, better accuracy on strong ones. ?beam=1..5 overrides. */
function beamWidth(): number {
  const forced = Number(params.get('beam'));
  if (Number.isInteger(forced) && forced >= 1 && forced <= 5) return forced;
  const cores = navigator.hardwareConcurrency || 2;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  return mem <= 2 ? 1 : cores <= 4 ? 2 : 3;
}

/** Half the cores (max 4) for inference, the rest are left for drawing. */
function threads(): number {
  const cores = navigator.hardwareConcurrency || 2;
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
}

/** ?delay=500 changes the pause (in ms) before the writing is read. */
function pauseMs(): number | undefined {
  const raw = params.get('delay');
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 30000 ? n : undefined;
}

const surface = document.getElementById('surface');
if (!surface) throw new Error('CalcInk: #surface element is missing from index.html');

/** ?lp=0..1.5 overrides the beam-search length penalty (used by the accuracy benchmark). */
function lengthPenalty(): number | undefined {
  const v = Number(params.get('lp'));
  return params.has('lp') && Number.isFinite(v) && v >= 0 && v <= 2 ? v : undefined;
}

let worker: WorkerRecognizer | null = null;

const app = createApp({
  surface,
  debounceMs: pauseMs(),
  makeRecognizer: (onModelState) =>
    (worker = new WorkerRecognizer({
      onModelState,
      config: {
        // model files: CoMER (INT8 ONNX) as published by the ink-on project - we only point to them
        encoderUrl: asset('models/comer/encoder_int8.onnx'),
        decoderUrl: asset('models/comer/decoder_int8.onnx'),
        vocabUrl: asset('models/comer/vocab.json'),
        ortBaseUrl: asset('ort/'),
        beamWidth: beamWidth(),
        maxDecodeSteps: 64,
        symbols: symbolSet(),
        threads: threads(),
        lengthPenalty: lengthPenalty(),
      },
    })),
});

// handle for the automated browser tests (tests/e2e) and for debugging from the console
(window as unknown as { calcink?: unknown }).calcink = {
  app,
  /** recognise strokes directly (bypassing the canvas) and choose a reading, like the app does */
  async read(strokes: Array<{ points: Array<{ x: number; y: number }>; lineWidth: number }>) {
    const out = await (worker as WorkerRecognizer).recognize(strokes.map((s, i) => ({ ...s, id: i + 1 })));
    return { ...chooseCandidate(out), candidates: out.candidates, ms: out.ms };
  },
};

// Service worker: precaches the app shell, runtime and model so CalcInk loads with no network at all.
registerSW({ immediate: true });
