/**
 * LaTeX (as emitted by the CoMER recogniser) -> plain arithmetic expression.
 */

export type LatexParseResult =
  /** Line ends with "=": `expression` is what comes before it. */
  | { kind: 'solve'; expression: string; check?: string }
  /** Nothing to answer yet (no trailing "="), e.g. the user is still writing. */
  | { kind: 'none' }
  /** The line ends with "=" but contains something we cannot calculate. */
  | { kind: 'unsupported'; token: string };

const MULTIPLY = new Set(['\\times', '\\cdot', '\\ast', '\\star', '*', '×', '·']);
/** "x" is ambiguous: the letter x, or a hand-written multiplication sign. */
const X_LIKE = new Set(['x', 'X']);
const DIVIDE = new Set(['\\div', '/', '÷', '\\slash']);
const MINUS = new Set(['-', '−', '–', '\\minus']);
/** Handwritten function names the model can read, and what the calculator calls them. */
const FUNCTIONS: Readonly<Record<string, string>> = {
  '\\sin': 'sin',
  '\\cos': 'cos',
  '\\tan': 'tan',
  '\\log': 'log',
  '\\ln': 'ln',
};
const IGNORED = new Set([
  '\\left',
  '\\right',
  '\\,',
  '\\;',
  '\\!',
  '\\ ',
  '\\quad',
  '\\qquad',
  '\\displaystyle',
  '\\limits',
  '{',
  '}',
]);

/** Split "\times3" / "12+4" style glued input into atomic tokens. */
export function tokenizeLatex(latex: string): string[] {
  return latex.match(/\\[A-Za-z]+|\\.|\d|[^\s\d\\]/g) ?? [];
}

class UnsupportedToken extends Error {
  readonly token: string;
  constructor(token: string) {
    super(`unsupported token ${token}`);
    this.token = token;
  }
}

/** Read one `{ ... }` group (or a single token) starting at index i. */
function readGroup(tokens: string[], i: number): { tokens: string[]; next: number } {
  if (tokens[i] !== '{') {
    return i < tokens.length ? { tokens: [tokens[i]], next: i + 1 } : { tokens: [], next: i };
  }
  let depth = 0;
  const inner: string[] = [];
  let j = i;
  for (; j < tokens.length; j++) {
    const t = tokens[j];
    if (t === '{') {
      depth++;
      if (depth === 1) continue;
    } else if (t === '}') {
      depth--;
      if (depth === 0) {
        j++;
        break;
      }
    }
    inner.push(t);
  }
  return { tokens: inner, next: j };
}

/** First token at or after i that is not a brace. */
function peek(tokens: string[], i: number): string | undefined {
  while (i < tokens.length && (tokens[i] === '{' || tokens[i] === '}')) i++;
  return tokens[i];
}

/** A dot is a decimal point when a digit follows and the number has no point yet; otherwise it multiplies. */
function isDecimalDot(before: string, next: string | undefined): boolean {
  if (next === undefined || !/^\d$/.test(next)) return false;
  const last = before.slice(-1);
  if (/[a-zπ)]/i.test(last)) return false; // after a variable, a constant or a bracket: multiplication
  const run = /[\d.]*$/.exec(before)?.[0] ?? '';
  return !run.includes('.');
}

function translate(tokens: string[]): string {
  let out = '';
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];

    if (/^\d$/.test(t) || t === '.' || t === '(' || t === ')' || t === '+') {
      out += t;
      i++;
    } else if (MINUS.has(t)) {
      out += '-';
      i++;
    } else if ((t === '\\cdot' || t === '·') && isDecimalDot(out, peek(tokens, i + 1))) {
      // a dot written before a digit is a decimal point ("2·5" is 2.5, "·5" is 0.5), not multiplication
      out += '.';
      i++;
    } else if (MULTIPLY.has(t)) {
      out += '*';
      i++;
    } else if (X_LIKE.has(t)) {
      // "3 x 4": a multiplication sign between two numbers. "2 x + 1", "x ^ 2", "x = 5": the variable x.
      const before = out.slice(-1);
      const after = peek(tokens, i + 1) ?? '';
      const betweenNumbers = /[0-9.)]/.test(before) && /^(\d|\.|\(|\\frac|\\sqrt)$/.test(after);
      // before a bracket ("2x(1+1)") it could be either: "×" stays ambiguous and the solver decides (see
      // bindAmbiguousTimes). Before a number, a fraction or a root a handwritten × sign is far more likely.
      out += !betweenNumbers ? 'x' : after === '(' ? '×' : '*';
      i++;
    } else if (t === 'y' || t === 'Y') {
      out += 'y';
      i++;
    } else if (t === '\\pi') {
      out += 'π';
      i++;
    } else if (t === 'e') {
      out += 'e'; // Euler's number
      i++;
    } else if (FUNCTIONS[t]) {
      // "sin(x)", "sin{x}" or - as people usually write it - "sin x", "sin 2x", "sin x^2": the argument runs to the
      // next + - × ÷ = or closing bracket, or to the next function name. "sin² x" is (sin x)².
      const name = FUNCTIONS[t];
      let k = i + 1;
      let power: string | null = null;
      if (tokens[k] === '^') {
        const e = readGroup(tokens, k + 1);
        if (e.tokens.length === 0) throw new UnsupportedToken(t);
        power = translate(e.tokens);
        // sin⁻¹ means arcsin, not 1/sin: not supported, so say "?" rather than give a wrong number
        if (power.startsWith('-')) throw new UnsupportedToken(`${t}^{-1}`);
        k = e.next;
      }
      let arg: string[] = [];
      const next = tokens[k];
      if (next === '(') {
        let depth = 0;
        let j = k;
        for (; j < tokens.length; j++) {
          if (tokens[j] === '(') depth++;
          else if (tokens[j] === ')' && --depth === 0) break;
        }
        if (j >= tokens.length) throw new UnsupportedToken(t); // "sin(x" never closed
        arg = tokens.slice(k + 1, j);
        k = j + 1;
      } else if (next === '{') {
        const g = readGroup(tokens, k);
        arg = g.tokens;
        k = g.next;
      } else {
        let depth = 0;
        let j = k;
        for (; j < tokens.length; j++) {
          const u = tokens[j];
          if (u === '(' || u === '{') depth++;
          else if (u === ')' || u === '}') {
            if (depth === 0) break;
            depth--;
          } else if (depth === 0 && arg.length > 0) {
            // a dot between digits is a decimal point inside the argument ("sin 0·5" is sin 0.5)
            const decimal = (u === '\\cdot' || u === '·') && /^\d$/.test(arg[arg.length - 1]) && /^\d$/.test(tokens[j + 1] ?? '');
            if (u === '+' || MINUS.has(u) || u === '=' || (MULTIPLY.has(u) && !decimal) || DIVIDE.has(u) || FUNCTIONS[u]) break;
          }
          arg.push(u);
        }
        k = j;
      }
      if (arg.length === 0) throw new UnsupportedToken(t);
      const call = `${name}(${translate(arg)})`;
      out += power === null ? call : `(${call})^(${power})`;
      i = k;
    } else if (DIVIDE.has(t)) {
      out += '/';
      i++;
    } else if (t === '\\frac') {
      const num = readGroup(tokens, i + 1);
      const den = readGroup(tokens, num.next);
      if (num.tokens.length === 0 || den.tokens.length === 0) throw new UnsupportedToken(t);
      out += `((${translate(num.tokens)})/(${translate(den.tokens)}))`;
      i = den.next;
    } else if (t === '\\sqrt' && /^\d$/.test(tokens[i + 1] ?? '')) {
      // "√16" without braces: the root covers the whole number
      let j = i + 1;
      const num: string[] = [];
      for (; j < tokens.length; j++) {
        const u = tokens[j];
        const dot = u === '.' || ((u === '\\cdot' || u === '·') && /^\d$/.test(tokens[j + 1] ?? '') && !num.includes('.'));
        if (!/^\d$/.test(u) && !dot) break;
        num.push(dot ? '.' : u);
      }
      out += `sqrt(${num.join('')})`;
      i = j;
    } else if (t === '\\sqrt') {
      const arg = readGroup(tokens, i + 1);
      if (arg.tokens.length === 0) throw new UnsupportedToken(t);
      out += `sqrt(${translate(arg.tokens)})`;
      i = arg.next;
    } else if (t === '^') {
      // "2 ^ - 1" (no braces): the sign belongs to the exponent
      let sign = '';
      let at = i + 1;
      if (MINUS.has(tokens[at]) || tokens[at] === '+') {
        sign = MINUS.has(tokens[at]) ? '-' : '';
        at++;
      }
      const exp = readGroup(tokens, at);
      if (exp.tokens.length === 0) throw new UnsupportedToken(t);
      out += `^(${sign}${translate(exp.tokens)})`;
      i = exp.next;
    } else if (IGNORED.has(t)) {
      i++;
    } else {
      throw new UnsupportedToken(t);
    }
  }
  return out;
}

/**
 * The model often reads "×" as x, so "5 × -3" comes out as "5 x - 3". This returns the reading with such
 * x's turned into "*" (null if there are none). The solver only uses it when x has no value.
 */
export function timesReading(expression: string): string | null {
  const alt = expression.replace(/(?<=[0-9.)π])x(?=-?(?:[0-9.(π]|sqrt))/g, '*');
  return alt === expression ? null : alt;
}

/** How many tokens after the final "=" are still considered recogniser noise. */
const MAX_TAIL_AFTER_EQUALS = 2;

/** Recognised line -> expression. Only lines ending in "=" are solved. */
export function latexToExpression(latex: string): LatexParseResult {
  const tokens = tokenizeLatex(latex)
    .filter((t) => !IGNORED.has(t) || t === '{' || t === '}')
    // The model often reads the two bars of "=" as two equals signs ("= ="): collapse repeats into one.
    .filter((t, i, all) => !(t === '=' && all[i - 1] === '='));

  // Drop trailing braces and stray specks (a dot or comma left after the "=" by an accidental tap),
  // then require a terminal "=".
  let end = tokens.length;
  while (end > 0 && ['}', '{', '.', ','].includes(tokens[end - 1])) end--;
  if (end === 0) return { kind: 'none' };
  let tail: string[] = [];
  if (tokens[end - 1] !== '=') {
    // The model sometimes "reads" a phantom token or two after the "=" (a stray speck, a slanted second
    // bar of the equals sign...). A short tail after the last "=" is treated as noise, not as input.
    const lastEq = tokens.lastIndexOf('=', end - 1);
    if (lastEq === -1 || end - 1 - lastEq > MAX_TAIL_AFTER_EQUALS) return { kind: 'none' };
    tail = tokens.slice(lastEq + 1, end);
    end = lastEq + 1;
  }

  // Several "=": use the segment before the first one. The model sometimes invents a second part after the
  // "=" ("8 + 8 + 8 = 8 =") and the first segment is what the user actually wrote as the question.
  const body = tokens.slice(0, end - 1);
  const firstEquals = body.indexOf('=');
  const segment = firstEquals === -1 ? body : body.slice(0, firstEquals);

  try {
    const expression = translate(segment);
    // "3 = 3": a number after the only "=" is kept so the solver can tick it if it is the right answer
    if (firstEquals === -1 && tail.length > 0 && tail.every((t) => /^[0-9.]$/.test(t))) {
      return { kind: 'solve', expression, check: tail.join('') };
    }
    return { kind: 'solve', expression };
  } catch (err) {
    if (err instanceof UnsupportedToken) return { kind: 'unsupported', token: err.token };
    throw err;
  }
}

// Statements: calculations, variables and plots

/** What a whole written line means. */
export type Statement =
  /** "18 + 4 × 3 =" : show the answer. `check`: a number written after the "=" ("3 = 3") */
  | { kind: 'solve'; expression: string; check?: string }
  /** "x = 10" : remember x (and, with a trailing "=", "x = 3 + 4 =" also shows 7) */
  | { kind: 'assign'; name: string; expression: string; show: boolean }
  /** "y = x^2" : draw the curve */
  | { kind: 'plot'; expression: string }
  /** Any other equation with x and/or y. The solver decides if it is a curve, an unknown to solve, or a sum. */
  | { kind: 'equation'; left: string; right: string }
  | { kind: 'none' }
  | { kind: 'unsupported'; token: string };

const VARIABLE_NAMES: Readonly<Record<string, string>> = { x: 'x', X: 'x', y: 'y', Y: 'y' };

function cleanTokens(latex: string): string[] {
  const tokens = tokenizeLatex(latex)
    .filter((t) => !IGNORED.has(t) || t === '{' || t === '}')
    .filter((t, i, all) => !(t === '=' && all[i - 1] === '='));
  let end = tokens.length;
  while (end > 0 && ['}', '{', '.', ','].includes(tokens[end - 1])) end--;
  return tokens.slice(0, end);
}

/** "x = 10" assigns, "y = ...x..." plots, "x =" shows x, anything else ending in "=" is solved. */
export function parseStatement(latex: string): Statement {
  const tokens = cleanTokens(latex);
  const first = tokens.indexOf('=');
  const lhs = first > 0 ? tokens.slice(0, first).filter((t) => t !== '{' && t !== '}') : [];
  const name = lhs.length === 1 ? VARIABLE_NAMES[lhs[0]] : undefined;

  if (name) {
    let rhs = tokens.slice(first + 1);
    const show = rhs[rhs.length - 1] === '=';
    if (show) rhs = rhs.slice(0, -1);
    if (!rhs.includes('=')) {
      if (rhs.filter((t) => t !== '{' && t !== '}').length === 0) {
        return { kind: 'solve', expression: name }; // "x =" : what is x?
      }
      try {
        const expression = translate(rhs);
        const hasX = /x/.test(expression);
        const hasY = /y/.test(expression);
        // "y = y^2 - x", "x = sin y", "x = x^2 - 2": not a definition, an equation to graph or solve
        if ((name === 'y' && hasY) || (name === 'x' && (hasX || hasY))) {
          return { kind: 'equation', left: name, right: expression };
        }
        if (name === 'y' && hasX) return { kind: 'plot', expression };
        return { kind: 'assign', name, expression, show };
      } catch (err) {
        if (err instanceof UnsupportedToken) return { kind: 'unsupported', token: err.token };
        throw err;
      }
    }
  }

  // left = right with x or y in it is an equation, except a doubled "= =" with at most two tokens after it,
  // which is how the model often reads the final "=" ("x + 5 =" -> "x + 5 = = x").
  const raw = tokenizeLatex(latex).filter((t) => !IGNORED.has(t));
  const rawFirst = raw.indexOf('=');
  const tail = rawFirst >= 0 && raw[rawFirst + 1] === '=' ? raw.slice(rawFirst + 2) : null;
  const askingForAnswer = tail !== null && tail.length <= MAX_TAIL_AFTER_EQUALS;
  if (first > 0 && !askingForAnswer) {
    const rest = tokens.slice(first + 1);
    const second = rest.indexOf('=');
    const rhs = (second === -1 ? rest : rest.slice(0, second));
    const meaningful = rhs.filter((t) => t !== '{' && t !== '}');
    if (meaningful.length > 0) {
      try {
        const left = translate(tokens.slice(0, first));
        const right = translate(rhs);
        // a real variable must survive translation ("5 x 3" is 5 × 3, not a variable x)
        if (/[xy]/.test(left + right)) return { kind: 'equation', left, right };
      } catch (err) {
        if (!(err instanceof UnsupportedToken)) throw err;
        // fall through: maybe the part before "=" alone is a calculation
      }
    }
  }
  return latexToExpression(latex);
}
