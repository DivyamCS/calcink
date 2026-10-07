/** Shape of `vocab.json` shipped with the CoMER INT8 model (113 LaTeX tokens). */
export interface Vocab {
  word2idx: Record<string, number>;
  idx2word: Record<string, string>;
  special_tokens: { pad: number; sos: number; eos: number };
  vocab_size: number;
}

/**
 * Symbol sets for the decoder:
 *  - arithmetic: digits, + - × ÷ . = brackets, fractions, powers
 *  - extended: arithmetic plus x, y, √, π, e, sin cos tan log (default)
 *  - full: the whole vocabulary, for debugging
 */
export type SymbolSet = 'arithmetic' | 'extended' | 'full';

const ARITHMETIC = [
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  '+', '-', '\\times', '\\div', '/', '\\cdot', '.', '=', '(', ')',
  '\\frac', '^', '{', '}',
];
const EXTENDED = [...ARITHMETIC, 'x', 'y', '\\sqrt', '\\pi', '\\sin', '\\cos', '\\tan', '\\log', 'e'];

export function symbolsFor(set: SymbolSet): readonly string[] | null {
  return set === 'full' ? null : set === 'extended' ? EXTENDED : ARITHMETIC;
}

/** Token ids allowed for a symbol set (null = no restriction). Unknown symbols are ignored. */
export function allowedIds(vocab: Vocab, set: SymbolSet): Set<number> | null {
  const symbols = symbolsFor(set);
  if (!symbols) return null;
  const ids = new Set<number>();
  for (const s of symbols) {
    const id = vocab.word2idx[s];
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

/** Token ids -> space separated LaTeX ("1 8 + 4 \times 3 ="), skipping special tokens. */
export function idsToLatex(ids: readonly number[], vocab: Vocab): string {
  const { sos, eos, pad } = vocab.special_tokens;
  const words: string[] = [];
  for (const id of ids) {
    if (id === sos || id === eos || id === pad) continue;
    const w = vocab.idx2word[String(id)];
    if (w !== undefined) words.push(w);
  }
  return words.join(' ');
}
