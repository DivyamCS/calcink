import type { Answer } from '../math/solve.ts';
import type { Line, Stroke } from '../ink/types.ts';

export interface Candidate {
  latex: string;
  /** probability of each token of `latex` (then of the end token), when the recogniser reports it */
  tokenProbs?: readonly number[];
  /** probability of the least certain token (0..1) */
  confidence: number;
  /** length-normalised log-probability; higher is better */
  score: number;
}

export interface RecognizerOutput {
  /** Best LaTeX token string, e.g. "1 8 + 4 \\times 3 =" */
  latex: string;
  /** Wall-clock recognition time in ms (for the status line / benchmarks). */
  ms: number;
  /** 0..1, how sure the model is of its least certain symbol. Undefined = not reported. */
  confidence?: number;
  /** Alternatives, best first (the app may prefer one that is a valid calculation). */
  candidates?: readonly Candidate[];
}

/** Anything that can read a set of strokes: the Web Worker client in production, a fake in tests. */
export interface Recognizer {
  recognize(strokes: readonly Stroke[]): Promise<RecognizerOutput>;
  /** Abandon the request in flight (its promise rejects); optional. */
  cancel?(): void;
  /** Stop the worker and free the model; optional. */
  dispose?(): void;
  /** Pen down (true) / up (false): pause a reading in progress; optional. */
  pause?(on: boolean): void;
}

/** Injected so tests can control time. */
export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type RecognizerStatus =
  | { phase: 'idle' }
  | { phase: 'waiting' } // edit seen, debouncing
  | { phase: 'recognizing' }
  | { phase: 'error'; message: string };

export interface LineResult {
  latex: string;
  answer: Answer;
  ms: number;
  /** 0..1; undefined when the recogniser does not report it (or for failures) */
  confidence: number | undefined;
  /** Old answer shown faded while an edited line is read again. */
  stale?: boolean;
}

export interface LineView {
  line: Line;
  /** undefined while the line is waiting to be (re)recognised */
  result: LineResult | undefined;
}
