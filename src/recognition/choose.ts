import { compile } from '../math/evaluate.ts';
import { parseStatement } from '../math/latex.ts';
import type { Candidate, RecognizerOutput } from './types.ts';

/** How much worse (in length-normalised log-probability) an alternative may be and still be preferred. */
export const SCORE_MARGIN = 0.5;

/** 3 = valid with one "=", 2 = valid but extra "=" parts, 1 = no "=" yet, 0 = can't be calculated. */
export function usefulness(latex: string): number {
  const s = parseStatement(latex);
  if (s.kind === 'none') return 1;
  if (s.kind === 'unsupported') return 0;
  if (s.kind === 'equation') return compile(s.left).ok && compile(s.right).ok ? 3 : 0;
  if (!compile(s.expression).ok) return 0;
  const tokens = latex.split(/\s+/).filter(Boolean);
  const groups = tokens.filter((t, i) => t === '=' && tokens[i - 1] !== '=').length;
  return groups <= 1 || s.kind === 'assign' ? 3 : 2;
}

/** Lowest token probability, ignoring tokens after the final "=" and the end token. */
export function relevantConfidence(c: Candidate): number {
  const probs = c.tokenProbs;
  if (!probs || probs.length === 0) return c.confidence;
  const tokens = c.latex.split(/\s+/).filter(Boolean);
  const s = parseStatement(c.latex);
  let end = tokens.length; // exclusive; the EOS probability (if any) sits at index tokens.length
  if (s.kind === 'solve') {
    // the question is everything up to the first "=" (see latexToExpression); the rest is ignored
    const firstEq = tokens.indexOf('=');
    if (firstEq >= 0) end = firstEq + 1;
  }
  const used = probs.slice(0, Math.min(end, probs.length));
  return used.length > 0 ? Math.min(...used) : c.confidence;
}

export function chooseCandidate(out: RecognizerOutput): { latex: string; confidence: number | undefined } {
  const list: readonly Candidate[] = out.candidates ?? [];
  if (list.length === 0) return { latex: out.latex, confidence: out.confidence };
  const best = list[0];
  let pick = best;
  let pickUse = usefulness(best.latex);
  for (const c of list.slice(1)) {
    if (c.score < best.score - SCORE_MARGIN) break; // list is best-first
    const u = usefulness(c.latex);
    if (u > pickUse) {
      pick = c;
      pickUse = u;
    }
  }
  return { latex: pick.latex, confidence: relevantConfidence(pick) };
}
