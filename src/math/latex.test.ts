import { describe, expect, it } from 'vitest';
import { latexToExpression, tokenizeLatex } from './latex.ts';
import { evaluate } from './evaluate.ts';
import { solveLatex } from './solve.ts';

describe('tokenizeLatex', () => {
  it('splits spaced tokens', () => {
    expect(tokenizeLatex('1 8 + 4 \\times 3 =')).toEqual(['1', '8', '+', '4', '\\times', '3', '=']);
  });
  it('splits glued tokens', () => {
    expect(tokenizeLatex('12+4\\times3=')).toEqual(['1', '2', '+', '4', '\\times', '3', '=']);
  });
  it('returns [] for empty input', () => {
    expect(tokenizeLatex('')).toEqual([]);
  });
});

describe('latexToExpression: trigger rules', () => {
  it('solves only when the line ends with "="', () => {
    expect(latexToExpression('1 8 + 4 \\times 3 =')).toEqual({ kind: 'solve', expression: '18+4*3' });
  });
  it('shows nothing while the user has not written "=" yet', () => {
    expect(latexToExpression('1 8 + 4 \\times 3')).toEqual({ kind: 'none' });
  });
  it('shows nothing for an empty line', () => {
    expect(latexToExpression('')).toEqual({ kind: 'none' });
  });
  it('a bare "=" produces an empty expression (nothing to calculate)', () => {
    expect(latexToExpression('=')).toEqual({ kind: 'solve', expression: '' });
  });
  it('tolerates trailing braces after the equals sign', () => {
    expect(latexToExpression('2 + 2 = }')).toEqual({ kind: 'solve', expression: '2+2' });
  });
  it('with several "=", uses the segment before the first one (the model may invent a tail)', () => {
    expect(latexToExpression('2 + 3 = 5 + 1 =')).toEqual({ kind: 'solve', expression: '2+3' });
    expect(latexToExpression('8 + 8 + 8 = 8 =')).toEqual({ kind: 'solve', expression: '8+8+8' });
    expect(latexToExpression('1 1 1 \\times 2 = 1 \\times 1 =')).toEqual({ kind: 'solve', expression: '111*2' });
  });
});

describe('latexToExpression: symbol mapping', () => {
  it('maps \\times, x and * to multiplication', () => {
    for (const m of ['\\times', 'x', 'X', '*']) {
      expect(latexToExpression(`3 ${m} 4 =`)).toEqual({ kind: 'solve', expression: '3*4' });
    }
  });
  it('a dot between digits is a decimal point; next to a bracket it multiplies', () => {
    expect(latexToExpression('3 \\cdot 4 =')).toEqual({ kind: 'solve', expression: '3.4' });
    expect(latexToExpression('( 3 ) \\cdot ( 4 ) =')).toEqual({ kind: 'solve', expression: '(3)*(4)' });
  });
  it('maps \\div and / to division', () => {
    expect(latexToExpression('8 \\div 2 =')).toEqual({ kind: 'solve', expression: '8/2' });
    expect(latexToExpression('8 / 2 =')).toEqual({ kind: 'solve', expression: '8/2' });
  });
  it('maps unicode minus', () => {
    expect(latexToExpression('9 − 4 =')).toEqual({ kind: 'solve', expression: '9-4' });
  });
  it('keeps decimals and brackets', () => {
    expect(latexToExpression('( 2 . 5 + 1 ) \\times 2 =')).toEqual({
      kind: 'solve',
      expression: '(2.5+1)*2',
    });
  });
  it('handles \\left( \\right)', () => {
    expect(latexToExpression('\\left( 1 + 2 \\right) \\times 3 =')).toEqual({
      kind: 'solve',
      expression: '(1+2)*3',
    });
  });
  it('translates fractions', () => {
    expect(latexToExpression('\\frac { 1 } { 2 } =')).toEqual({
      kind: 'solve',
      expression: '((1)/(2))',
    });
  });
  it('translates exponents', () => {
    expect(latexToExpression('2 ^ { 3 } =')).toEqual({ kind: 'solve', expression: '2^(3)' });
    expect(latexToExpression('2 ^ 3 =')).toEqual({ kind: 'solve', expression: '2^(3)' });
  });
  it('a negative exponent written without braces (2 ^ - 1) keeps its sign', () => {
    expect(latexToExpression('2 ^ - 1 =')).toEqual({ kind: 'solve', expression: '2^(-1)' });
    expect(solveLatex('2 ^ - 1 =')).toMatchObject({ kind: 'value', text: '0.5' });
  });
  it('translates square roots and π', () => {
    expect(latexToExpression('\\sqrt { 4 } =')).toEqual({ kind: 'solve', expression: 'sqrt(4)' });
    expect(latexToExpression('2 \\pi =')).toEqual({ kind: 'solve', expression: '2π' });
  });
  it('flags symbols it cannot calculate', () => {
    expect(latexToExpression('\\int { 4 } =')).toEqual({ kind: 'unsupported', token: '\\int' });
    expect(latexToExpression('a + 1 =')).toEqual({ kind: 'unsupported', token: 'a' });
  });
  it('flags a fraction missing its arguments', () => {
    expect(latexToExpression('\\frac =')).toEqual({ kind: 'unsupported', token: '\\frac' });
  });
});

describe('latex -> expression -> evaluate (end to end, no model needed)', () => {
  const cases: Array<[string, string]> = [
    ['1 8 + 4 \\times 3 =', '30'],
    ['( 2 + 3 ) \\times 4 =', '20'],
    ['1 0 \\div 4 =', '2.5'],
    ['0 . 1 + 0 . 2 =', '0.3'],
    ['- 5 + 3 =', '-2'],
    ['\\frac { 3 } { 4 } =', '0.75'],
    ['2 ^ { 1 0 } =', '1024'],
    ['7 x 6 =', '42'],
  ];
  for (const [latex, expected] of cases) {
    it(`${latex}  ->  ${expected}`, () => {
      const parsed = latexToExpression(latex);
      expect(parsed.kind).toBe('solve');
      if (parsed.kind === 'solve') {
        const r = evaluate(parsed.expression);
        expect(r.ok && r.text).toBe(expected);
      }
    });
  }
});

describe('solveLatex: what the UI draws next to "="', () => {
  it('value', () => {
    expect(solveLatex('1 8 + 4 \\times 3 =')).toEqual({
      kind: 'value',
      text: '30',
      expression: '18+4*3',
    });
  });
  it('division by zero shows the "Undefined" indicator', () => {
    expect(solveLatex('5 \\div 0 =')).toEqual({
      kind: 'undefined',
      text: 'Undefined',
      expression: '5/0',
    });
  });
  it('malformed syntax shows "?" and never throws', () => {
    for (const latex of ['5 + =', '( 2 + 3 =', '\\times 4 =', '2 + + * 3 =', '1 . 2 . 3 =']) {
      const a = solveLatex(latex);
      expect(a.kind).toBe('error');
      if (a.kind === 'error') expect(a.text).toBe('?');
    }
  });
  it('unsupported symbols show "?" with a reason', () => {
    const a = solveLatex('\\int { 9 } =');
    expect(a.kind).toBe('error');
    if (a.kind === 'error') expect(a.reason).toContain('\\int');
  });
  it('overflow shows an infinity glyph', () => {
    const a = solveLatex('9 ^ { 9 9 9 } =');
    expect(a.kind).toBe('error');
    if (a.kind === 'error') expect(a.text).toBe('∞');
  });
  it('no equals sign -> no answer', () => {
    expect(solveLatex('1 + 1')).toEqual({ kind: 'none' });
  });
  it('a bare "=" -> no answer', () => {
    expect(solveLatex('=')).toEqual({ kind: 'none' });
  });

  it('ignores a stray dot or comma after the final "="', () => {
    expect(latexToExpression('1 5 + 4 = .')).toEqual({ kind: 'solve', expression: '15+4' });
    expect(latexToExpression('2 + 3 = ,')).toEqual({ kind: 'solve', expression: '2+3' });
  });

  it('treats a short phantom tail after "=" as noise (the model reading a stray "1")', () => {
    expect(latexToExpression('4 + 2 = 1')).toEqual({ kind: 'solve', expression: '4+2', check: '1' });
    expect(latexToExpression('4 + 2 = - 1')).toEqual({ kind: 'solve', expression: '4+2' });
  });
  it('a long tail after "=" is real input, not noise -> no answer', () => {
    expect(latexToExpression('4 + 2 = 6 + 7 + 8')).toEqual({ kind: 'none' });
  });

  it('collapses a doubled equals sign (each bar read separately)', () => {
    expect(latexToExpression('4 + 2 = =')).toEqual({ kind: 'solve', expression: '4+2' });
    expect(latexToExpression('4 + 2 = = 1')).toEqual({ kind: 'solve', expression: '4+2', check: '1' });
  });
});
