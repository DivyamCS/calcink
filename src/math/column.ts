import { evaluate } from './evaluate.ts';
import { tokenizeLatex } from './latex.ts';

export type ColumnOp = '+' | '-' | '*' | '/';

export interface ColumnRow {
  op: ColumnOp | null;
  /** the number as written, e.g. "80", "2.5" */
  num: string;
}

const OPS: Readonly<Record<string, ColumnOp>> = {
  '+': '+',
  '-': '-',
  '−': '-',
  '\\times': '*',
  x: '*', // a handwritten × read as the letter x
  X: '*',
  '×': '*',
  '\\div': '/',
  '/': '/',
  '÷': '/',
};
const SKIP = new Set(['{', '}', '\\left', '\\right', ',']);

/** "+ 8 0" -> { op: "+", num: "80" }. Anything else (letters, two numbers, "=") is not a column row: null. */
export function parseRow(latex: string): ColumnRow | null {
  const tokens = tokenizeLatex(latex).filter((t) => !SKIP.has(t));
  if (tokens.length === 0) return null;
  let op: ColumnOp | null = null;
  let i = 0;
  if (OPS[tokens[0]]) {
    op = OPS[tokens[0]];
    i = 1;
  }
  // a dot is a decimal point here ("2·5", "·5")
  const rest = tokens.slice(i).map((t) => (t === '\\cdot' || t === '·' ? '.' : t));
  if (rest.length === 0 || !rest.every((t) => /^\d$/.test(t) || t === '.')) return null;
  const num = rest.join('');
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(num)) return null;
  return { op, num };
}

/**
 * Each row's sign applies to that row, top to bottom ("15 / + 30 / - 5" = 15 + 30 - 5). No sign means +.
 * "×" or "÷" on the first row has nothing to act on, so that is not a column.
 */
export function columnExpression(rows: readonly ColumnRow[]): string | null {
  if (rows.length < 2) return null;
  const head = rows[0].op;
  if (head === '*' || head === '/') return null;
  const first = head === '-' ? `(-${rows[0].num})` : `(${rows[0].num})`;
  return rows.slice(1).reduce((acc, r) => `(${acc}${r.op ?? '+'}(${r.num}))`, first);
}

export interface ColumnAnswer {
  expression: string;
  /** what to write under the line: a number, "Undefined" (÷ 0) or "?" */
  text: string;
  kind: 'value' | 'undefined' | 'error';
}

export function solveColumn(rows: readonly ColumnRow[]): ColumnAnswer | null {
  const expression = columnExpression(rows);
  if (expression === null) return null;
  const r = evaluate(expression);
  if (r.ok) return { expression, text: r.text, kind: 'value' };
  if (r.error === 'undefined') return { expression, text: 'Undefined', kind: 'undefined' };
  return { expression, text: '?', kind: 'error' };
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ColumnLine {
  id: string;
  bbox: Box;
  /** what the model read; undefined while the row is still waiting to be read */
  latex: string | undefined;
}

export interface Column {
  rule: Box;
  /** ids of the rows, top to bottom */
  rows: string[];
  /** right edge of the numbers (the answer is right-aligned to it, like the digits above) */
  right: number;
  /** null while a row is still being read */
  answer: ColumnAnswer | null;
  pending: boolean;
}

/** Columns on the page: at least two "[sign] number" rows stacked above a rule. */
export function findColumns(rules: readonly Box[], lines: readonly ColumnLine[], glyph: number): Column[] {
  const out: Column[] = [];
  for (const rule of rules) {
    const candidates = lines
      .filter((l) => l.bbox.maxY <= rule.minY + glyph * 0.4 && l.bbox.minX >= rule.minX - glyph * 1.4 && l.bbox.maxX <= rule.maxX + glyph * 0.6)
      .sort((a, b) => b.bbox.maxY - a.bbox.maxY); // nearest the rule first
    const rows: ColumnLine[] = [];
    let edge = rule.minY;
    for (const l of candidates) {
      const gap = edge - l.bbox.maxY;
      if (gap > glyph * (rows.length === 0 ? 1.6 : 1.3)) break;
      // a line that is not "[sign] number" (say "x = 5" written just above) ends the column; it keeps its own answer
      if (l.latex !== undefined && parseRow(l.latex) === null) break;
      rows.push(l);
      edge = l.bbox.minY;
      if (rows.length === 12) break;
    }
    if (rows.length < 2) continue;
    rows.reverse(); // top to bottom
    const pending = rows.some((r) => r.latex === undefined);
    const parsed = pending ? [] : rows.map((r) => parseRow(r.latex as string));
    const answer = pending ? null : solveColumn(parsed as ColumnRow[]);
    if (!pending && answer === null) continue; // e.g. "× 10" on the first row
    out.push({ rule, rows: rows.map((r) => r.id), right: Math.max(...rows.map((r) => r.bbox.maxX)), answer, pending });
  }
  return out;
}
