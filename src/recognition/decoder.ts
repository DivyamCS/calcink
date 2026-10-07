// Beam search; the overall shape (log-softmax, vocab mask, length-normalised beams) follows ink-on's decoder (Apache-2.0).

// Differences from ink-on's decoder: it stops after 3 repeated tokens (so "10000" can't be read), and we also
// need per-token probabilities, cancellation, and all candidates instead of just the best one.

/** Runs the decoder for a prefix of token ids and returns the logits of the last position (length = vocab). */
export type StepFn = (ids: readonly number[]) => Promise<ArrayLike<number>>;

export interface DecodeOptions {
  sos: number;
  eos: number;
  vocabSize: number;
  beamWidth: number;
  maxSteps: number;
  /** Token ids the model may produce (EOS is always allowed). null = everything. */
  allowed: ReadonlySet<number> | null;
  /** End a hypothesis that repeats one token more than this many times in a row (runaway loop guard). */
  maxRepeat?: number;
  /** Polled between steps; return true to abandon the decode (result: []). */
  shouldStop?: () => boolean;
  /** Called between steps so a worker can process incoming messages (e.g. cancel). */
  yieldEvery?: () => Promise<void>;
  /** GNMT length penalty alpha: score = logProb / ((5 + len) / 6) ^ alpha. */
  lengthPenalty?: number;
}

export interface Candidate {
  /** token ids without sos/eos */
  ids: number[];
  /** sum of log-probabilities */
  logProb: number;
  /** probability of each emitted token (and of the final EOS) - for confidence */
  tokenProbs: number[];
  /** length-normalised score used for ranking */
  score: number;
}

export const DEFAULT_MAX_REPEAT = 12;
/** Chosen by measuring recognition accuracy in the browser test suite (tests/e2e/accuracy.spec.ts). */
export const DEFAULT_LENGTH_PENALTY = 0.6;

/** Numerically stable log-softmax of a logits row. */
export function logSoftmax(logits: ArrayLike<number>, size: number): Float64Array {
  let max = -Infinity;
  for (let i = 0; i < size; i++) if (logits[i] > max) max = logits[i];
  let sum = 0;
  for (let i = 0; i < size; i++) sum += Math.exp(logits[i] - max);
  const lse = Math.log(sum) + max;
  const out = new Float64Array(size);
  for (let i = 0; i < size; i++) out[i] = logits[i] - lse;
  return out;
}

/** Log-softmax over allowed tokens only, so a "9" that could be a "g" isn't marked as unsure. */
export function maskedLogSoftmax(
  logits: ArrayLike<number>,
  size: number,
  allowed: ReadonlySet<number> | null,
  eos: number,
): Float64Array {
  if (!allowed) return logSoftmax(logits, size);
  const ok = (i: number): boolean => i === eos || allowed.has(i);
  let max = -Infinity;
  for (let i = 0; i < size; i++) if (ok(i) && logits[i] > max) max = logits[i];
  let sum = 0;
  for (let i = 0; i < size; i++) if (ok(i)) sum += Math.exp(logits[i] - max);
  const lse = Math.log(sum) + max;
  const out = new Float64Array(size);
  for (let i = 0; i < size; i++) out[i] = ok(i) ? logits[i] - lse : -Infinity;
  return out;
}

/** Indices of the k largest finite values (descending). */
export function topK(values: Float64Array, k: number): number[] {
  const idx: number[] = [];
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) idx.push(i);
  idx.sort((a, b) => values[b] - values[a]);
  return idx.slice(0, k);
}

interface Beam {
  ids: number[]; // includes sos
  logProb: number;
  tokenProbs: number[];
  finished: boolean;
}

const lengthNorm = (len: number, alpha: number): number => Math.pow((5 + len) / 6, alpha);

function trailingRun(ids: readonly number[], token: number): number {
  let n = 0;
  for (let j = ids.length - 1; j >= 1 && ids[j] === token; j--) n++;
  return n;
}

/** Beam search (width 1 = greedy). Returns finished candidates best first. */
export async function beamSearch(step: StepFn, opts: DecodeOptions): Promise<Candidate[]> {
  const width = Math.max(1, Math.floor(opts.beamWidth));
  const maxRepeat = opts.maxRepeat ?? DEFAULT_MAX_REPEAT;
  const alpha = opts.lengthPenalty ?? DEFAULT_LENGTH_PENALTY;
  // ids include sos; a finished beam also "emitted" EOS
  const normScore = (b: Beam): number => b.logProb / lengthNorm(b.ids.length - 1 + (b.finished ? 1 : 0), alpha);
  let beams: Beam[] = [{ ids: [opts.sos], logProb: 0, tokenProbs: [], finished: false }];

  for (let s = 0; s < opts.maxSteps; s++) {
    if (opts.yieldEvery) await opts.yieldEvery();
    if (opts.shouldStop?.()) return [];

    const next: Beam[] = [];
    for (const beam of beams) {
      if (beam.finished) {
        next.push(beam);
        continue;
      }
      const lp = maskedLogSoftmax(await step(beam.ids), opts.vocabSize, opts.allowed, opts.eos);
      for (const tok of topK(lp, width * 2)) {
        const logProb = beam.logProb + lp[tok];
        const tokenProbs = [...beam.tokenProbs, Math.exp(lp[tok])];
        if (tok === opts.eos) {
          next.push({ ids: beam.ids, logProb, tokenProbs, finished: true });
        } else if (trailingRun(beam.ids, tok) >= maxRepeat) {
          // runaway loop ("0 0 0 0 ..."): close the hypothesis instead of extending it
          next.push({ ids: beam.ids, logProb, tokenProbs: beam.tokenProbs, finished: true });
        } else {
          next.push({ ids: [...beam.ids, tok], logProb, tokenProbs, finished: false });
        }
      }
    }
    next.sort((a, b) => normScore(b) - normScore(a));
    // de-duplicate (a finished beam can be reached twice) then keep the best `width`
    const seen = new Set<string>();
    beams = [];
    for (const b of next) {
      const key = `${b.finished ? 'F' : 'O'}${b.ids.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      beams.push(b);
      if (beams.length === width) break;
    }
    if (beams.every((b) => b.finished)) break;
  }

  const done = beams.filter((b) => b.finished);
  const pool = (done.length > 0 ? done : beams).slice().sort((a, b) => normScore(b) - normScore(a));
  return pool.map((b) => ({ ids: b.ids.slice(1), logProb: b.logProb, tokenProbs: b.tokenProbs, score: normScore(b) }));
}

/** Confidence = probability of the least certain token (one bad digit should show up). */
export function confidenceOf(c: Candidate): number {
  if (c.tokenProbs.length === 0) return 0;
  return Math.min(...c.tokenProbs);
}
