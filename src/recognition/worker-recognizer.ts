/**
 * Main-thread side of the recognition worker. Implements `Recognizer`.
 */
import type { Stroke } from '../ink/types.ts';
import { isMeaningful, preprocessStrokes } from './preprocess.ts';
import type { EngineConfig, WorkerRequest, WorkerResponse } from './protocol.ts';
import type { Recognizer, RecognizerOutput } from './types.ts';


/** A reading abandoned on purpose (its line changed while it was being read). Not a failure. */
export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

export type ModelState =
  | { phase: 'loading'; progress?: number }
  | { phase: 'ready'; loadMs: number }
  | { phase: 'failed'; message: string };

export interface WorkerRecognizerOptions {
  config: EngineConfig;
  onModelState?: (state: ModelState) => void;
  /** Called after every recognition with timings, for the status line and benchmarks. */
  onTiming?: (t: { preprocessMs: number; encoderMs: number; decoderMs: number; totalMs: number }) => void;
}

interface Pending {
  resolve: (out: RecognizerOutput) => void;
  reject: (err: Error) => void;
}

export class WorkerRecognizer implements Recognizer {
  /** Resolves when the model is loaded; rejects if loading failed. */
  readonly ready: Promise<void>;

  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private readonly onTiming: NonNullable<WorkerRecognizerOptions['onTiming']>;
  private nextId = 1;
  private current = 0;
  private offscreen = true;
  private disposed = false;

  constructor(opts: WorkerRecognizerOptions) {
    const onModelState = opts.onModelState ?? (() => {});
    this.onTiming = opts.onTiming ?? (() => {});

    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

    let settle!: { resolve: () => void; reject: (e: Error) => void };
    this.ready = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
    this.ready.catch(() => {}); // failure is surfaced via onModelState; avoid an unhandled rejection

    onModelState({ phase: 'loading' });

    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      switch (msg.type) {
        case 'progress':
          onModelState({ phase: 'loading', progress: msg.total > 0 ? Math.min(1, msg.loaded / msg.total) : undefined });
          break;
        case 'ready':
          this.offscreen = msg.offscreen;
          onModelState({ phase: 'ready', loadMs: msg.ms });
          settle.resolve();
          break;
        case 'init-error':
          onModelState({ phase: 'failed', message: msg.message });
          settle.reject(new Error(msg.message));
          this.failAll(new Error(msg.message));
          break;
        case 'result': {
          const best = msg.candidates[0];
          this.onTiming(msg);
          this.settle(msg.id)?.resolve({
            latex: best?.latex ?? '',
            ms: msg.totalMs,
            confidence: best?.confidence,
            candidates: msg.candidates,
          });
          break;
        }
        case 'cancelled':
          this.settle(msg.id)?.reject(new CancelledError());
          break;
        case 'error':
          this.settle(msg.id)?.reject(new Error(msg.message));
          break;
      }
    };
    this.worker.onerror = (ev) => {
      const message = ev.message || 'The recognition worker crashed.';
      onModelState({ phase: 'failed', message });
      settle.reject(new Error(message));
      this.failAll(new Error(message));
    };

    this.send({ type: 'init', config: opts.config });
  }

  async recognize(strokes: readonly Stroke[]): Promise<RecognizerOutput> {
    await this.ready;
    if (this.disposed) throw new Error('Recognizer was disposed.');

    // plain, cloneable copies of the points (no class instances, no extra fields)
    const plain = strokes.map((s) => ({ points: s.points.map((p) => ({ x: p.x, y: p.y })), lineWidth: s.lineWidth }));
    if (!isMeaningful(plain)) return { latex: '', ms: 0, candidates: [] };

    const id = this.nextId++;
    this.current = id;
    return new Promise<RecognizerOutput>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (this.offscreen) {
        this.send({ type: 'recognize', id, strokes: plain });
      } else {
        // fallback: rasterise here (needs `document`), then transfer the buffers instead of copying them
        const input = preprocessStrokes(plain, (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }));
        this.send({ type: 'recognize', id, input }, [input.tensor.buffer, input.mask.buffer]);
      }
    });
  }

  /** Pen down / up: the worker pauses a reading in progress between decoder steps. */
  pause(on: boolean): void {
    if (!this.disposed) this.send({ type: 'pause', on });
  }

  /** Stop the request in flight (the worker checks between decoder steps). */
  cancel(): void {
    if (this.current && this.pending.has(this.current)) this.send({ type: 'cancel', id: this.current });
  }

  dispose(): void {
    this.disposed = true;
    this.worker.terminate();
    this.failAll(new Error('Recognizer was disposed.'));
  }

  private settle(id: number): Pending | undefined {
    const p = this.pending.get(id);
    this.pending.delete(id);
    return p;
  }

  private send(msg: WorkerRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
