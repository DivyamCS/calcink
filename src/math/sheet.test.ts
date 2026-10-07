import { describe, expect, it } from 'vitest';
import { parseStatement } from './latex.ts';
import { solveSheet, type Answer } from './solve.ts';

const text = (a: Answer): string =>
  a.kind === 'value' || a.kind === 'assigned' || a.kind === 'undefined' || a.kind === 'error' ? a.text : a.kind;

describe('parseStatement', () => {
  it('a calculation', () => expect(parseStatement('1 + 2 =')).toEqual({ kind: 'solve', expression: '1+2' }));
  it('an assignment', () => {
    expect(parseStatement('x = 1 0')).toEqual({ kind: 'assign', name: 'x', expression: '10', show: false });
    expect(parseStatement('x = 3 + 4 =')).toEqual({ kind: 'assign', name: 'x', expression: '3+4', show: true });
    expect(parseStatement('y = 5')).toEqual({ kind: 'assign', name: 'y', expression: '5', show: false });
  });
  it('a plot: y in terms of x', () => {
    expect(parseStatement('y = x ^ { 2 }')).toEqual({ kind: 'plot', expression: 'x^(2)' });
    expect(parseStatement('y = 2 x + 1')).toEqual({ kind: 'plot', expression: '2x+1' });
  });
  it('"x =" asks for the value of x', () => expect(parseStatement('x =')).toEqual({ kind: 'solve', expression: 'x' }));
  it('x between two numbers is still a multiplication sign', () => {
    expect(parseStatement('3 x 4 =')).toEqual({ kind: 'solve', expression: '3*4' });
    expect(parseStatement('2 x + 1 =')).toEqual({ kind: 'solve', expression: '2x+1' });
  });
  it('the doubled "=" from two bars is collapsed for assignments too', () => {
    expect(parseStatement('x = = 5')).toEqual({ kind: 'assign', name: 'x', expression: '5', show: false });
  });
  it('unsupported symbols in an assignment', () => {
    expect(parseStatement('x = a')).toEqual({ kind: 'unsupported', token: 'a' });
  });
});

describe('solveSheet: variable memory, top to bottom', () => {
  it('x = 10 then x + 5 = 15', () => {
    const a = solveSheet(['x = 1 0', 'x + 5 =']);
    expect(a[0]).toMatchObject({ kind: 'assigned', name: 'x', text: '10', literal: true });
    expect(text(a[1])).toBe('15');
  });
  it('implicit multiplication with a variable (3x)', () => {
    expect(text(solveSheet(['x = 4', '3 x =', '2 x ^ { 2 } ='])[1])).toBe('12');
    expect(text(solveSheet(['x = 4', '2 x ^ { 2 } ='])[1])).toBe('32');
  });
  it('a variable is only known BELOW its definition', () => {
    const a = solveSheet(['x + 1 =', 'x = 2', 'x + 1 =']);
    expect(a[0]).toMatchObject({ kind: 'error', text: '?', reason: 'x has no value yet (write x = 5 on a line above)' });
    expect(text(a[2])).toBe('3');
  });
  it('redefinition applies from that line on', () => {
    const a = solveSheet(['x = 2', 'x =', 'x = x + 1', 'x =']);
    expect(text(a[1])).toBe('2');
    expect(text(a[3])).toBe('3');
  });
  it('changing a definition updates every answer that uses it', () => {
    expect(text(solveSheet(['x = 1 0', 'x \\times 2 ='])[1])).toBe('20');
    expect(text(solveSheet(['x = 2 0', 'x \\times 2 ='])[1])).toBe('40');
  });
  it('assignment with "=" shows the value', () => {
    expect(solveSheet(['x = 3 + 4 ='])[0]).toMatchObject({ kind: 'assigned', text: '7', show: true, literal: false });
  });
  it('two variables', () => expect(text(solveSheet(['x = 3', 'y = 4', 'x y + 1 ='])[2])).toBe('13'));
  it('division by zero in an assignment is Undefined and stores nothing', () => {
    const a = solveSheet(['x = 1 \\div 0', 'x =']);
    expect(a[0].kind).toBe('undefined');
    expect(a[1]).toMatchObject({ kind: 'error' });
  });
  it('big exact values survive a variable', () => {
    expect(text(solveSheet(['x = 9 9 9 9 9 9 9 9', 'x \\times x ='])[1])).toBe('9999999800000001');
  });
  it('lines that are not recognised yet are skipped', () => {
    const a = solveSheet(['x = 5', undefined, 'x + 1 =']);
    expect(a[1].kind).toBe('none');
    expect(text(a[2])).toBe('6');
  });
  it('a plot carries a runnable function', () => {
    const a = solveSheet(['y = x ^ { 2 } + 1'])[0];
    expect(a.kind).toBe('plot');
    if (a.kind === 'plot') {
      const env = new Map(a.env);
      env.set('x', { value: 3, big: null });
      expect(a.program.numeric(env)).toBe(10);
    }
  });
  it('square roots and π', () => {
    expect(text(solveSheet(['\\sqrt { 1 6 } ='])[0])).toBe('4');
    expect(text(solveSheet(['\\sqrt { - 4 } ='])[0])).toBe('Undefined');
    expect(text(solveSheet(['2 \\pi ='])[0])).toBe('6.283185307');
  });
});

describe('a handwritten "×" read as the letter x before a negative number', () => {
  it('5 × −3 read as "5 x - 3 =" gives −15 when x has no value', () => {
    expect(solveSheet(['5 x - 3 =']).map(text)).toEqual(['-15']);
    expect(solveSheet(['- 7 x - 2 =']).map(text)).toEqual(['14']);
    expect(solveSheet(['( 2 + 1 ) x - 4 =']).map(text)).toEqual(['-12']);
    expect(solveSheet(['8 x - 0 =']).map(text)).toEqual(['0']); // -0 prints as 0
  });
  it('keeps x as a variable when it has a value', () => {
    expect(solveSheet(['x = 10', '2 x - 1 =']).map(text)).toEqual(['10', '19']);
  });
  it('does not invent a product where none can be: "2 x + 1 =" without x still asks for x', () => {
    const [a] = solveSheet(['2 x + 1 =']);
    expect(a).toMatchObject({ kind: 'error', reason: 'x has no value yet (write x = 5 on a line above)' });
    expect(solveSheet(['x + 5 ='])[0]).toMatchObject({ kind: 'error', reason: 'x has no value yet (write x = 5 on a line above)' });
  });
});
