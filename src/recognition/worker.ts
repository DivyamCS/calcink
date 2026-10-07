// Recognition worker: loads the model, rasterises strokes, runs the encoder and the beam search.
// The main thread only sends points and gets LaTeX back.
import * as ort from 'onnxruntime-web';
import { beamSearch, confidenceOf } from './decoder.ts';
import { isMeaningful, preprocessStrokes, type PreprocessResult } from './preprocess.ts';
import type { EngineConfig, WireCandidate, WorkerRequest, WorkerResponse } from './protocol.ts';
import { allowedIds, idsToLatex, type Vocab } from './vocab.ts';

const scope = self as unknown as {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
};

let config: EngineConfig | null = null;
let vocab: Vocab | null = null;
let allowed: Set<number> | null = null;
let encoder: ort.InferenceSession | null = null;
let decoder: ort.InferenceSession | null = null;
let initializing: Promise<void> | null = null;

const reply = (m: WorkerResponse): void => scope.postMessage(m);

// cheap, unthrottled yield
const channel = new MessageChannel();
const waiting: Array<() => void> = [];
channel.port1.onmessage = () => waiting.shift()?.();
const yieldNow = (): Promise<void> =>
  new Promise((resolve) => {
    waiting.push(resolve);
    channel.port2.postMessage(0);
  });

// OffscreenCanvas support
const offscreen = ((): boolean => {
  try {
    return typeof OffscreenCanvas !== 'undefined' && new OffscreenCanvas(1, 1).getContext('2d') !== null;
  } catch {
    return false;
  }
})();

// While the user draws, a reading in progress waits between decoder steps so drawing gets the CPU on slow
// machines. Capped at MAX_PAUSE_MS in case a pen-up message gets lost.
const MAX_PAUSE_MS = 2000;
let paused = false;
const resumeWaiters: Array<() => void> = [];
const waitWhilePaused = async (): Promise<void> => {
  if (!paused) return;
  await new Promise<void>((resolve) => {
    resumeWaiters.push(resolve);
    setTimeout(resolve, MAX_PAUSE_MS);
  });
};

// model loading

async function download(url: string, onBytes: (n: number, total: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url.split('/').pop()}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    onBytes(value.length, total);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out.buffer;
}

async function init(cfg: EngineConfig): Promise<void> {
  const t0 = performance.now();
  config = cfg;

  // serve the WASM runtime from our own origin, not a CDN (needed for offline use)
  ort.env.wasm.wasmPaths = cfg.ortBaseUrl;
  // Multi-threading needs cross-origin isolation (COOP/COEP headers); without it ORT silently uses 1 thread.
  ort.env.wasm.numThreads = self.crossOriginIsolated ? cfg.threads : 1;

  const vocabRes = await fetch(cfg.vocabUrl);
  if (!vocabRes.ok) throw new Error(`vocab.json: HTTP ${vocabRes.status}`);
  vocab = (await vocabRes.json()) as Vocab;
  allowed = allowedIds(vocab, cfg.symbols);

  // progress = bytes of both model files together
  let loaded = 0;
  const totals = new Map<string, number>();
  const progress = (key: string) => (n: number, total: number) => {
    loaded += n;
    totals.set(key, total);
    reply({ type: 'progress', loaded, total: [...totals.values()].reduce((a, b) => a + b, 0) });
  };
  const [enc, dec] = await Promise.all([
    download(cfg.encoderUrl, progress('enc')),
    download(cfg.decoderUrl, progress('dec')),
  ]);

  const opts: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  [encoder, decoder] = await Promise.all([ort.InferenceSession.create(enc, opts), ort.InferenceSession.create(dec, opts)]);

  reply({ type: 'ready', ms: Math.round(performance.now() - t0), offscreen, threads: ort.env.wasm.numThreads ?? 1 });
}

// one recognition

let cancelled = -1;

async function recognize(id: number, input: PreprocessResult, preprocessMs: number): Promise<void> {
  if (!encoder || !decoder || !vocab || !config) throw new Error('The handwriting model is not loaded.');
  const enc = encoder;
  const dec = decoder;
  const v = vocab;
  await waitWhilePaused();
  const t0 = performance.now();

  const pixels = new ort.Tensor('float32', input.tensor, [1, 1, input.height, input.width]);
  const pixelMask = new ort.Tensor('bool', input.mask, [1, input.maskHeight, input.maskWidth]);
  const encOut = await enc.run({ pixel_values: pixels, pixel_mask: pixelMask });
  pixels.dispose();
  pixelMask.dispose();
  const features = encOut.encoder_features;
  const featureMask = encOut.encoder_mask;
  const t1 = performance.now();

  try {
    const candidates = await beamSearch(
      async (ids) => {
        const inputIds = new ort.Tensor('int64', BigInt64Array.from(ids, (n) => BigInt(n)), [1, ids.length]);
        const out = await dec.run({ encoder_features: features, encoder_mask: featureMask, input_ids: inputIds });
        inputIds.dispose();
        const logits = out.logits.data as Float32Array;
        const row = logits.slice((ids.length - 1) * v.vocab_size, ids.length * v.vocab_size);
        out.logits.dispose();
        return row;
      },
      {
        sos: v.special_tokens.sos,
        eos: v.special_tokens.eos,
        vocabSize: v.vocab_size,
        beamWidth: config.beamWidth,
        maxSteps: config.maxDecodeSteps,
        allowed,
        yieldEvery: async () => {
          await yieldNow();
          await waitWhilePaused();
        },
        shouldStop: () => cancelled === id,
        lengthPenalty: config.lengthPenalty,
      },
    );
    if (cancelled === id) {
      reply({ type: 'cancelled', id });
      return;
    }
    const wire: WireCandidate[] = candidates.map((c) => ({
      latex: idsToLatex(c.ids, v),
      tokenProbs: c.tokenProbs,
      confidence: confidenceOf(c),
      score: c.score,
    }));
    const t2 = performance.now();
    reply({
      type: 'result',
      id,
      candidates: wire,
      preprocessMs: Math.round(preprocessMs),
      encoderMs: Math.round(t1 - t0),
      decoderMs: Math.round(t2 - t1),
      totalMs: Math.round(t2 - t0 + preprocessMs),
    });
  } finally {
    features.dispose();
    featureMask.dispose();
  }
}

// message loop (strictly one request at a time)

let queue: Promise<void> = Promise.resolve();

scope.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    initializing = init(msg.config).catch((err: unknown) => {
      reply({ type: 'init-error', message: err instanceof Error ? err.message : String(err) });
    });
    return;
  }
  if (msg.type === 'cancel') {
    cancelled = msg.id;
    return;
  }
  if (msg.type === 'pause') {
    paused = msg.on;
    if (!paused) for (const resume of resumeWaiters.splice(0)) resume();
    return;
  }
  if (msg.type === 'recognize') {
    const { id } = msg;
    queue = queue.then(async () => {
      try {
        await initializing;
        if (cancelled === id) return reply({ type: 'cancelled', id });
        let input = msg.input;
        let preprocessMs = 0;
        if (!input) {
          const strokes = msg.strokes ?? [];
          if (!isMeaningful(strokes)) {
            return reply({ type: 'result', id, candidates: [], preprocessMs: 0, encoderMs: 0, decoderMs: 0, totalMs: 0 });
          }
          const tp = performance.now();
          input = preprocessStrokes(strokes, (w, h) => new OffscreenCanvas(w, h));
          preprocessMs = performance.now() - tp;
        }
        await recognize(id, input, preprocessMs);
      } catch (err) {
        reply({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
      }
    });
  }
};
