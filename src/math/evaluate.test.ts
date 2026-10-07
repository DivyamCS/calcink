import { describe, expect, it } from 'vitest';
import { compile, evaluate, formatNumber } from './evaluate.ts';

/** Helper: evaluate and return the printable text, or the error code. */
function run(input: string): string {
  const r = evaluate(input);
  return r.ok ? r.text : `ERR:${r.error}`;
}

describe('evaluate: BODMAS / PEMDAS order of operations', () => {
  it('multiplies before adding (18+4×3)', () => {
    expect(run('18+4*3')).toBe('30');
  });
  it('divides before subtracting', () => {
    expect(run('10-6/2')).toBe('7');
  });
  it('brackets override precedence', () => {
    expect(run('(2+3)*4')).toBe('20');
    expect(run('2*(3+4)*5-6/3')).toBe('68');
  });
  it('is left-associative for - and /', () => {
    expect(run('7-3-2')).toBe('2');
    expect(run('8/4/2')).toBe('1');
    expect(run('100/10*2')).toBe('20');
  });
  it('powers are right-associative and bind tighter than * /', () => {
    expect(run('2^3^2')).toBe('512');
    expect(run('2*3^2')).toBe('18');
  });
  it('handles nested brackets', () => {
    expect(run('((1+2)*(3+4))-1')).toBe('20');
  });
});

describe('evaluate: numbers', () => {
  it('multi-digit integers', () => {
    expect(run('123+456')).toBe('579');
    expect(run('99999999999*9')).toBe('899999999991');
  });
  it('decimals', () => {
    expect(run('2.5*4')).toBe('10');
    expect(run('.5+.5')).toBe('1');
    expect(run('5.')).toBe('5');
  });
  it('floating-point noise is hidden (0.1+0.2 shows 0.3)', () => {
    expect(run('0.1+0.2')).toBe('0.3');
    expect(run('1.1*1.1')).toBe('1.21');
  });
  it('non-terminating results are rounded to 10 significant digits', () => {
    expect(run('1/3')).toBe('0.3333333333');
    expect(run('10/4')).toBe('2.5');
  });
  it('never prints negative zero', () => {
    expect(run('0*-1')).toBe('0');
    expect(formatNumber(-0)).toBe('0');
  });
});

describe('evaluate: negative numbers and unary operators', () => {
  it('leading minus', () => {
    expect(run('-5+3')).toBe('-2');
  });
  it('minus after an operator', () => {
    expect(run('2*-3')).toBe('-6');
    expect(run('2--3')).toBe('5');
    expect(run('3-(-2)')).toBe('5');
  });
  it('double negation and unary plus', () => {
    expect(run('--5')).toBe('5');
    expect(run('+5')).toBe('5');
    expect(run('2*+3')).toBe('6');
  });
  it('unary minus binds looser than ^ (-2^2 = -4) but tighter than *', () => {
    expect(run('-2^2')).toBe('-4');
    expect(run('(-2)^2')).toBe('4');
    expect(run('-2*3')).toBe('-6');
  });
  it('negative exponents', () => {
    expect(run('2^-2')).toBe('0.25');
  });
});

describe('evaluate: implicit multiplication', () => {
  it('number next to a bracket', () => {
    expect(run('2(3+4)')).toBe('14');
  });
  it('bracket next to bracket', () => {
    expect(run('(1+2)(3+4)')).toBe('21');
  });
  it('bracket followed by number', () => {
    expect(run('(1+2)3')).toBe('9');
  });
});

describe('evaluate: alternative glyphs', () => {
  it('accepts × ÷ − as emitted by recognisers and keyboards', () => {
    expect(run('6×7')).toBe('42');
    expect(run('8÷2')).toBe('4');
    expect(run('9−4')).toBe('5');
  });
  it('ignores whitespace', () => {
    expect(run('  1 +  2 ')).toBe('3');
  });
});

describe('evaluate: undefined results (division by zero & friends)', () => {
  it('x / 0 is undefined', () => {
    expect(run('5/0')).toBe('ERR:undefined');
  });
  it('0 / 0 is undefined', () => {
    expect(run('0/0')).toBe('ERR:undefined');
  });
  it('division by a zero-valued sub-expression is undefined', () => {
    expect(run('1/(2-2)')).toBe('ERR:undefined');
    expect(run('4/0.0')).toBe('ERR:undefined');
  });
  it('zero in the numerator is fine', () => {
    expect(run('0/5')).toBe('0');
  });
  it('0 to a negative power is undefined', () => {
    expect(run('0^-1')).toBe('ERR:undefined');
  });
  it('even root of a negative (fractional power) is undefined', () => {
    expect(run('(-8)^0.5')).toBe('ERR:undefined');
  });
  it('carries the human message "Undefined"', () => {
    const r = evaluate('1/0');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe('Undefined');
  });
});

describe('evaluate: overflow', () => {
  it('reports results beyond the double range instead of Infinity', () => {
    expect(run('9^999')).toBe('ERR:overflow');
    expect(run('99999999999^99999999999')).toBe('ERR:overflow');
  });
});

describe('evaluate: malformed syntax never throws', () => {
  const bad = [
    '5+',
    '*5',
    '5**3',
    '5*/3',
    '(2+3',
    '2+3)',
    '()',
    '(',
    ')',
    '1.2.3',
    '.',
    '2 3',
    '2+*3',
    '^2',
    'abc',
    '1e5',
    '2,5',
    '5 = 5',
    '((',
    '2+(3*)',
  ];
  for (const input of bad) {
    it(`rejects ${JSON.stringify(input)} with a syntax error`, () => {
      expect(run(input)).toBe('ERR:syntax');
    });
  }
  it('empty and blank input is "empty", not a crash', () => {
    expect(run('')).toBe('ERR:empty');
    expect(run('   ')).toBe('ERR:empty');
  });
});

describe('evaluate: safe by construction (no dynamic code execution)', () => {
  const attacks = [
    'process.exit(1)',
    'alert(1)',
    '1;globalThis.hacked=1',
    'constructor.constructor("return 1")()',
    '__proto__',
    '`${1+1}`',
    'require("fs")',
    '2+2//comment',
  ];
  for (const input of attacks) {
    it(`treats ${JSON.stringify(input)} as plain (invalid) text`, () => {
      expect(run(input)).toBe('ERR:syntax');
      expect((globalThis as Record<string, unknown>).hacked).toBe(undefined);
    });
  }
  it('never throws, whatever the input', () => {
    const noise = ['\0', '💥', '‮5+5', '9'.repeat(5000), '('.repeat(2000), '-'.repeat(3000) + '1'];
    for (const input of noise) {
      expect(() => evaluate(input)).not.toThrow();
    }
  });
});

describe('big whole numbers stay exact (BigInt side-calculation)', () => {
  it('9999 x 10000', () => expect(run('9999*10000')).toBe('99990000'));
  it('product beyond 2^53 is exact, not rounded', () => {
    expect(run('99999999*99999999')).toBe('9999999800000001');
    expect(run('123456789*987654321')).toBe('121932631112635269');
  });
  it('powers and sums beyond 2^53', () => {
    expect(run('2^100')).toBe('1267650600228229401496703205376');
    expect(run('9007199254740992+1')).toBe('9007199254740993');
  });
  it('negative big results', () => expect(run('0-99999999*99999999')).toBe('-9999999800000001'));
  it('exact division stays exact, inexact falls back to a rounded decimal', () => {
    expect(run('99999999999999999999/3')).toBe('33333333333333333333');
    expect(run('1/3')).toBe('0.3333333333');
  });
  it('decimals never use the exact path', () => expect(run('0.1+0.2')).toBe('0.3'));
  it('beyond the exact limit gives an approximate number, not a crash', () => {
    expect(run('2^200')).toBe('1.606938044e+60');
  });
  it('integers between 1e15 and 2^53 are printed in full', () => expect(run('1234567890123456+1')).toBe('1234567890123457'));
  it('division by zero is still undefined with big numbers', () => expect(run('99999999999999999999/0')).toBe('ERR:undefined'));
});

describe('large decimal answers keep their digits (regression)', () => {
  it('1234567890123.5 + 1 is not rounded to 1234567890000', () => {
    expect(run('1234567890123.5+1')).toBe('1234567890124.5');
  });
  it('still hides double noise and still rounds non-terminating decimals', () => {
    expect(run('0.1+0.2')).toBe('0.3');
    expect(run('1/3')).toBe('0.3333333333');
    expect(run('100000/3')).toBe('33333.33333');
  });
  it('approximate values beyond 2^53 use scientific notation', () => {
    expect(run('10^20+0.5')).toBe('1e+20');
  });
});

describe('variables, sqrt and π', () => {
  const env = new Map([['x', { value: 10, big: 10n }]]);
  it('uses variable values', () => {
    expect(evaluate('x+5', env)).toMatchObject({ ok: true, text: '15' });
    expect(evaluate('2x', env)).toMatchObject({ ok: true, text: '20' });
    expect(evaluate('x(x+1)', env)).toMatchObject({ ok: true, text: '110' });
  });
  it('an unknown variable is a typed error, not a crash', () => {
    expect(evaluate('y+1', env)).toMatchObject({ ok: false, error: 'unknown', name: 'y' });
  });
  it('only x and y are variables', () => {
    expect(run('a+1')).toBe('ERR:syntax');
    expect(run('x2')).toBe('ERR:syntax');
  });
  it('sqrt and π', () => {
    expect(run('sqrt(16)')).toBe('4');
    expect(run('3sqrt(4)')).toBe('6');
    expect(run('sqrt(99999999*99999999)')).toBe('99999999');
    expect(run('sqrt(-1)')).toBe('ERR:undefined');
    expect(run('sqrt')).toBe('ERR:syntax');
    expect(run('2π')).toBe('6.283185307');
    expect(run('π2')).toBe('ERR:syntax');
  });
  it('compile once, run many times', () => {
    const c = compile('x^2');
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(c.program.numeric(new Map([['x', { value: 3, big: null }]]))).toBe(9);
      expect(c.program.numeric(new Map())).toBeNaN();
    }
  });
});

describe('functions and e', () => {
  const v = (s: string): string => {
    const r = evaluate(s);
    return r.ok ? r.text : r.error;
  };
  it('sin cos tan in radians, log base 10, ln, e', () => {
    expect(v('sin(0)')).toBe('0');
    expect(v('sin(π)')).toBe('0');
    expect(v('cos(0)')).toBe('1');
    expect(v('2sin(π/2)')).toBe('2');
    expect(v('tan(π/4)')).toBe('1');
    expect(v('log(1000)')).toBe('3');
    expect(v('ln(e)')).toBe('1');
    expect(v('e^2')).toBe(String(Number((Math.E ** 2).toPrecision(10))));
    expect(v('2e')).toBe(String(Number((2 * Math.E).toPrecision(10))));
  });
  it('outside the real domain is Undefined', () => {
    expect(v('log(0)')).toBe('undefined');
    expect(v('log(-5)')).toBe('undefined');
    expect(v('tan(π/2)')).toBe('undefined');
  });
  it('functions combine with variables and implicit products', () => {
    const env = new Map([['x', { value: Math.PI / 6, big: null }]]);
    const r = evaluate('2sin(x)', env);
    expect(r.ok && r.value).toBeCloseTo(1, 12);
    expect(evaluate('xsin(x)', env).ok).toBe(true);
  });
  it('still rejects unknown words', () => {
    expect(v('sinh(1)')).toBe('syntax');
    expect(v('abc')).toBe('syntax');
    expect(v('sin')).toBe('syntax');
  });
});

describe('fast numeric path (graphs)', () => {
  const same = (expr: string, x: number, y = 0): void => {
    const c = compile(expr);
    if (!c.ok) throw new Error(expr);
    const env = new Map([['x', { value: x, big: null }], ['y', { value: y, big: null }]]);
    const slow = c.program.numeric(env);
    const fast = c.program.fast()(x, y);
    if (Number.isNaN(slow)) expect(Number.isFinite(fast)).toBe(false);
    else expect(fast).toBeCloseTo(slow, 10);
  };
  it('agrees with the exact evaluator', () => {
    for (const e of ['x^2+y^2-25', '2sin(x)cos(y)', '-x^3+3x', 'sqrt(x)', 'log(x)', 'e^(x)', '1/x', 'tan(x)', '(x+1)(x-1)', '2πx', 'ln(x)']) {
      for (const x of [-2, -0.5, 0, 0.7, 3]) same(e, x, 1.5);
    }
  });
  it('free variables come from the arguments, the rest from the environment', () => {
    const c = compile('x+y');
    const env = new Map([['y', { value: 10, big: null }]]);
    expect(c.ok && c.program.fast(env, ['x'])(1, NaN)).toBe(11);
    expect(c.ok && c.program.fast(env)(1, 2)).toBe(3);
  });
});

describe('real roots of negative numbers', () => {
  it('(-8)^(1/3) is -2 and (-32)^(1/5) is -2', () => {
    expect(run('(-8)^(1/3)')).toBe('-2');
    expect(run('(-32)^(1/5)')).toBe('-2');
    expect(run('(-8)^(2/3)')).toBe('4');
  });
  it('an even root of a negative number is still Undefined', () => {
    expect(run('(-4)^(1/2)')).toBe('ERR:undefined');
  });
});
