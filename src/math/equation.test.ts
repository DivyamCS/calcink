import { describe, expect, it } from 'vitest';
import { formatStatementForDisplay } from './display.ts';
import { parseStatement } from './latex.ts';
import { solveLatex, solveSheet, solutionText, type Answer } from './solve.ts';

const kind = (a: Answer): string => a.kind;

describe('functions in handwriting', () => {
  it('"sin x" without brackets, "2 sin x", "sin 2 x", "sin ( x )"', () => {
    expect(parseStatement('y = \\sin x')).toEqual({ kind: 'plot', expression: 'sin(x)' });
    expect(parseStatement('y = 2 \\sin x')).toEqual({ kind: 'plot', expression: '2sin(x)' });
    expect(parseStatement('y = \\sin 2 x')).toEqual({ kind: 'plot', expression: 'sin(2x)' });
    expect(parseStatement('y = \\sin ( x ) + 1')).toEqual({ kind: 'plot', expression: 'sin(x)+1' });
    expect(parseStatement('y = \\sin x \\cos x')).toEqual({ kind: 'plot', expression: 'sin(x)cos(x)' });
    expect(parseStatement('y = e ^ { x }')).toEqual({ kind: 'plot', expression: 'e^(x)' });
    expect(parseStatement('y = \\log x')).toEqual({ kind: 'plot', expression: 'log(x)' });
  });

  it('calculations with functions', () => {
    expect(solveLatex('\\sin ( 0 ) =')).toMatchObject({ kind: 'value', text: '0' });
    expect(solveLatex('\\log 1 0 0 =')).toMatchObject({ kind: 'value', text: '2' });
    expect(solveLatex('2 \\cos 0 =')).toMatchObject({ kind: 'value', text: '2' });
    expect(solveLatex('\\log 0 =')).toMatchObject({ kind: 'undefined' });
  });

  it('a lone function name is not a calculation', () => {
    expect(kind(solveLatex('\\sin ='))).toBe('error');
  });

  it('displays nicely', () => {
    expect(formatStatementForDisplay('2sin(x)', 'y', false)).toBe('y = 2sin(x)');
    expect(formatStatementForDisplay('e^(x)', 'y', false)).toBe('y = e^x');
  });
});

describe('equations in x and y -> a curve', () => {
  it.each([
    ['x ^ { 2 } + y ^ { 2 } = 2 5', 'x^(2)+y^(2)', '25'],
    ['x = \\sin y', 'x', 'sin(y)'],
    ['y e ^ { x } = 1', 'ye^(x)', '1'],
    ['\\sin x = \\cos y', 'sin(x)', 'cos(y)'],
    ['y = y ^ { 2 } - x', 'y', 'y^(2)-x'],
  ])('%s', (latex, left, right) => {
    expect(parseStatement(latex)).toEqual({ kind: 'equation', left, right });
    expect(kind(solveLatex(latex))).toBe('curve');
  });

  it('y = f(x) is still the ordinary function graph', () => {
    expect(kind(solveLatex('y = x ^ { 2 }'))).toBe('plot');
    expect(kind(solveLatex('y = \\tan x'))).toBe('plot');
  });
});

describe('equations in one unknown -> solved', () => {
  it('2x + 4 = 10 gives x = 3', () => {
    expect(solveLatex('2 x + 4 = 1 0')).toMatchObject({ kind: 'solved', variable: 'x', solutions: [3], text: 'x = 3' });
  });
  it('sin x = x / 2 gives three solutions', () => {
    const a = solveLatex('\\sin x = \\frac { x } { 2 }');
    expect(a.kind).toBe('solved');
    if (a.kind !== 'solved') return;
    expect(a.solutions).toHaveLength(3);
    expect(a.text).toBe('x ≈ −1.895, 0, 1.895');
  });
  it('x² = 2 gives ±√2, x² = -1 has no real solution', () => {
    const a = solveLatex('x ^ { 2 } = 2');
    expect(a.kind === 'solved' && a.solutions.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([-1.414214, 1.414214]);
    expect(solveLatex('x ^ { 2 } = - 1')).toMatchObject({ kind: 'solved', solutions: [], text: 'no real solution' });
  });
  it('tan x = 0 near the poles: only real zeros', () => {
    const a = solveLatex('\\tan x = 0');
    expect(a.kind === 'solved' && a.solutions.every((v) => Math.abs(Math.tan(v)) < 1e-6)).toBe(true);
  });
  it('an equation in y alone is solved for y', () => {
    expect(solveLatex('3 y = 1 2')).toMatchObject({ kind: 'solved', variable: 'y', text: 'y = 4' });
  });
  it('x = x + 1 after x = 2 is still an update, not an equation', () => {
    const a = solveSheet(['x = 2', 'x = x + 1', 'x =']);
    expect(a[2]).toMatchObject({ kind: 'value', text: '3' });
  });
  it('x = x^2 - 2 is solved (x appears on both sides)', () => {
    expect(solveLatex('x = x ^ { 2 } - 2')).toMatchObject({ kind: 'solved', text: 'x = −1, 2' });
  });
});

describe('variables still work, phantom digits after "=" do not create equations', () => {
  it('x = 10 then x + 5 = 5 (a phantom "5" after "=") still calculates x + 5', () => {
    const [, b] = solveSheet(['x = 1 0', 'x + 5 = 5']);
    expect(b).toMatchObject({ kind: 'value', text: '15' });
  });
  it('a multiplication sign read as "x" between numbers is not a variable', () => {
    expect(solveLatex('5 x 3 = 1')).toMatchObject({ kind: 'value', text: '15' });
  });
  it('a known x in a curve equation leaves only y free: solved for y', () => {
    const [, b] = solveSheet(['x = 3', 'x + y = 1 0']);
    expect(b).toMatchObject({ kind: 'solved', variable: 'y', text: 'y = 7' });
  });
  it('"5 × −3 =" read as "5 x - 3 = = 5" (doubled "=", phantom digit) is a calculation, not an equation', () => {
    expect(solveLatex('5 x - 3 = = 5')).toMatchObject({ kind: 'value', text: '-15' });
    expect(solveLatex('- 7 x - 2 = =')).toMatchObject({ kind: 'value', text: '14' });
    expect(parseStatement('x + 5 = = x')).toMatchObject({ kind: 'solve', expression: 'x+5' });
  });
  it('a real equation with a single "=" is still solved', () => {
    expect(solveLatex('5 x - 3 = 7')).toMatchObject({ kind: 'solved', text: 'x = 2' });
    expect(solveLatex('3 x = 6')).toMatchObject({ kind: 'solved', text: 'x = 2' });
  });
  it('plain arithmetic is untouched', () => {
    expect(solveLatex('1 8 + 4 \\times 3 = = 5')).toMatchObject({ kind: 'value', text: '30' });
  });
});

describe('solutionText', () => {
  it('formats exact, approximate and many solutions', () => {
    expect(solutionText('x', [3])).toBe('x = 3');
    expect(solutionText('x', [-2, 2])).toBe('x = −2, 2');
    expect(solutionText('x', [0.3333333333])).toBe('x ≈ 0.3333');
    expect(solutionText('x', [1, 2, 3, 4, 5])).toBe('x = 1, 2, 3, 4, …');
    expect(solutionText('x', [])).toBe('no real solution');
  });
});

describe('y = f(x) is a formula usable further down', () => {
  it('x = 3 below y = x² makes y = 9, and y + 1 = 10', () => {
    const a = solveSheet(['y = x ^ { 2 }', 'x = 3', 'y =', 'y + 1 =']);
    expect(a[0].kind).toBe('plot');
    expect(a[2]).toMatchObject({ kind: 'value', text: '9' });
    expect(a[3]).toMatchObject({ kind: 'value', text: '10' });
  });
  it('changing x changes y', () => {
    expect(solveSheet(['y = 2 x + 1', 'x = 1 0', 'y ='])[2]).toMatchObject({ text: '21' });
    expect(solveSheet(['y = 2 x + 1', 'x = 1 0', 'y =', 'x = 0', 'y ='])[4]).toMatchObject({ text: '1' });
  });
  it('before x has a value, y has none', () => {
    expect(solveSheet(['y = x ^ { 2 }', 'y ='])[1].kind).toBe('error');
  });
  it('an explicit y = 5 replaces the formula', () => {
    expect(solveSheet(['y = x ^ { 2 }', 'y = 5', 'x = 3', 'y ='])[3]).toMatchObject({ text: '5' });
  });
  it('with x known before the formula, y is available right away', () => {
    expect(solveSheet(['x = 4', 'y = x ^ { 2 }', 'y ='])[2]).toMatchObject({ text: '16' });
  });
});

describe('a dot before a digit is a decimal point, not multiplication', () => {
  it.each([
    ['2 \\cdot 5 + 1 =', '3.5'],
    ['1 2 \\cdot 5 \\times 2 =', '25'],
    ['\\cdot 5 + \\cdot 2 5 =', '0.75'],
    ['3 - \\cdot 5 =', '2.5'],
    ['( 1 \\cdot 5 ) \\times 2 =', '3'],
  ])('%s -> %s', (latex, text) => {
    expect(solveLatex(latex)).toMatchObject({ kind: 'value', text });
  });
  it('a dot between a number and a letter or bracket is still multiplication', () => {
    expect(solveSheet(['x = 4', '3 \\cdot x ='])[1]).toMatchObject({ kind: 'value', text: '12' });
    expect(solveLatex('( 2 ) \\cdot ( 3 ) =')).toMatchObject({ kind: 'value', text: '6' });
    expect(solveSheet(['x = 4', 'x \\cdot 2 ='])[1]).toMatchObject({ kind: 'value', text: '8' });
  });
  it('a second dot in one number is multiplication again (2.5·2 = 5)', () => {
    expect(solveLatex('2 . 5 \\cdot 2 =')).toMatchObject({ kind: 'value', text: '5' });
  });
  it('the status line shows the decimal point', async () => {
    const { prettyReading } = await import('./display.ts');
    expect(prettyReading('2 \\cdot 5 + 1 =')).toBe('2.5 + 1 =');
    expect(prettyReading('3 \\cdot x =')).toBe('3 · x =');
  });
});

describe('edge cases: rounding noise, double roots, underflow', () => {
  it('rounding noise is not printed: 0.1×3 − 0.3 = 0', () => {
    expect(solveLatex('0 . 1 \\times 3 - 0 . 3 =')).toMatchObject({ kind: 'value', text: '0' });
    expect(solveLatex('1 . 1 - 1 - 0 . 1 =')).toMatchObject({ kind: 'value', text: '0' });
    expect(solveLatex('0 . 1 + 0 . 2 =')).toMatchObject({ kind: 'value', text: '0.3' });
  });
  it('a double root is solved; e^x = 0 has no solution', () => {
    expect(solveLatex('9 x ^ { 2 } - 6 x + 1 = 0')).toMatchObject({ kind: 'solved', text: 'x ≈ 0.3333' });
    expect(solveLatex('e ^ { x } = 0')).toMatchObject({ kind: 'solved', solutions: [], text: 'no real solution' });
  });
});

describe('functions: decimals, powers, roots without braces', () => {
  it('sin 0·5 (no brackets) is sin 0.5', () => {
    expect(solveLatex('\\sin 0 \\cdot 5 =')).toMatchObject({ kind: 'value', text: '0.4794255386' });
  });
  it('sin² x = (sin x)²', () => {
    expect(solveLatex('\\sin ^ { 2 } 0 + \\cos ^ { 2 } 0 =')).toMatchObject({ kind: 'value', text: '1' });
    expect(solveSheet(['x = 2', '\\sin ^ { 2 } x + \\cos ^ { 2 } x ='])[1]).toMatchObject({ kind: 'value', text: '1' });
  });
  it('√16 without braces is 4', () => {
    expect(solveLatex('\\sqrt 1 6 =')).toMatchObject({ kind: 'value', text: '4' });
    expect(solveLatex('\\sqrt { 1 6 } + 1 =')).toMatchObject({ kind: 'value', text: '5' });
  });
  it('sin(x) with brackets, unclosed bracket is an error', () => {
    expect(parseStatement('y = \\sin ( x ) + 1')).toEqual({ kind: 'plot', expression: 'sin(x)+1' });
    expect(solveLatex('\\sin ( 0 =').kind).toBe('error');
  });
});

describe('"2x(…)": the variable when x has a value, a × sign otherwise', () => {
  it('x = 3 then 2x(1+1) = 12; without x it is 2 × (1+1) = 4', () => {
    expect(solveSheet(['x = 3', '2 x ( 1 + 1 ) ='])[1]).toMatchObject({ kind: 'value', text: '12' });
    expect(solveLatex('2 x ( 1 + 1 ) =')).toMatchObject({ kind: 'value', text: '4' });
    expect(solveLatex('2 . 5 x ( 8 - 3 ) =')).toMatchObject({ kind: 'value', text: '12.5' });
  });
  it('displays as a multiplication', async () => {
    const { formatStatementForDisplay } = await import('./display.ts');
    expect(formatStatementForDisplay('2×(1+1)')).toBe('2 × (1 + 1) =');
  });
});

describe('edge cases: implicit products, inverse functions, bare roots', () => {
  it('2x(x+1) is 2·x·(x+1) even before x has a value', () => {
    expect(solveLatex('2 x ( x + 1 ) = 4')).toMatchObject({ kind: 'solved', text: 'x = −2, 1' });
    expect(solveSheet(['y = 2 x ( x + 1 )', 'x = 2', 'y ='])[2]).toMatchObject({ kind: 'value', text: '12' });
    expect(solveLatex('2 x ( 1 + 1 ) =')).toMatchObject({ kind: 'value', text: '4' }); // still a × sign
  });
  it('a × read as x before a fraction stays a × sign even with x defined', () => {
    expect(solveSheet(['x = 2', '3 x \\frac { 1 } { 2 } ='])[1]).toMatchObject({ kind: 'value', text: '1.5' });
  });
  it('sin⁻¹ is not silently 1/sin', () => {
    expect(solveLatex('\\sin ^ { - 1 } ( 0 \\cdot 5 ) =').kind).toBe('error');
  });
  it('√1·44 without braces is √1.44', () => {
    expect(solveLatex('\\sqrt 1 \\cdot 4 4 =')).toMatchObject({ kind: 'value', text: '1.2' });
  });
  it('x² + 1e-12 = 0 has no real solution (no false touching root)', () => {
    expect(solveLatex('x ^ { 2 } + 0 . 0 0 0 0 0 0 0 0 0 0 0 1 = 0')).toMatchObject({ kind: 'solved', solutions: [] });
  });
});

describe('fixes from the team review', () => {
  it('2x = 2x is true for every x', () => {
    expect(solveLatex('2 x = 2 x')).toMatchObject({ kind: 'solved', text: 'true for every x' });
  });
  it('finds roots beyond 1000 (x² = 1000001)', () => {
    expect(solveLatex('x ^ { 2 } = 1 0 0 0 0 0 1')).toMatchObject({ text: 'x ≈ −1000.0005, 1000.0005' });
  });
  it('a short exact decimal is shown with "="', () => {
    expect(solveLatex('1 0 0 0 x = 1')).toMatchObject({ text: 'x = 0.001' });
    expect(solveLatex('4 x = 1 0')).toMatchObject({ text: 'x = 2.5' });
  });
  it('with many solutions the ones nearest 0 come first', () => {
    expect(solveLatex('\\sin x = 0 . 5')).toMatchObject({ text: 'x ≈ 0.5236, 2.618, −3.665, −5.76, …' });
  });
  it('a number written after "=" is ticked when it is the right answer', () => {
    expect(solveLatex('3 = 3')).toMatchObject({ kind: 'value', text: '✓' });
    expect(solveLatex('2 + 2 = 4')).toMatchObject({ kind: 'value', text: '✓' });
    // otherwise the part after "=" is treated as a misread and the left side is calculated
    expect(solveLatex('8 + 8 = 1')).toMatchObject({ kind: 'value', text: '16' });
  });
  it('e^x = 0 still has no solution with the wider search', () => {
    expect(solveLatex('e ^ { x } = 0')).toMatchObject({ solutions: [] });
  });
});
