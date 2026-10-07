/**
 * Deterministic arithmetic engine for CalcInk.
 */

export type EvalErrorCode =
  | 'empty' //     nothing to evaluate
  | 'syntax' //    malformed expression
  | 'undefined' // division by zero, 0^-1, sqrt(-1), NaN results
  | 'overflow' //  result does not fit in a finite double
  | 'unknown'; //  a variable that has no value yet

export type EvalResult =
  | { ok: true; value: number; text: string; exact: boolean }
  | { ok: false; error: EvalErrorCode; message: string; name?: string };

/** A number together with its exact whole-number value when we have one. */
export interface Value {
  value: number;
  big: bigint | null;
}

/** Variable values, e.g. after the user wrote "x = 10". */
export type Env = ReadonlyMap<string, Value>;

/** The only letters an expression may use as variables. Everything else is a syntax error. */
export const VARIABLES: ReadonlySet<string> = new Set(['x', 'y']);

type BinaryOp = '+' | '-' | '*' | '/' | '^';
type Func = 'sqrt' | 'sin' | 'cos' | 'tan' | 'log' | 'ln';
/** Function names, longest first so "sqrt" wins over a shorter prefix. Angles are in radians; log is base 10. */
const FUNCS: readonly Func[] = ['sqrt', 'sin', 'cos', 'tan', 'log', 'ln'];
const isFunc = (s: unknown): s is Func => typeof s === 'string' && (FUNCS as readonly string[]).includes(s);
type Op = BinaryOp | 'neg' | Func;

/** `big`: exact BigInt copy of whole numbers, used when the result is too big for a double (> 2^53). */
type Token =
  | { type: 'num'; value: number; big?: bigint; constant?: true }
  | { type: 'var'; name: string }
  | { type: 'func'; name: Func }
  | { type: 'op'; op: BinaryOp }
  | { type: 'lparen' }
  | { type: 'rparen' };

/** RPN items. */
type RpnItem =
  | { type: 'num'; value: number; big?: bigint }
  | { type: 'var'; name: string }
  | { type: 'op'; op: Op };

const PRECEDENCE: Record<BinaryOp | 'neg', number> = {
  '+': 1,
  '-': 1,
  '*': 2,
  '/': 2,
  neg: 3,
  '^': 4,
};

/** Only ^ is right-associative (neg is prefix, handled separately). */
const RIGHT_ASSOCIATIVE: ReadonlySet<Op> = new Set<Op>(['^']);

/** Whole-number answers with up to this many digits are shown exactly (BigInt); bigger ones are approximate. */
export const MAX_EXACT_DIGITS = 40;

const MESSAGES: Record<EvalErrorCode, string> = {
  empty: 'Nothing to calculate',
  syntax: 'Malformed expression',
  undefined: 'Undefined',
  overflow: 'Result too large',
  unknown: 'Unknown variable',
};

class EvalError extends Error {
  readonly code: EvalErrorCode;
  readonly name_?: string;
  constructor(code: EvalErrorCode, name?: string) {
    super(MESSAGES[code]);
    this.code = code;
    this.name_ = name;
  }
}

const fail = (code: EvalErrorCode, name?: string): EvalResult =>
  code === 'unknown' && name
    ? { ok: false, error: code, message: `${name} has no value yet (write ${name} = 5 on a line above)`, name }
    : { ok: false, error: code, message: MESSAGES[code] };

/** Map of alternative glyphs to the canonical ASCII operators. */
const GLYPH_ALIASES: Readonly<Record<string, string>> = {
  '×': '*',
  '✕': '*',
  '⋅': '*',
  '·': '*',
  '∗': '*',
  '÷': '/',
  '∕': '/',
  '−': '-',
  '–': '-',
  '—': '-',
  '［': '(',
  '（': '(',
  '）': ')',
};

const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';
const isLetter = (ch: string): boolean => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    let ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    ch = GLYPH_ALIASES[ch] ?? ch;

    if (isDigit(ch) || ch === '.') {
      let j = i;
      let sawDot = false;
      let digits = 0;
      while (j < input.length) {
        const c = input[j];
        if (isDigit(c)) {
          digits++;
          j++;
        } else if (c === '.') {
          if (sawDot) throw new EvalError('syntax'); // "1.2.3"
          sawDot = true;
          j++;
        } else {
          break;
        }
      }
      if (digits === 0) throw new EvalError('syntax'); // a lone "."
      const text = input.slice(i, j);
      const value = Number(text);
      if (!Number.isFinite(value)) throw new EvalError('overflow'); // 5000-digit literal
      const big = !sawDot && digits <= MAX_EXACT_DIGITS ? BigInt(text) : undefined;
      tokens.push({ type: 'num', value, big });
      i = j;
      continue;
    }

    if (ch === 'π') {
      tokens.push({ type: 'num', value: Math.PI, constant: true });
      i++;
      continue;
    }

    if (isLetter(ch)) {
      let j = i;
      while (j < input.length && isLetter(input[j])) j++;
      const word = input.slice(i, j);
      // longest match first: function names and "pi", then single letters (x, y, and the constant e)
      let k = 0;
      while (k < word.length) {
        const rest = word.slice(k);
        const fn = FUNCS.find((f) => rest.startsWith(f));
        if (fn) {
          tokens.push({ type: 'func', name: fn });
          k += fn.length;
        } else if (rest.startsWith('pi')) {
          tokens.push({ type: 'num', value: Math.PI, constant: true });
          k += 2;
        } else if (rest[0] === 'e') {
          tokens.push({ type: 'num', value: Math.E, constant: true });
          k += 1;
        } else {
          // "xy" is x times y; anything that is not a known variable is rejected (never looked up anywhere)
          if (!VARIABLES.has(rest[0])) throw new EvalError('syntax');
          tokens.push({ type: 'var', name: rest[0] });
          k += 1;
        }
      }
      i = j;
      continue;
    }

    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '^') {
      tokens.push({ type: 'op', op: ch });
    } else if (ch === '(') {
      tokens.push({ type: 'lparen' });
    } else if (ch === ')') {
      tokens.push({ type: 'rparen' });
    } else {
      throw new EvalError('syntax'); // unknown character: never executed, never evaluated
    }
    i++;
  }
  return tokens;
}

type StackItem = BinaryOp | 'neg' | Func | '(';

/** Shunting-yard. `expectOperand` tells unary from binary +/- and catches malformed input. */
function toRpn(tokens: Token[]): RpnItem[] {
  if (tokens.length === 0) throw new EvalError('empty');

  const output: RpnItem[] = [];
  const stack: StackItem[] = [];
  let expectOperand = true;

  const pushBinary = (op: BinaryOp): void => {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === '(' || isFunc(top)) break;
      const higher = PRECEDENCE[top] > PRECEDENCE[op];
      const equalAndLeft = PRECEDENCE[top] === PRECEDENCE[op] && !RIGHT_ASSOCIATIVE.has(op);
      if (!higher && !equalAndLeft) break;
      output.push({ type: 'op', op: top });
      stack.pop();
    }
    stack.push(op);
  };

  /** An operand-starting token in "operand" position. */
  const startOperand = (tok: Token, k: number): void => {
    if (tok.type === 'num' || tok.type === 'var') {
      output.push(tok);
      expectOperand = false;
    } else if (tok.type === 'func') {
      if (tokens[k + 1]?.type !== 'lparen') throw new EvalError('syntax'); // sqrt must be followed by (
      stack.push(tok.name);
    } else if (tok.type === 'lparen') {
      stack.push('(');
    } else {
      throw new EvalError('syntax');
    }
  };

  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];

    if (expectOperand) {
      if (tok.type === 'op' && tok.op === '-') stack.push('neg'); // prefix operator: pushed without popping
      else if (tok.type === 'op' && tok.op === '+') {
        // unary plus is a no-op
      } else startOperand(tok, k);
      continue;
    }

    // expecting an operator, ")" or an implicit multiplication
    if (tok.type === 'op') {
      pushBinary(tok.op);
      expectOperand = true;
    } else if (tok.type === 'rparen') {
      let matched = false;
      while (stack.length > 0) {
        const top = stack.pop() as StackItem;
        if (top === '(') {
          matched = true;
          break;
        }
        output.push({ type: 'op', op: top });
      }
      if (!matched) throw new EvalError('syntax');
      // a function applies to the bracket that just closed
      if (isFunc(stack[stack.length - 1])) output.push({ type: 'op', op: stack.pop() as Func });
    } else if (tok.type === 'num') {
      // a number directly after a value: only ")" 5 and 2π are valid implicit products ("2 3" and "x2" are not)
      if (tokens[k - 1]?.type !== 'rparen' && !tok.constant) throw new EvalError('syntax');
      pushBinary('*');
      startOperand(tok, k);
    } else {
      // 2(3+4), (1+2)(3+4), 2x, xy, 3sqrt(4), x(2+1)
      pushBinary('*');
      expectOperand = true;
      startOperand(tok, k);
    }
  }

  if (expectOperand) throw new EvalError('syntax'); // trailing operator, "(" or a function name
  while (stack.length > 0) {
    const top = stack.pop() as StackItem;
    if (top === '(') throw new EvalError('syntax'); // unclosed bracket
    output.push({ type: 'op', op: top });
  }
  return output;
}

/** sin cos tan (radians), log (base 10), ln. Outside the real domain -> Undefined, never NaN on screen. */
function applyFunc(f: Func, a: number): number {
  let r: number;
  switch (f) {
    case 'sin':
      r = Math.sin(a);
      break;
    case 'cos':
      r = Math.cos(a);
      break;
    case 'tan':
      // tan at an odd multiple of π/2 is undefined (the double gives ~1.6e16 instead of infinity)
      if (Math.abs(Math.cos(a)) < 1e-12) throw new EvalError('undefined');
      r = Math.tan(a);
      break;
    case 'log':
      if (a <= 0) throw new EvalError('undefined');
      r = Math.log10(a);
      break;
    case 'ln':
      if (a <= 0) throw new EvalError('undefined');
      r = Math.log(a);
      break;
    default:
      r = Math.sqrt(a);
  }
  if (!Number.isFinite(r)) throw new EvalError('undefined');
  // sin(π) is 1.2e-16 in doubles: show 0
  return Math.abs(r) < 1e-12 ? 0 : r;
}

/** a^b, but a negative base with an exponent like 1/3 or 2/5 gives the real root ((-8)^(1/3) = -2). */
export function realPow(a: number, b: number): number {
  if (a >= 0 || Number.isInteger(b)) return Math.pow(a, b);
  for (let q = 3; q <= 15; q += 2) {
    const p = Math.round(b * q);
    if (Math.abs(b * q - p) < 1e-9) {
      const m = Math.pow(-a, b);
      return p % 2 === 0 ? m : -m;
    }
  }
  return NaN;
}

function applyBinary(op: BinaryOp, a: number, b: number): number {
  let r: number;
  switch (op) {
    case '+':
    case '-':
      r = op === '+' ? a + b : a - b;
      // 0.1 × 3 - 0.3 is 5.6e-17 in doubles: a difference that small next to its operands is rounding noise
      if (Math.abs(r) < 1e-12 * Math.max(Math.abs(a), Math.abs(b))) r = 0;
      break;
    case '*':
      r = a * b;
      break;
    case '/':
      if (b === 0) throw new EvalError('undefined'); // x/0 and 0/0
      r = a / b;
      break;
    case '^':
      r = realPow(a, b);
      break;
  }
  if (Number.isNaN(r)) throw new EvalError('undefined'); // (-8)^0.5, 0^0 style gaps
  if (!Number.isFinite(r)) {
    // 0^-1 is a division by zero in disguise; anything else is just too big
    throw new EvalError(op === '^' && a === 0 ? 'undefined' : 'overflow');
  }
  return r;
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}

/** Exact integer version of one operation, or null when it cannot be done exactly (decimals, 1/3, huge...). */
function exactBinary(op: BinaryOp, a: bigint | null, b: bigint | null): bigint | null {
  if (a === null || b === null) return null;
  let r: bigint;
  switch (op) {
    case '+':
      r = a + b;
      break;
    case '-':
      r = a - b;
      break;
    case '*':
      r = a * b;
      break;
    case '/':
      if (b === 0n || a % b !== 0n) return null; // only exact divisions stay exact
      r = a / b;
      break;
    case '^': {
      if (b < 0n || b > 1000n) return null;
      // do not even try when the result is obviously far too big
      const absA = a < 0n ? -a : a;
      if (absA > 1n && Number(b) * (absA.toString().length - 1) > MAX_EXACT_DIGITS) return null;
      r = a ** b;
      break;
    }
  }
  return (r < 0n ? -r : r).toString().length > MAX_EXACT_DIGITS ? null : r;
}

function evaluateRpn(rpn: readonly RpnItem[], env: Env | undefined): Value {
  const stack: Value[] = [];
  for (const item of rpn) {
    if (item.type === 'num') {
      stack.push({ value: item.value, big: item.big ?? null });
    } else if (item.type === 'var') {
      const v = env?.get(item.name);
      if (!v) throw new EvalError('unknown', item.name);
      stack.push(v);
    } else if (item.op === 'neg') {
      const a = stack.pop();
      if (a === undefined) throw new EvalError('syntax');
      stack.push({ value: -a.value, big: a.big === null ? null : -a.big });
    } else if (item.op === 'sqrt') {
      const a = stack.pop();
      if (a === undefined) throw new EvalError('syntax');
      if (a.value < 0) throw new EvalError('undefined'); // no real square root
      const root = a.big !== null ? isqrt(a.big) : null;
      stack.push({ value: Math.sqrt(a.value), big: root !== null && root * root === a.big ? root : null });
    } else if (isFunc(item.op)) {
      const a = stack.pop();
      if (a === undefined) throw new EvalError('syntax');
      stack.push({ value: applyFunc(item.op, a.value), big: null });
    } else {
      const b = stack.pop();
      const a = stack.pop();
      if (a === undefined || b === undefined) throw new EvalError('syntax');
      // the double result still decides errors (division by zero, overflow...)
      stack.push({ value: applyBinary(item.op, a.value, b.value), big: exactBinary(item.op, a.big, b.big) });
    }
  }
  if (stack.length !== 1) throw new EvalError('syntax');
  return stack[0];
}

/**
 * Format a number: whole numbers up to 2^53 in full, others with at least 10 significant digits (and at least
 * 2 decimals after the whole part), scientific notation above 2^53.
 */
export function formatNumber(value: number): string {
  if (value === 0) return '0'; // also normalises -0
  if (Number.isSafeInteger(value)) return String(value); // exact in a double (up to 2^53)
  const abs = Math.abs(value);
  if (abs >= 2 ** 53) return Number(value.toPrecision(10)).toExponential();
  const intDigits = abs >= 1 ? Math.floor(Math.log10(abs)) + 1 : 0;
  const significant = Math.min(15, Math.max(10, intDigits + 2));
  return String(Number(value.toPrecision(significant)));
}

/** Text for a computed value: the exact BigInt when a double can't hold it, otherwise formatNumber. */
export function formatValue(v: Value): string {
  return v.big !== null && !Number.isSafeInteger(v.value) ? v.big.toString() : formatNumber(v.value);
}

/** A parsed expression that can be run many times with different variable values. */
export interface Program {
  readonly variables: ReadonlySet<string>;
  run(env?: Env): EvalResult;
  /** Fast numeric evaluation for plotting: NaN instead of an error. */
  numeric(env: Env): number;
  /** Exact value for storing in a variable. Throws nothing; null on error. */
  value(env?: Env): Value | null;
  /** Allocation-free f(x, y) for graphs and root finding. Returns NaN instead of throwing. */
  fast(env?: Env, free?: ReadonlyArray<'x' | 'y'>): (x: number, y: number) => number;
}

/** Float stack machine over the same RPN: no objects per step, so a graph does not stall drawing. */
function makeFast(rpn: readonly RpnItem[], env: Env | undefined, free: ReadonlyArray<'x' | 'y'>): (x: number, y: number) => number {
  const stack = new Float64Array(rpn.length + 1);
  // resolve everything that does not depend on x / y once
  const code = rpn.map((item) => {
    if (item.type === 'num') return { k: 0, v: item.value };
    if (item.type === 'var') {
      if (item.name === 'x' && free.includes('x')) return { k: 1, v: 0 };
      if (item.name === 'y' && free.includes('y')) return { k: 2, v: 0 };
      const known = env?.get(item.name);
      return { k: 0, v: known ? known.value : NaN };
    }
    return { k: 3, v: 0, op: item.op };
  });
  return (x, y) => {
    let sp = 0;
    for (let i = 0; i < code.length; i++) {
      const c = code[i];
      if (c.k === 0) stack[sp++] = c.v;
      else if (c.k === 1) stack[sp++] = x;
      else if (c.k === 2) stack[sp++] = y;
      else {
        const op = (c as { op: Op }).op;
        if (op === 'neg') stack[sp - 1] = -stack[sp - 1];
        else if (isFunc(op)) {
          const a = stack[sp - 1];
          stack[sp - 1] =
            op === 'sqrt' ? Math.sqrt(a)
            : op === 'sin' ? Math.sin(a)
            : op === 'cos' ? Math.cos(a)
            : op === 'tan' ? Math.tan(a)
            : op === 'log' ? (a > 0 ? Math.log10(a) : NaN)
            : a > 0 ? Math.log(a) : NaN;
        } else {
          const b = stack[--sp];
          const a = stack[sp - 1];
          stack[sp - 1] =
            op === '+' ? a + b
            : op === '-' ? a - b
            : op === '*' ? a * b
            : op === '/' ? (b === 0 ? NaN : a / b)
            : realPow(a, b);
        }
      }
    }
    return sp === 1 ? stack[0] : NaN;
  };
}

export type CompileResult = { ok: true; program: Program } | { ok: false; error: EvalErrorCode; message: string };

/** Parse once. Never throws. */
export function compile(input: string): CompileResult {
  let rpn: RpnItem[];
  try {
    rpn = toRpn(tokenize(input));
  } catch (err) {
    const r = err instanceof EvalError ? fail(err.code) : fail('syntax');
    return r as { ok: false; error: EvalErrorCode; message: string };
  }
  const variables = new Set(rpn.flatMap((i) => (i.type === 'var' ? [i.name] : [])));
  const program: Program = {
    variables,
    run(env) {
      try {
        const v = evaluateRpn(rpn, env);
        return { ok: true, value: v.value, text: formatValue(v), exact: v.big !== null || Number.isSafeInteger(v.value) };
      } catch (err) {
        if (err instanceof EvalError) return fail(err.code, err.name_);
        return fail('syntax'); // defence in depth: an engine bug must not crash the UI
      }
    },
    numeric(env) {
      try {
        return evaluateRpn(rpn, env).value;
      } catch {
        return NaN;
      }
    },
    value(env) {
      try {
        return evaluateRpn(rpn, env);
      } catch {
        return null;
      }
    },
    fast(env, free = ['x', 'y']) {
      return makeFast(rpn, env, free);
    },
  };
  return { ok: true, program };
}

/** Evaluate an arithmetic expression string. Never throws. */
export function evaluate(input: string, env?: Env): EvalResult {
  const c = compile(input);
  return c.ok ? c.program.run(env) : c;
}
