import { describe, expect, it } from 'vitest';
import { LineRecognizer } from './line-recognizer.ts';
import type { Clock, Recognizer, RecognizerOutput, RecognizerStatus } from './types.ts';
import type { Stroke } from '../ink/types.ts';

// test doubles

/** Manually advanced clock. */
class FakeClock implements Clock {
  now = 0;
  private nextHandle = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const h = this.nextHandle++;
    this.timers.set(h, { at: this.now + ms, fn });
    return h;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.now = due[1].at;
      this.timers.delete(due[0]);
      due[1].fn();
    }
    this.now = target;
  }
  get pending(): number {
    return this.timers.size;
  }
}

interface Call {
  strokes: readonly Stroke[];
  resolve: (out: Partial<RecognizerOutput> & { latex: string }) => void;
  reject: (e: unknown) => void;
}

/** Recogniser whose responses the test controls. */
class DeferredRecognizer implements Recognizer {
  calls: Call[] = [];
  cancels = 0;
  cancel(): void {
    this.cancels++;
  }
  inFlight = 0;
  maxInFlight = 0;
  recognize(strokes: readonly Stroke[]): Promise<RecognizerOutput> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    return new Promise((resolve, reject) => {
      this.calls.push({
        strokes,
        resolve: (out) => {
          this.inFlight--;
          resolve({ ...out, latex: out.latex, ms: out.ms ?? 5 });
        },
        reject: (e) => {
          this.inFlight--;
          reject(e);
        },
      });
    });
  }
}

/** Let promise continuations run. */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

let nextId = 1;
/** A box-shaped glyph at (x,y) of size w*h. */
function glyph(x: number, y: number, w = 30, h = 40): Stroke {
  return {
    id: nextId++,
    lineWidth: 3,
    points: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
  };
}
const tap = (x: number, y: number): Stroke => ({
  id: nextId++,
  lineWidth: 3,
  points: [{ x, y }, { x: x + 0.5, y: y + 0.5 }],
});

function setup(opts: { debounceMs?: number; maxCache?: number } = {}) {
  const clock = new FakeClock();
  const rec = new DeferredRecognizer();
  const statuses: RecognizerStatus[] = [];
  let changes = 0;
  const lr = new LineRecognizer({
    recognizer: rec,
    clock,
    debounceMs: opts.debounceMs ?? 400,
    maxCache: opts.maxCache,
    onChange: () => changes++,
    onStatus: (s) => statuses.push(s),
  });
  return { clock, rec, lr, statuses, changes: () => changes };
}

// tests

describe('LineRecognizer: debouncing', () => {
  it('does nothing until the user pauses', () => {
    const { clock, rec, lr } = setup();
    lr.update([glyph(10, 100)]);
    clock.advance(399);
    expect(rec.calls.length).toBe(0);
    clock.advance(1);
    expect(rec.calls.length).toBe(1);
  });

  it('coalesces a burst of edits into a single recognition', () => {
    const { clock, rec, lr } = setup();
    const strokes: Stroke[] = [];
    for (let i = 0; i < 6; i++) {
      strokes.push(glyph(10 + i * 40, 100));
      lr.update(strokes);
      clock.advance(100); // keep writing, never pausing long enough
    }
    expect(rec.calls.length).toBe(0);
    clock.advance(400);
    expect(rec.calls.length).toBe(1);
    expect(rec.calls[0].strokes.length).toBe(6); // the whole line, final state
  });

  it('goes waiting -> recognizing -> idle', async () => {
    const { clock, rec, lr, statuses } = setup();
    lr.update([glyph(10, 100)]);
    expect(statuses[statuses.length - 1]).toEqual({ phase: 'waiting' });
    clock.advance(400);
    expect(statuses[statuses.length - 1]).toEqual({ phase: 'recognizing' });
    rec.calls[0].resolve({ latex: '1 + 1' });
    await flush();
    expect(statuses[statuses.length - 1]).toEqual({ phase: 'idle' });
  });
});

describe('LineRecognizer: answers', () => {
  it('computes the answer once the recogniser replies', async () => {
    const { clock, rec, lr } = setup();
    lr.update([glyph(10, 100)]);
    expect(lr.views[0].result).toBeUndefined(); // not read yet
    clock.advance(400);
    rec.calls[0].resolve({ latex: '1 8 + 4 \\times 3 =' });
    await flush();
    const result = lr.views[0].result;
    expect(result?.answer).toEqual({ kind: 'value', text: '30', expression: '18+4*3' });
  });

  it('division by zero becomes an Undefined answer', async () => {
    const { clock, rec, lr } = setup();
    lr.update([glyph(10, 100)]);
    clock.advance(400);
    rec.calls[0].resolve({ latex: '5 \\div 0 =' });
    await flush();
    expect(lr.views[0].result?.answer.kind).toBe('undefined');
  });

  it('a line without "=" is remembered as having no answer (and not re-read)', async () => {
    const { clock, rec, lr } = setup();
    const s = [glyph(10, 100)];
    lr.update(s);
    clock.advance(400);
    rec.calls[0].resolve({ latex: '1 + 1' });
    await flush();
    expect(lr.views[0].result?.answer.kind).toBe('none');
    lr.update(s);
    clock.advance(1000);
    expect(rec.calls.length).toBe(1);
  });

  it('notifies listeners when a result lands', async () => {
    const { clock, rec, lr, changes } = setup();
    lr.update([glyph(10, 100)]);
    const before = changes();
    clock.advance(400);
    rec.calls[0].resolve({ latex: '2 =' });
    await flush();
    expect(changes()).toBeGreaterThan(before);
  });
});

describe('LineRecognizer: only changed lines are re-read', () => {
  it("editing line 2 does not re-read line 1", async () => {
    const { clock, rec, lr } = setup();
    const line1 = [glyph(10, 100), glyph(60, 100)];
    const line2 = [glyph(10, 300)];
    lr.update([...line1, ...line2]);
    clock.advance(400);
    rec.calls[0].resolve({ latex: '1 + 1 =' });
    await flush();
    rec.calls[1].resolve({ latex: '2 + 2 =' });
    await flush();
    expect(rec.calls.length).toBe(2);

    lr.update([...line1, ...line2, glyph(60, 300)]); // touch only line 2
    clock.advance(400);
    expect(rec.calls.length).toBe(3);
    expect(rec.calls[2].strokes.length).toBe(2); // line 2 only
    rec.calls[2].resolve({ latex: '2 + 3 =' });
    await flush();

    const answers = lr.views.map((v) => (v.result?.answer.kind === 'value' ? v.result.answer.text : null));
    expect(answers).toEqual(['2', '5']); // line 1 kept its old answer
  });

  it('one request in flight at a time', async () => {
    const { clock, rec, lr } = setup();
    lr.update([glyph(10, 100), glyph(10, 300), glyph(10, 500)]);
    clock.advance(400);
    for (let i = 0; i < 3; i++) {
      expect(rec.calls.length).toBe(i + 1);
      rec.calls[i].resolve({ latex: `${i} =` });
      await flush();
    }
    expect(rec.maxInFlight).toBe(1);
  });
});

describe('LineRecognizer: stale results', () => {
  it('discards a result whose strokes changed while it was being computed', async () => {
    const { clock, rec, lr } = setup();
    const first = [glyph(10, 100)];
    lr.update(first);
    clock.advance(400); // request #1 in flight
    expect(rec.calls.length).toBe(1);

    const edited = [...first, glyph(60, 100)]; // user keeps writing
    lr.update(edited);

    rec.calls[0].resolve({ latex: '9 9 =' }); // answer for the old strokes arrives late
    await flush();
    expect(lr.views[0].result).toBeUndefined(); // must not be shown against the new strokes

    clock.advance(400);
    expect(rec.calls.length).toBe(2);
    rec.calls[1].resolve({ latex: '1 + 1 =' });
    await flush();
    expect(lr.views[0].result?.answer).toEqual({ kind: 'value', text: '2', expression: '1+1' });
  });

  it('waits for the debounce window', async () => {
    const { clock, rec, lr } = setup();
    lr.update([glyph(10, 100)]);
    clock.advance(400);
    lr.update([glyph(10, 100), glyph(60, 100)]); // debounce restarts
    rec.calls[0].resolve({ latex: '1 =' }); // old result lands inside the window
    await flush();
    expect(rec.calls.length).toBe(1); // still just the first request
    clock.advance(400);
    expect(rec.calls.length).toBe(2);
  });
});

describe('LineRecognizer: caching (undo/redo and rewrites are instant)', () => {
  it('returning to a previously read stroke set needs no new recognition', async () => {
    const { clock, rec, lr } = setup();
    const a = glyph(10, 100);
    const b = glyph(60, 100);
    lr.update([a]);
    clock.advance(400);
    rec.calls[0].resolve({ latex: '1 =' });
    await flush();

    lr.update([a, b]); // write more
    lr.update([a]); // undo
    expect(lr.views[0].result?.answer.kind).toBe('value'); // immediately available
    clock.advance(2000);
    expect(rec.calls.length).toBe(1);
  });

  it('stays bounded (LRU) so long sessions do not grow memory', async () => {
    const { clock, rec, lr } = setup({ maxCache: 5 });
    for (let i = 0; i < 20; i++) {
      lr.update([glyph(10 + i, 100)]);
      clock.advance(400);
      rec.calls[rec.calls.length - 1].resolve({ latex: `${i} =` });
      await flush();
    }
    // Only the most recent entries survive; the oldest signatures are re-read if they come back.
    const old = [{ ...glyph(0, 100), id: 1 }];
    lr.update(old);
    expect(lr.views[0].result).toBeUndefined();
  });
});

describe('LineRecognizer: edge cases', () => {
  it('never sends accidental taps to the recogniser', () => {
    const { clock, rec, lr } = setup();
    lr.update([tap(10, 10), tap(200, 200)]);
    clock.advance(5000);
    expect(rec.calls.length).toBe(0);
    expect(lr.views.every((v) => v.result?.answer.kind === 'none')).toBe(true);
  });

  it('turns a recogniser failure into an error answer instead of throwing', async () => {
    const { clock, rec, lr, statuses } = setup();
    lr.update([glyph(10, 100)]);
    clock.advance(400);
    rec.calls[0].reject(new Error('model not loaded'));
    await flush();
    const ans = lr.views[0].result?.answer;
    expect(ans?.kind).toBe('error');
    expect(statuses[statuses.length - 1]).toEqual({ phase: 'error', message: 'model not loaded' });
  });

  it('recovers: the next edit is recognised normally after a failure', async () => {
    const { clock, rec, lr } = setup();
    const a = glyph(10, 100);
    lr.update([a]);
    clock.advance(400);
    rec.calls[0].reject(new Error('boom'));
    await flush();

    lr.update([a, glyph(60, 100)]);
    clock.advance(400);
    rec.calls[1].resolve({ latex: '4 =' });
    await flush();
    expect(lr.views[0].result?.answer.kind).toBe('value');
  });

  it('retry() re-reads lines that failed', async () => {
    const { clock, rec, lr } = setup();
    lr.update([glyph(10, 100)]);
    clock.advance(400);
    rec.calls[0].reject(new Error('not ready'));
    await flush();
    lr.retry();
    clock.advance(400);
    expect(rec.calls.length).toBe(2);
  });

  it('clearing the canvas leaves no lines and cancels pending work', () => {
    const { clock, rec, lr } = setup();
    lr.update([glyph(10, 100)]);
    lr.update([]);
    clock.advance(5000);
    expect(lr.views).toEqual([]);
    expect(rec.calls.length).toBe(0);
  });

  it('dispose() cancels timers and ignores late results', async () => {
    const { clock, rec, lr } = setup();
    lr.update([glyph(10, 100)]);
    clock.advance(400);
    lr.dispose();
    rec.calls[0].resolve({ latex: '1 =' });
    await flush();
    expect(lr.views).toEqual([]);
    lr.update([glyph(10, 100)]);
    expect(clock.pending).toBe(0);
  });
  it('waits while the pen is down', () => {
    const { clock, rec, lr } = setup();
    lr.update([glyph(10, 100)]);
    clock.advance(300);
    lr.setWriting(true); // next stroke begins before the debounce elapsed
    clock.advance(5000); // a long stroke
    expect(rec.calls.length).toBe(0);
    lr.setWriting(false);
    clock.advance(399);
    expect(rec.calls.length).toBe(0);
    clock.advance(1);
    expect(rec.calls.length).toBe(1);
  });

  it('a commit while the pen is still down does not start the timer', () => {
    const { clock, rec, lr } = setup();
    lr.setWriting(true);
    lr.update([glyph(10, 100)]);
    clock.advance(5000);
    expect(rec.calls.length).toBe(0);
    expect(clock.pending).toBe(0);
  });
});

describe('LineRecognizer: a page with variables', () => {
  it('variables flow down without re-reading lines', async () => {
    const { clock, rec, lr } = setup();
    const x1 = glyph(10, 100);
    const line2 = glyph(10, 300);
    lr.update([x1, line2]);
    clock.advance(400);
    rec.calls[0].resolve({ latex: 'x = 1 0' });
    await flush();
    rec.calls[1].resolve({ latex: 'x + 5 =' });
    await flush();
    expect(lr.views.map((v) => v.result?.answer.kind)).toEqual(['assigned', 'value']);
    expect(lr.views[1].result?.answer).toMatchObject({ text: '15' });

    // the user rewrites line 1 as "x = 20": only line 1 is read again
    const x2 = glyph(12, 100);
    lr.update([x2, line2]);
    clock.advance(400);
    expect(rec.calls.length).toBe(3);
    rec.calls[2].resolve({ latex: 'x = 2 0' });
    await flush();
    expect(rec.calls.length).toBe(3);
    expect(lr.views[1].result?.answer).toMatchObject({ kind: 'value', text: '25' });
  });

  it('views are memoised (the overlay repaints every frame during animations)', async () => {
    const { clock, rec, lr } = setup();
    lr.update([glyph(10, 100)]);
    clock.advance(400);
    rec.calls[0].resolve({ latex: '1 + 1 =' });
    await flush();
    expect(lr.views).toBe(lr.views);
  });
});

describe('LineRecognizer: cancelling and choosing', () => {
  it('asks the recogniser to cancel when the line being read is edited', async () => {
    const { clock, rec, lr } = setup();
    const a = glyph(10, 100);
    lr.update([a]);
    clock.advance(400);
    lr.update([a, glyph(60, 100)]); // edited while being read
    expect(rec.cancels).toBe(1);
    rec.calls[0].reject(new Error('cancelled'));
    await flush();
    // a cancelled (stale) request is not an error for the user
    expect(lr.currentStatus.phase).not.toBe('error');
  });

  it('does not report "reading" while the pen is down after a result arrived', async () => {
    const { clock, rec, lr } = setup();
    lr.update([glyph(10, 100)]);
    clock.advance(400);
    lr.setWriting(true);
    rec.calls[0].resolve({ latex: '1 =' });
    await flush();
    expect(lr.currentStatus.phase).toBe('idle');
  });

  it('prefers a nearly-as-likely candidate that is a valid calculation', async () => {
    const { clock, rec, lr } = setup();
    lr.update([glyph(10, 100)]);
    clock.advance(400);
    rec.calls[0].resolve({
      latex: '1 + \\times 2 =',
      candidates: [
        { latex: '1 + \\times 2 =', confidence: 0.4, score: -0.30 },
        { latex: '1 + 2 =', confidence: 0.5, score: -0.35 },
      ],
    });
    await flush();
    expect(lr.views[0].result).toMatchObject({ latex: '1 + 2 =', confidence: 0.5, answer: { text: '3' } });
  });

  it('but not one that is much less likely', async () => {
    const { clock, rec, lr } = setup();
    lr.update([glyph(10, 100)]);
    clock.advance(400);
    rec.calls[0].resolve({
      latex: '1 + \\times 2 =',
      candidates: [
        { latex: '1 + \\times 2 =', confidence: 0.9, score: -0.1 },
        { latex: '1 + 2 =', confidence: 0.2, score: -2 },
      ],
    });
    await flush();
    expect(lr.views[0].result?.latex).toBe('1 + \\times 2 =');
  });
});

describe('LineRecognizer: an edited line keeps its old answer (faded) until it is re-read', () => {
  it('shows the previous answer as stale, then replaces it with the fresh one', async () => {
    const { clock, rec, lr } = setup();
    const a = glyph(10, 100);
    const b = glyph(60, 100);
    lr.update([a, b]);
    clock.advance(400);
    rec.calls[0].resolve({ latex: '1 2 + 3 =' });
    await flush();
    expect(lr.views[0].result).toMatchObject({ answer: { text: '15' } });
    expect(lr.views[0].result?.stale).toBeFalsy();

    // edit: add a stroke to the same line -> new line id, not read yet
    lr.update([a, b, glyph(110, 100)]);
    expect(lr.views[0].result).toMatchObject({ answer: { text: '15' }, stale: true });

    clock.advance(400);
    rec.calls[1].resolve({ latex: '1 2 + 4 =' });
    await flush();
    expect(lr.views[0].result).toMatchObject({ answer: { text: '16' } });
    expect(lr.views[0].result?.stale).toBeFalsy();
  });

  it('a brand-new line (no shared strokes) has no stale answer', async () => {
    const { clock, rec, lr } = setup();
    const a = glyph(10, 100);
    lr.update([a]);
    clock.advance(400);
    rec.calls[0].resolve({ latex: '7 =' });
    await flush();
    lr.update([a, glyph(10, 400)]);
    expect(lr.views[1].result).toBeUndefined();
  });
});

describe('a reading cancelled because the line changed, then undone straight back', () => {
  it('is read again instead of sticking on a failed reading', async () => {
    const timers: Array<(() => void) | null> = [];
    const clock = {
      setTimeout: (fn: () => void) => timers.push(fn),
      clearTimeout: (h: number) => {
        timers[h - 1] = null;
      },
    };
    const fire = (): void => {
      const due = timers.splice(0).filter(Boolean) as Array<() => void>;
      due.forEach((f) => f());
    };
    let calls = 0;
    let reject: ((e: Error) => void) | undefined;
    const rec = {
      recognize: () => {
        calls++;
        if (calls === 1) return new Promise<never>((_, r) => (reject = r));
        return Promise.resolve({ latex: '1 + 1 =', ms: 1, confidence: 0.99 });
      },
      cancel: () => setTimeout(() => reject?.(new Error('cancelled')), 0),
    };
    const lr = new LineRecognizer({ recognizer: rec as never, clock: clock as never, debounceMs: 1 });
    const mk = (id: number, x: number) => ({ id, lineWidth: 3, points: [{ x, y: 10 }, { x: x + 10, y: 40 }] });
    const strokes = [mk(1, 0), mk(2, 20)];
    lr.update(strokes);
    fire(); // reading in flight
    lr.update([strokes[0]]); // erase: cancel sent
    lr.update(strokes); // undo before the cancel lands
    await new Promise((r) => setTimeout(r, 5));
    fire();
    await new Promise((r) => setTimeout(r, 5));
    expect(lr.views.map((v) => v.result?.answer.kind)).toEqual(['value']);
    expect(lr.views[0].result?.answer).toMatchObject({ text: '2' });
  });
});

describe('pen down pauses a reading in progress', () => {
  it('tells the recogniser when the pen goes down and up (once per change)', () => {
    const calls: boolean[] = [];
    const rec = { recognize: () => new Promise<never>(() => {}), pause: (on: boolean) => calls.push(on) };
    const clock = { setTimeout: () => 0, clearTimeout: () => {} };
    const lr = new LineRecognizer({ recognizer: rec as never, clock: clock as never, debounceMs: 1 });
    lr.setWriting(true);
    lr.setWriting(true);
    lr.setWriting(false);
    expect(calls).toEqual([true, false]);
  });
});
