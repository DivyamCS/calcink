import { describe, expect, it } from 'vitest';
import { formatExpressionForDisplay, formatStatementForDisplay } from './display.ts';
import { evaluate } from './evaluate.ts';

const f = (e: string): string => formatStatementForDisplay(e);

describe('formatExpressionForDisplay', () => {
  it('adds spaces and real operator signs', () => {
    expect(f('15+4')).toBe('15 + 4 =');
    expect(f('18+4*3')).toBe('18 + 4 × 3 =');
    expect(f('32/4')).toBe('32 ÷ 4 =');
    expect(f('9-2')).toBe('9 − 2 =');
  });
  it('keeps decimals together', () => expect(f('2.5+1')).toBe('2.5 + 1 ='));
  it('a leading minus is a sign, not a subtraction', () => {
    expect(f('-5+3')).toBe('−5 + 3 =');
    expect(f('2*-3')).toBe('2 × −3 =');
  });
  it('keeps real brackets but removes ones around a single number', () => {
    expect(f('(1+2)*3')).toBe('(1 + 2) × 3 =');
    expect(f('((1)/(2))+1')).toBe('(1 ÷ 2) + 1 =');
    expect(f('((1)/(2))')).toBe('1 ÷ 2 =');
  });
  it('keeps brackets that mean multiplication', () => {
    expect(f('2(3)4')).toBe('2(3)4 =');
    expect(f('(2+3)(4)')).toBe('(2 + 3)(4) =');
    expect(f('(4)(5)')).toBe('(4)(5) =');
    expect(f('3-(-2)')).toBe('3 − (−2) =');
  });
  it('the tidy text always means the same as the expression', () => {
    // read the display back (× ÷ - are understood by the evaluator) and compare results
    for (const e of ['2(3)4', '(2+3)(4)', '((6)/(3))*2', '7/((1)/(2))', '3-(-2)', '-2^(2)', '(1+2)*3', '2*-3']) {
      const shown = formatExpressionForDisplay(e).replace(/(\d)([²³⁴])/g, '$1^$2').replace(/²/g, '2').replace(/³/g, '3');
      const a = evaluate(e);
      const b = evaluate(shown);
      expect(b.ok && b.text, `${e} shown as ${shown}`).toBe(a.ok && a.text);
    }
  });
  it('powers become superscripts when simple', () => {
    expect(f('2^(10)')).toBe('2¹⁰ =');
    expect(f('2^3')).toBe('2³ =');
    expect(f('2^(-1)')).toBe('2⁻¹ =');
    expect(f('2^(1+1)')).toBe('2^(1 + 1) =');
  });
  it('square roots, π and variables', () => {
    expect(f('sqrt(9)+1')).toBe('√(9) + 1 =');
    expect(f('2π')).toBe('2π =');
    expect(formatStatementForDisplay('x^(2)+1', 'y', false)).toBe('y = x² + 1');
    expect(formatStatementForDisplay('10', 'x', false)).toBe('x = 10');
  });
  it('big numbers are not changed', () => expect(f('9999*10000')).toBe('9999 × 10000 ='));
});

describe('prettyReading: the status line shows what was read in plain symbols', () => {
  it('turns model tokens into readable text', async () => {
    const { prettyReading } = await import('./display.ts');
    expect(prettyReading('1 8 + 4 \\times 3 =')).toBe('18 + 4 × 3 =');
    expect(prettyReading('9 \\div 0 =')).toBe('9 ÷ 0 =');
    expect(prettyReading('3 . 5 + 1 . 2 5 =')).toBe('3.5 + 1.25 =');
    expect(prettyReading('x ^ { 2 }')).toBe('x^{2}');
  });
});
