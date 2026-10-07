import { describe, expect, it } from 'vitest';
import { beamSearch, confidenceOf, logSoftmax, topK, type StepFn } from './decoder.ts';

const V = 20; // fake vocabulary: 0 pad, 1 sos, 2 eos, 3.. tokens
const SOS = 1;
const EOS = 2;

/** A fake model that wants to write `target` (then EOS), with probability ~`sure` for the right token. */
function scripted(target: number[], sure = 4): StepFn & { calls: number } {
  const fn = (async (ids: readonly number[]) => {
    fn.calls++;
    const pos = ids.length - 1; // tokens already written after sos
    const want = pos < target.length ? target[pos] : EOS;
    const logits = new Float32Array(V);
    logits[want] = sure;
    return logits;
  }) as unknown as StepFn & { calls: number };
  fn.calls = 0;
  return fn;
}

const base = { sos: SOS, eos: EOS, vocabSize: V, maxSteps: 64, allowed: null };

describe('beamSearch', () => {
  it('reads long runs of the same digit (ink-on stopped after 3: "10000" became "1000")', async () => {
    const target = [4, 3, 3, 3, 3, 3, 3, 5, 4, 6]; // "1 0 0 0 0 0 0 + 1 =" in a fake vocabulary
    for (const beamWidth of [1, 3]) {
      const [best] = await beamSearch(scripted(target), { ...base, beamWidth });
      expect(best.ids).toEqual(target);
    }
  });

  it('still stops a runaway loop', async () => {
    const forever = scripted(new Array(200).fill(3));
    const [best] = await beamSearch(forever, { ...base, beamWidth: 1, maxRepeat: 12 });
    expect(best.ids.length).toBe(12);
  });

  it('never emits a token outside the allowed set', async () => {
    const wantsForbidden: StepFn = async (ids) => {
      const l = new Float32Array(V);
      if (ids.length === 1) {
        l[9] = 10; // forbidden, most likely
        l[7] = 5; // allowed, second best
      } else l[EOS] = 10;
      return l;
    };
    const [best] = await beamSearch(wantsForbidden, { ...base, beamWidth: 2, allowed: new Set([7, 8]) });
    expect(best.ids).toEqual([7]);
    // probability is renormalised over what is allowed: a forbidden rival ("g" vs "9") does not make it doubtful
    expect(confidenceOf(best)).toBeGreaterThan(0.9);
  });

  it('a confident read has confidence close to 1', async () => {
    const [best] = await beamSearch(scripted([4, 5, 6], 12), { ...base, beamWidth: 3 });
    expect(confidenceOf(best)).toBeGreaterThan(0.99);
  });

  it('beam search can recover from a locally-better first token (greedy cannot)', async () => {
    // first token: 3 (p~.6) or 4 (p~.4). After 3 the model is lost (flat); after 4 it is sure of 5 then EOS.
    const step: StepFn = async (ids) => {
      const l = new Float32Array(V);
      if (ids.length === 1) {
        l[3] = Math.log(0.6) + 20;
        l[4] = Math.log(0.4) + 20;
      } else if (ids[1] === 4) {
        l[ids.length === 2 ? 5 : EOS] = 30;
      } // after 3: all logits equal -> every token ~1/20
      return l;
    };
    const greedy = await beamSearch(step, { ...base, beamWidth: 1, maxSteps: 3 });
    const beam = await beamSearch(step, { ...base, beamWidth: 3, maxSteps: 3 });
    expect(greedy[0].ids[0]).toBe(3);
    expect(beam[0].ids).toEqual([4, 5]);
  });

  it('can be cancelled between steps', async () => {
    let stop = false;
    const step = scripted([4, 4, 5, 6, 7, 8]);
    const result = await beamSearch(step, {
      ...base,
      beamWidth: 1,
      shouldStop: () => stop,
      yieldEvery: async () => {
        if (step.calls >= 2) stop = true;
      },
    });
    expect(result).toEqual([]);
    expect(step.calls).toBe(2);
  });

  it('returns several candidates best-first', async () => {
    const step: StepFn = async (ids) => {
      const l = new Float32Array(V);
      if (ids.length === 1) {
        l[3] = 2;
        l[4] = 1.5;
      } else l[EOS] = 10;
      return l;
    };
    const c = await beamSearch(step, { ...base, beamWidth: 2 });
    expect(c.map((x) => x.ids)).toEqual([[3], [4]]);
    expect(c[0].score).toBeGreaterThan(c[1].score);
  });
});

describe('confidence among allowed symbols', () => {
  it('two ALLOWED rivals make a reading doubtful', async () => {
    const step: StepFn = async (ids) => {
      const l = new Float32Array(V);
      if (ids.length === 1) {
        l[7] = 5;
        l[8] = 4.8; // e.g. "1" vs "7"
      } else l[EOS] = 10;
      return l;
    };
    const [best] = await beamSearch(step, { ...base, beamWidth: 2, allowed: new Set([7, 8]) });
    expect(confidenceOf(best)).toBeLessThan(0.6);
  });
});

describe('helpers', () => {
  it('logSoftmax sums to 1 in probability space and is stable for big logits', () => {
    const lp = logSoftmax([1000, 1000, 1000], 3);
    expect(lp.reduce((s, v) => s + Math.exp(v), 0)).toBeCloseTo(1, 10);
  });
  it('topK skips -Infinity', () => {
    expect(topK(new Float64Array([0, -Infinity, 2, 1]), 5)).toEqual([2, 3, 0]);
  });
});
