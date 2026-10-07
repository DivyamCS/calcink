import { describe, expect, it } from 'vitest';
import { handwrite } from '../../tests/e2e/handwriting.ts';
import { findRules, groupIntoLines, pointsBBox } from '../ink/geometry.ts';
import type { Stroke } from '../ink/types.ts';
import { columnExpression, findColumns, parseRow, solveColumn } from './column.ts';

describe('parseRow', () => {
  it.each([
    ['1 5', { op: null, num: '15' }],
    ['+ 8 0', { op: '+', num: '80' }],
    ['- 1 2', { op: '-', num: '12' }],
    ['\\times 4', { op: '*', num: '4' }],
    ['x 4', { op: '*', num: '4' }],
    ['\\div 5', { op: '/', num: '5' }],
    ['2 . 5', { op: null, num: '2.5' }],
  ])('%s', (latex, row) => expect(parseRow(latex)).toEqual(row));

  it.each(['', '+', '1 + 2', '1 5 =', 'x', '1 . 2 . 3', 'y 2'])('rejects %s', (latex) => expect(parseRow(latex)).toBeNull());
});

describe('solveColumn', () => {
  const rows = (...r: Array<[string | null, string]>) => r.map(([op, num]) => ({ op: op as never, num }));
  it('a tight column: 15 / 30 / + 80 = 125', () => {
    expect(solveColumn(rows([null, '15'], [null, '30'], ['+', '80']))).toMatchObject({ text: '125', kind: 'value' });
  });
  it('subtraction, multiplication, division, decimals', () => {
    expect(solveColumn(rows([null, '45'], ['-', '12']))?.text).toBe('33');
    expect(solveColumn(rows([null, '23'], ['*', '4']))?.text).toBe('92');
    expect(solveColumn(rows([null, '100'], ['/', '8']))?.text).toBe('12.5');
    expect(solveColumn(rows([null, '2.5'], ['+', '0.75'], ['+', '1.25']))?.text).toBe('4.5');
  });
  it('applies the sign of each row', () => {
    expect(solveColumn(rows([null, '100'], [null, '30'], ['-', '20']))?.text).toBe('110'); // 100 + 30 - 20
    expect(solveColumn(rows([null, '100'], ['-', '30'], ['-', '20']))?.text).toBe('50');
    expect(solveColumn(rows([null, '10'], ['-', '3'], ['+', '5'], ['-', '1']))?.text).toBe('11');
    expect(solveColumn(rows([null, '50'], ['+', '30'], ['-', '90']))?.text).toBe('-10');
  });
  it('a row without a sign adds', () => {
    expect(solveColumn(rows([null, '10'], [null, '20'], [null, '5']))?.text).toBe('35');
  });
  it('× or ÷ in front of the first row is not a column', () => {
    expect(solveColumn(rows(['*', '10'], ['+', '20']))).toBeNull();
  });
  it('rows apply top to bottom (no hidden precedence)', () => {
    expect(columnExpression(rows([null, '2'], ['+', '3'], ['*', '4']))).toBe('(((2)+(3))*(4))');
    expect(solveColumn(rows([null, '2'], ['+', '3'], ['*', '4']))?.text).toBe('20');
  });
  it('a negative first number, ÷ 0, and a single row', () => {
    expect(solveColumn(rows(['-', '5'], ['+', '8']))?.text).toBe('3');
    expect(solveColumn(rows([null, '5'], ['/', '0']))).toMatchObject({ kind: 'undefined', text: 'Undefined' });
    expect(solveColumn(rows([null, '5']))).toBeNull();
  });
  it('exact big numbers', () => {
    expect(solveColumn(rows([null, '99999999999999999'], ['+', '1']))?.text).toBe('100000000000000000');
  });
});

// geometry: the rule, the rows, and the columns found on a page

let id = 1;
const write = (text: string, x: number, y: number, size = 40): Stroke[] =>
  handwrite(text, { x, y, size, mess: 0 }).map((s) => ({ id: id++, lineWidth: 4, points: s.points.map((p) => ({ x: p.x, y: p.y })) }));
const rule = (x0: number, x1: number, y: number): Stroke => ({ id: id++, lineWidth: 4, points: [{ x: x0, y }, { x: (x0 + x1) / 2, y: y + 1 }, { x: x1, y }] });

/** A tight column: rows 48 px apart (only 8 px of white between them), operator on the last row, a rule under it. */
function tightColumnPage(): { strokes: Stroke[]; ruleStroke: Stroke } {
  const r = rule(70, 230, 205);
  return { strokes: [...write('15', 130, 50), ...write('30', 130, 98), ...write('+80', 90, 146), r], ruleStroke: r };
}

describe('findRules', () => {
  it('finds the line under a column', () => {
    const { strokes, ruleStroke } = tightColumnPage();
    expect(findRules(strokes)).toEqual([ruleStroke]);
  });
  it('a long minus inside a calculation is not a rule', () => {
    const strokes = [...write('12+3=', 50, 50), ...write('7', 50, 120), rule(85, 160, 140), ...write('2=', 170, 120)];
    expect(findRules(strokes)).toEqual([]);
  });
  it('a fraction bar (ink right under it) is not a rule', () => {
    const strokes = [...write('15', 100, 50), ...write('30', 100, 98), rule(90, 200, 150), ...write('4', 130, 160)];
    expect(findRules(strokes)).toEqual([]);
  });
  it('a scribble is not a rule', () => {
    const zig: Stroke = { id: id++, lineWidth: 4, points: Array.from({ length: 12 }, (_, i) => ({ x: 90 + (i % 2) * 120, y: 150 + i })) };
    expect(findRules([...write('15', 100, 50), ...write('30', 100, 98), zig])).toEqual([]);
  });
});

describe('rows above a rule are split even when written close together', () => {
  it('three rows, rule excluded', () => {
    const { strokes, ruleStroke } = tightColumnPage();
    const lines = groupIntoLines(strokes);
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => !l.strokes.includes(ruleStroke))).toBe(true);
  });
  it('rows merge normally without a rule', () => {
    const { strokes, ruleStroke } = tightColumnPage();
    expect(groupIntoLines(strokes.filter((s) => s !== ruleStroke)).length).toBeLessThan(3);
  });
});

describe('findColumns', () => {
  it('tight column sums to 125, right-aligned', () => {
    const { strokes, ruleStroke } = tightColumnPage();
    const lines = groupIntoLines(strokes);
    const latex = ['1 5', '3 0', '+ 8 0'];
    const cols = findColumns([pointsBBox(ruleStroke.points)], lines.map((l, i) => ({ id: l.id, bbox: l.bbox, latex: latex[i] })), 40);
    expect(cols).toHaveLength(1);
    expect(cols[0].answer?.text).toBe('125');
    expect(cols[0].rows).toHaveLength(3);
    expect(cols[0].right).toBeCloseTo(Math.max(...lines.map((l) => l.bbox.maxX)));
  });
  it('waits while a row is unread, and ignores a "column" of non-numbers', () => {
    const { strokes, ruleStroke } = tightColumnPage();
    const lines = groupIntoLines(strokes);
    const r = [pointsBBox(ruleStroke.points)];
    expect(findColumns(r, lines.map((l, i) => ({ id: l.id, bbox: l.bbox, latex: i === 1 ? undefined : '1' })), 40)[0].pending).toBe(true);
    expect(findColumns(r, lines.map((l) => ({ id: l.id, bbox: l.bbox, latex: 'x + 1 =' })), 40)).toEqual([]);
  });
});

describe('a column does not disturb writing around it', () => {
  it('an expression written right above a column keeps its "=" in one line; the rows are still split', () => {
    const eq = write('12+3=', 90, 0);
    const { strokes } = tightColumnPage();
    const lines = groupIntoLines([...eq, ...strokes]);
    const eqLine = lines.find((l) => l.strokes.includes(eq[0]));
    expect(eqLine?.strokes).toHaveLength(eq.length); // all of "12+3=", both bars of "=" included
    expect(lines).toHaveLength(4);
  });
  it('non-number line above ends the column', () => {
    const { strokes, ruleStroke } = tightColumnPage();
    const lines = groupIntoLines(strokes);
    const above = { id: 'above', bbox: { minX: 100, minY: lines[0].bbox.minY - 50, maxX: 200, maxY: lines[0].bbox.minY - 8 }, latex: 'x = 5' };
    const latex = ['1 5', '3 0', '+ 8 0'];
    const cols = findColumns([pointsBBox(ruleStroke.points)], [above, ...lines.map((l, i) => ({ id: l.id, bbox: l.bbox, latex: latex[i] }))], 40);
    expect(cols).toHaveLength(1);
    expect(cols[0].rows).not.toContain('above');
    expect(cols[0].answer?.text).toBe('125');
  });
  it('two separate columns side by side each get their own sum', () => {
    const left = tightColumnPage();
    const right = [...write('7', 560, 50), ...write('-2', 520, 98)];
    const r2 = rule(500, 620, 157);
    const lines = groupIntoLines([...left.strokes, ...right, r2]);
    expect(findRules([...left.strokes, ...right, r2])).toHaveLength(2);
    const latexOf = (l: { strokes: readonly Stroke[] }): string =>
      l.strokes.includes(right[0]) ? '7' : l.strokes.some((s) => right.includes(s)) ? '- 2' : ['1 5', '3 0', '+ 8 0'][lines.filter((x) => !x.strokes.some((s) => right.includes(s))).indexOf(l as never)];
    const cols = findColumns(
      [pointsBBox(left.ruleStroke.points), pointsBBox(r2.points)],
      lines.map((l) => ({ id: l.id, bbox: l.bbox, latex: latexOf(l) })),
      40,
    );
    expect(cols.map((c) => c.answer?.text)).toEqual(['125', '5']);
  });
});

describe('decimal dots in column rows', () => {
  it('"2 \\cdot 5" is 2.5 and a leading dot is 0.x', () => {
    expect(parseRow('2 \\cdot 5')).toEqual({ op: null, num: '2.5' });
    expect(parseRow('+ \\cdot 5')).toEqual({ op: '+', num: '.5' });
    expect(parseRow('\\cdot 7 5')).toEqual({ op: null, num: '.75' });
  });
});

describe('big writing on a phone', () => {
  it('a slightly tilted rule under big digits is still a rule (50 / +60 / −10)', () => {
    const big = 100;
    const strokes = [...write('50', 360, 470, big), ...write('+60', 280, 610, big), ...write('-10', 280, 760, big)];
    const tilted: Stroke = { id: id++, lineWidth: 4, points: Array.from({ length: 14 }, (_, i) => ({ x: 280 + i * 18.5, y: 910 - i * 2.4 })) };
    expect(findRules([...strokes, tilted])).toEqual([tilted]);
    expect(groupIntoLines([...strokes, tilted])).toHaveLength(3);
  });
  it('a steep stroke is not a rule', () => {
    const strokes = [...write('50', 360, 470, 100), ...write('+60', 280, 610, 100)];
    const steep: Stroke = { id: id++, lineWidth: 4, points: Array.from({ length: 10 }, (_, i) => ({ x: 280 + i * 24, y: 900 - i * 9 })) };
    expect(findRules([...strokes, steep])).toEqual([]);
  });
});
