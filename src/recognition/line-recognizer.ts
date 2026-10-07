/**
 * Turns a stream of canvas edits into recognition work.
 */
import { NO_ANSWER, solveSheet } from '../math/solve.ts';
import { chooseCandidate } from './choose.ts';
import { groupIntoLines, isTrivialLine } from '../ink/geometry.ts';
import type { Line, Stroke } from '../ink/types.ts';
import {
  systemClock,
  type Clock,
  type LineResult,
  type LineView,
  type Recognizer,
  type RecognizerStatus,
} from './types.ts';

export interface LineRecognizerOptions {
  recognizer: Recognizer;
  /** Called whenever answers may have changed (redraw the overlay). */
  onChange?: () => void;
  onStatus?: (status: RecognizerStatus) => void;
  /** Quiet period after the last edit before recognising. Default 450 ms (the app passes 800). */
  debounceMs?: number;
  /** Max cached line results (LRU). Default 300. */
  maxCache?: number;
  clock?: Clock;
}

/** What the model read for one line (cached by stroke signature). */
interface Reading {
  latex: string;
  ms: number;
  confidence: number | undefined;
  /** set when the recogniser failed for this line */
  failure?: string;
}

const TRIVIAL: Reading = { latex: '', ms: 0, confidence: undefined };

export class LineRecognizer {
  private readonly recognizer: Recognizer;
  private readonly onChange: () => void;
  private readonly onStatus: (s: RecognizerStatus) => void;
  private readonly debounceMs: number;
  private readonly maxCache: number;
  private readonly clock: Clock;

  private lines: Line[] = [];
  private live = new Set<string>();
  private readonly cache = new Map<string, Reading>();
  private inFlight: string | null = null;
  private memo: { lines: Line[]; readings: Array<Reading | undefined>; views: LineView[] } | null = null;
  /** Views of the previous page state: an edited line keeps showing its old answer (faded) until re-read. */
  private lastViews: readonly LineView[] = [];
  private timer: unknown = undefined;
  private busy = false;
  private writing = false;
  private disposed = false;
  private status: RecognizerStatus = { phase: 'idle' };

  constructor(opts: LineRecognizerOptions) {
    this.recognizer = opts.recognizer;
    this.onChange = opts.onChange ?? (() => {});
    this.onStatus = opts.onStatus ?? (() => {});
    this.debounceMs = opts.debounceMs ?? 450;
    this.maxCache = Math.max(1, opts.maxCache ?? 300);
    this.clock = opts.clock ?? systemClock;
  }

  /** Current lines with their (possibly not yet available) results, solved as one page (top to bottom). */
  get views(): readonly LineView[] {
    const readings = this.lines.map((l) => this.cache.get(l.id));
    const m = this.memo;
    if (m && m.lines === this.lines && m.readings.every((r, i) => r === readings[i])) return m.views;

    const answers = solveSheet(readings.map((r) => (r && !r.failure ? r.latex : undefined)));
    const views = this.lines.map((line, i): LineView => {
      const r = readings[i];
      if (!r) return { line, result: this.previousResult(line) };
      const answer = r.failure ? { kind: 'error' as const, text: '!', reason: r.failure } : answers[i] ?? NO_ANSWER;
      const result: LineResult = { latex: r.latex, answer, ms: r.ms, confidence: r.confidence };
      return { line, result };
    });
    this.memo = { lines: this.lines, readings, views };
    this.lastViews = views;
    return views;
  }

  /** The old answer of the line this one was edited from (they share strokes), marked stale. */
  private previousResult(line: Line): LineResult | undefined {
    const ids = new Set(line.strokes.map((s) => s.id));
    for (const v of this.lastViews) {
      if (!v.result || v.result.answer.kind === 'none') continue;
      if (v.line.strokes.some((s) => ids.has(s.id))) return { ...v.result, stale: true };
    }
    return undefined;
  }

  get currentStatus(): RecognizerStatus {
    return this.status;
  }

  /** Call after every committed change to the strokes (add, erase, undo, clear...). */
  update(strokes: readonly Stroke[]): void {
    if (this.disposed) return;

    this.lines = groupIntoLines(strokes);
    this.live = new Set(this.lines.map((l) => l.id));

    for (const line of this.lines) {
      if (isTrivialLine(line)) {
        this.remember(line.id, TRIVIAL); // an accidental tap: nothing to read
      } else {
        const hit = this.cache.get(line.id);
        if (hit) this.remember(line.id, hit); // refresh LRU position
      }
    }

    // the line being read right now no longer exists (edited/erased): stop wasting the worker's time on it
    if (this.inFlight !== null && !this.live.has(this.inFlight)) this.recognizer.cancel?.();

    this.schedule();
    this.onChange();
  }

  /** Nothing is read while the pen is down; the wait starts on pen-up. */
  setWriting(writing: boolean): void {
    if (this.disposed || this.writing === writing) return;
    this.writing = writing;
    this.recognizer.pause?.(writing);
    this.schedule();
  }

  /** Forget failed lines and try them again (e.g. after the model finished loading). */
  retry(): void {
    for (const [id, reading] of this.cache) {
      if (reading.failure !== undefined) this.cache.delete(id);
    }
    this.update(this.lines.flatMap((l) => l.strokes));
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.cache.clear();
    this.memo = null;
    this.lastViews = [];
    this.lines = [];
    this.live.clear();
  }


  private schedule(): void {
    this.clearTimer();
    if (this.hasDirtyLine()) {
      if (!this.writing) {
        this.timer = this.clock.setTimeout(() => {
          this.timer = undefined;
          this.pump();
        }, this.debounceMs);
      }
      if (!this.busy) this.setStatus({ phase: 'waiting' });
    } else if (!this.busy) {
      this.setStatus({ phase: 'idle' });
    }
  }

  private hasDirtyLine(): boolean {
    return this.lines.some((l) => !this.cache.has(l.id));
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private setStatus(status: RecognizerStatus): void {
    this.status = status;
    this.onStatus(status);
  }

  private remember(id: string, result: Reading): void {
    this.cache.delete(id); // re-insert => most recently used
    this.cache.set(id, result);
    while (this.cache.size > this.maxCache) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
  }

  private pump(): void {
    if (this.disposed || this.busy || this.writing || this.timer !== undefined) return;

    const next = this.lines.find((l) => !this.cache.has(l.id));
    if (!next) {
      // keep showing a recogniser failure until the user edits again
      if (this.status.phase !== 'error') this.setStatus({ phase: 'idle' });
      return;
    }

    this.busy = true;
    this.inFlight = next.id;
    this.setStatus({ phase: 'recognizing' });

    this.recognizer.recognize(next.strokes).then(
      (out) => {
        const chosen = chooseCandidate(out);
        this.finish(next, { latex: chosen.latex, ms: out.ms, confidence: chosen.confidence });
      },
      (err: unknown) => {
        // cancelled on purpose (the line changed while being read): nothing to remember. If an undo brought the
        // line straight back, it is still unread and gets read again, never stuck on a "failed" reading.
        if (err instanceof Error && (err.name === 'CancelledError' || err.message === 'cancelled')) {
          this.finish(next, null);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        this.finish(next, { latex: '', ms: 0, confidence: undefined, failure: message }, message);
      },
    );
  }

  private finish(line: Line, reading: Reading | null, errorMessage?: string): void {
    this.busy = false;
    this.inFlight = null;
    if (this.disposed) return;

    if (reading !== null && this.live.has(line.id)) {
      this.remember(line.id, reading);
      this.onChange();
      if (errorMessage !== undefined) this.setStatus({ phase: 'error', message: errorMessage });
    }
    // otherwise: stale (the strokes changed meanwhile, or it was cancelled) - drop it silently

    if (this.timer !== undefined || this.writing) {
      // the user is still writing: the debounce / pen-up will drive the next pump
      if (this.hasDirtyLine()) this.setStatus({ phase: 'waiting' });
      else if (this.status.phase !== 'error') this.setStatus({ phase: 'idle' });
    } else {
      this.pump();
    }
  }
}
