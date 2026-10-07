import type { PreprocessResult, PreprocessStroke } from './preprocess.ts';
import type { SymbolSet } from './vocab.ts';

export interface EngineConfig {
  encoderUrl: string;
  decoderUrl: string;
  vocabUrl: string;
  /** Folder (with trailing slash) holding the onnxruntime-web .wasm/.mjs files. Same-origin => works offline. */
  ortBaseUrl: string;
  beamWidth: number;
  maxDecodeSteps: number;
  /** Which symbols the model may write (see vocab.ts). */
  symbols: SymbolSet;
  /** WASM threads for inference. Leave cores free for the UI so drawing stays at 60 FPS. */
  threads: number;
  /** Beam-search length penalty (see decoder.ts). Undefined = default. */
  lengthPenalty?: number;
}

export interface WireCandidate {
  latex: string;
  /** probability of each LaTeX token (same order as latex.split(' ')), then of the end token */
  tokenProbs: number[];
  /** probability of the least certain token, 0..1 */
  confidence: number;
  /** length-normalised log-probability (higher is better) */
  score: number;
}

export type WorkerRequest =
  | { type: 'init'; config: EngineConfig }
  /** Either raw strokes (rasterised in the worker on an OffscreenCanvas) or a tensor prepared on the main thread. */
  | { type: 'recognize'; id: number; strokes?: PreprocessStroke[]; input?: PreprocessResult }
  | { type: 'cancel'; id: number }
  /** pen down (true) / up (false): pause decoding between steps */
  | { type: 'pause'; on: boolean };

export type WorkerResponse =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'ready'; ms: number; offscreen: boolean; threads: number }
  | { type: 'init-error'; message: string }
  | {
      type: 'result';
      id: number;
      candidates: WireCandidate[];
      preprocessMs: number;
      encoderMs: number;
      decoderMs: number;
      totalMs: number;
    }
  | { type: 'cancelled'; id: number }
  | { type: 'error'; id: number; message: string };
