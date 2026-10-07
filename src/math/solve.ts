import { compile, type Env, type EvalResult, type Program, type Value } from './evaluate.ts';
import { cleanNumber, solveX } from './graph.ts';
import { formatNumber } from './evaluate.ts';
import { parseStatement, timesReading, type Statement } from './latex.ts';

/** What to draw next to a line. */
export type Answer =
  | { kind: 'none' }
  | { kind: 'value'; text: string; expression: string }
  /** Mathematically undefined, e.g. division by zero. */
  | { kind: 'undefined'; text: 'Undefined'; expression: string }
  /** Could not be understood or computed. `text` is a short glyph for the UI. */
  | { kind: 'error'; text: string; reason: string }
  /** "x = 10" was stored. `show`: the user also asked for the value ("x = 3 + 4 ="). */
  | { kind: 'assigned'; name: string; text: string; expression: string; show: boolean; literal: boolean }
  /** "y = x^2": a curve to draw. `env` holds the other variables at that point of the page. */
  | { kind: 'plot'; expression: string; program: Program; env: Env }
  /** Equation in one unknown: its real solutions and a graph of both sides. */
  | { kind: 'solved'; variable: 'x' | 'y'; solutions: number[]; text: string; left: Program; right: Program; leftText: string; rightText: string; env: Env }
  /** An equation in x and y ("x² + y² = 25", "x = sin y"): the curve where both sides are equal. */
  | { kind: 'curve'; left: Program; right: Program; leftText: string; rightText: string; env: Env };

export const NO_ANSWER: Answer = { kind: 'none' };

function errorAnswer(r: Extract<EvalResult, { ok: false }>, expression: string): Answer {
  switch (r.error) {
    case 'undefined':
      return { kind: 'undefined', text: 'Undefined', expression };
    case 'overflow':
      return { kind: 'error', text: '∞', reason: r.message };
    case 'empty':
      return NO_ANSWER; // a bare "=" : nothing to calculate yet
    default:
      return { kind: 'error', text: '?', reason: r.message };
  }
}

/**
 * "x = 3", "x ~ -1.895, 0, 1.895", "no real solution". `satisfies` checks whether a short decimal is an exact
 * solution (1000x = 1 gives x = 0.001, not x ~ 0.001). With more than 4 solutions the ones nearest 0 are shown.
 */
export function solutionText(variable: string, solutions: readonly number[], satisfies?: (v: number) => boolean): string {
  if (solutions.length === 0) return 'no real solution';
  const picked = solutions.length > 4 ? [...solutions].sort((a, b) => Math.abs(a) - Math.abs(b)).slice(0, 4) : solutions;
  let exact = true;
  const shown = picked.map((v) => {
    if (Number.isInteger(v)) return v;
    for (let digits = 1; digits <= 6 && satisfies; digits++) {
      const short = Number(v.toPrecision(digits));
      if (satisfies(short)) return short;
    }
    exact = false;
    // 4 significant digits, but at least 4 decimals past the whole part for big values (1000.0005)
    const whole = Math.abs(v) >= 1 ? Math.floor(Math.log10(Math.abs(v))) + 1 : 0;
    return Number(v.toPrecision(whole >= 4 ? whole + 4 : 4));
  });
  const text = shown.map((v) => formatNumber(v).replace(/^-/, '−'));
  const more = solutions.length > 4 ? ', …' : '';
  return `${variable} ${exact ? '=' : '≈'} ${text.join(', ')}${more}`;
}

/** "2x(1+1)": x is the variable if it has a value or appears elsewhere in the line, otherwise it is ×. */
export function bindAmbiguousTimes(statement: Statement, env: Env): Statement {
  const all = statement.kind === 'equation' ? statement.left + statement.right : 'expression' in statement ? statement.expression : '';
  const variable = env.has('x') || /x/.test(all);
  const bind = (e: string): string => e.replace(/×/g, variable ? '*x*' : '*');
  switch (statement.kind) {
    case 'solve':
    case 'assign':
    case 'plot':
      return statement.expression.includes('×') ? { ...statement, expression: bind(statement.expression) } : statement;
    case 'equation':
      return statement.left.includes('×') || statement.right.includes('×') ? { ...statement, left: bind(statement.left), right: bind(statement.right) } : statement;
    default:
      return statement;
  }
}

/** Solve one statement with the variables known so far. Returns the new variables (unchanged unless assigned). */
export function solveStatement(raw: Statement, env: Env): { answer: Answer; env: Env } {
  const statement = bindAmbiguousTimes(raw, env);
  switch (statement.kind) {
    case 'none':
      return { answer: NO_ANSWER, env };
    case 'unsupported':
      return { answer: { kind: 'error', text: '?', reason: `Unsupported symbol ${statement.token}` }, env };
    case 'solve': {
      const c = compile(statement.expression);
      if (!c.ok) return { answer: errorAnswer(c, statement.expression), env };
      const r = c.program.run(env);
      if (r.ok) {
        // "3 = 3": the number after "=" is the right answer, so tick it (any other number is taken as a misread)
        const written = statement.check !== undefined ? Number(statement.check) : NaN;
        if (Number.isFinite(written) && Math.abs(written - r.value) <= 1e-12 * Math.max(1, Math.abs(r.value))) {
          return { answer: { kind: 'value', text: '✓', expression: statement.expression }, env };
        }
        return { answer: { kind: 'value', text: r.text, expression: statement.expression }, env };
      }
      // "5 × -3" read as "5 x - 3" while x has no value: the x was a multiplication sign
      const alt = !r.ok && r.error === 'unknown' && r.name === 'x' ? timesReading(statement.expression) : null;
      if (alt !== null) {
        const retry = solveStatement({ kind: 'solve', expression: alt }, env);
        if (retry.answer.kind === 'value' || retry.answer.kind === 'undefined') return retry;
      }
      return { answer: errorAnswer(r, statement.expression), env };
    }
    case 'assign': {
      const c = compile(statement.expression);
      if (!c.ok) return { answer: errorAnswer(c, statement.expression), env };
      const r = c.program.run(env);
      if (!r.ok) return { answer: errorAnswer(r, statement.expression), env };
      const value = c.program.value(env) as Value;
      const next = new Map(env);
      next.set(statement.name, value);
      return {
        answer: {
          kind: 'assigned',
          name: statement.name,
          text: r.text,
          expression: statement.expression,
          show: statement.show,
          literal: /^-?[0-9.]+$/.test(statement.expression),
        },
        env: next,
      };
    }
    case 'equation': {
      const l = compile(statement.left);
      if (!l.ok) return { answer: errorAnswer(l, statement.left), env };
      const r = compile(statement.right);
      if (!r.ok) return { answer: errorAnswer(r, statement.right), env };
      // "x = x + 1" after x = 2 is an update (x becomes 3), as on paper; only an x without a value makes it an equation
      if ((statement.left === 'x' || statement.left === 'y') && env.has(statement.left) && [...r.program.variables].every((v) => env.has(v))) {
        return solveStatement({ kind: 'assign', name: statement.left, expression: statement.right, show: false }, env);
      }
      const vars = new Set([...l.program.variables, ...r.program.variables]);
      const free = [...vars].filter((v) => !env.has(v)) as Array<'x' | 'y'>;
      if (free.length === 0) {
        // both sides known: "3 = 3" is checked. Otherwise it is usually a phantom digit after "=" ("x + 5 = 5"
        // after x = 10), so the left side is calculated.
        const lv = l.program.run(env);
        const rv = r.program.run(env);
        if (lv.ok && rv.ok && Math.abs(lv.value - rv.value) <= 1e-12 * Math.max(1, Math.abs(lv.value))) {
          return { answer: { kind: 'value', text: '✓', expression: `${statement.left}=${statement.right}` }, env };
        }
        return solveStatement({ kind: 'solve', expression: statement.left }, env);
      }
      if (free.length === 2) {
        return { answer: { kind: 'curve', left: l.program, right: r.program, leftText: statement.left, rightText: statement.right, env }, env };
      }
      const variable = free[0];
      const at = (v: number) => {
        const e = new Map(env);
        e.set(variable, { value: v, big: null });
        return e;
      };
      // allocation-free evaluators: the root finder evaluates thousands of points
      const lf = l.program.fast(env, [variable]);
      const rf = r.program.fast(env, [variable]);
      const fl = variable === 'x' ? (v: number): number => lf(v, NaN) : (v: number): number => lf(NaN, v);
      const fr = variable === 'x' ? (v: number): number => rf(v, NaN) : (v: number): number => rf(NaN, v);
      // both sides equal everywhere (2x = 2x): every value works
      const probes = [-7.3, -2.9, -1.1, -0.4, 0.6, 1.7, 3.2, 8.9];
      const same = probes.filter((v) => {
        const a = fl(v);
        const b = fr(v);
        return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
      });
      const defined = probes.filter((v) => Number.isFinite(fl(v)) && Number.isFinite(fr(v)));
      if (defined.length >= 4 && same.length === defined.length) {
        return {
          answer: { kind: 'solved', variable, solutions: [], text: `true for every ${variable}`, left: l.program, right: r.program, leftText: statement.left, rightText: statement.right, env },
          env,
        };
      }
      const solutions = solveX(fl, fr).map(cleanNumber);
      // a "solution" must really satisfy the equation (not a pole of tan, not a removed point)
      const ok = solutions.filter((v) => {
        const lv = l.program.numeric(at(v));
        const rv = r.program.numeric(at(v));
        return Number.isFinite(lv) && Number.isFinite(rv) && Math.abs(lv - rv) <= 1e-6 * Math.max(1, Math.abs(lv), Math.abs(rv));
      });
      return {
        answer: {
          kind: 'solved',
          variable,
          solutions: ok,
          text: solutionText(variable, ok, (v) => {
            const a = fl(v);
            const b = fr(v);
            return Number.isFinite(a) && a === b;
          }),
          left: l.program,
          right: r.program,
          leftText: statement.left,
          rightText: statement.right,
          env,
        },
        env,
      };
    }
    case 'plot': {
      const c = compile(statement.expression);
      if (!c.ok) return { answer: errorAnswer(c, statement.expression), env };
      for (const v of c.program.variables) {
        if (v !== 'x' && !env.has(v)) {
          return { answer: { kind: 'error', text: '?', reason: `${v} has no value yet (write ${v} = 5 on a line above)` }, env };
        }
      }
      return { answer: { kind: 'plot', expression: statement.expression, program: c.program, env }, env };
    }
  }
}

/** Solve the page top to bottom. A variable applies to the lines below where it is set. */
export function solveSheet(latexLines: readonly (string | undefined)[]): Answer[] {
  let env: Env = new Map();
  /** "y = x²" is also a formula: further down, wherever x has a value, y has one too (x = 3 -> y = 9). */
  const formulas = new Map<string, Program>();
  return latexLines.map((latex) => {
    if (latex === undefined) return NO_ANSWER;
    const statement = parseStatement(latex);

    // values that formulas give on this line (recomputed every line, so a later "x = ..." is always used)
    let lineEnv: Env = env;
    const derived = new Set<string>();
    for (const [name, program] of formulas) {
      if (env.has(name)) continue;
      if (![...program.variables].every((v) => v !== name && env.has(v))) continue;
      const v = program.value(env);
      if (!v) continue;
      const m = new Map(lineEnv);
      m.set(name, v);
      lineEnv = m;
      derived.add(name);
    }

    const { answer, env: next } = solveStatement(statement, lineEnv);
    // formula values are not stored as plain variables: drop them again unless this line assigned them
    let kept: Env = next;
    if (derived.size > 0) {
      const m = new Map(next);
      for (const name of derived) {
        if (!(statement.kind === 'assign' && statement.name === name)) m.delete(name);
      }
      kept = m;
    }
    env = kept;

    if (answer.kind === 'plot') formulas.set('y', answer.program);
    else if (statement.kind === 'assign') formulas.delete(statement.name);
    return answer;
  });
}

/** One recognised line on its own (no variables from other lines). Pure, total, never throws. */
export function solveLatex(latex: string): Answer {
  return solveSheet([latex])[0];
}
