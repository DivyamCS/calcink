// Text for tidy mode: spaced operators, × ÷ signs, superscripts, and redundant brackets removed
// only when that can't change the meaning ("2(3)4" must not become "234").

type Tok = { t: 'num' | 'var' | 'op' | 'lp' | 'rp' | 'fn' | 'const'; v: string };

function lex(expression: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < expression.length) {
    const ch = expression[i];
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < expression.length && /[0-9.]/.test(expression[j])) j++;
      out.push({ t: 'num', v: expression.slice(i, j) });
      i = j;
    } else if (expression.startsWith('sqrt', i)) {
      out.push({ t: 'fn', v: '√' });
      i += 4;
    } else if (/^(sin|cos|tan|log|ln)/.test(expression.slice(i))) {
      const name = (/^(sin|cos|tan|log|ln)/.exec(expression.slice(i)) as RegExpExecArray)[1];
      out.push({ t: 'fn', v: name });
      i += name.length;
    } else if (ch === 'e') {
      out.push({ t: 'const', v: 'e' });
      i++;
    } else if (ch === 'π') {
      out.push({ t: 'const', v: 'π' });
      i++;
    } else if (/[a-z]/i.test(ch)) {
      out.push({ t: 'var', v: ch });
      i++;
    } else if (ch === '(') {
      out.push({ t: 'lp', v: '(' });
      i++;
    } else if (ch === ')') {
      out.push({ t: 'rp', v: ')' });
      i++;
    } else if (ch.trim() !== '') {
      out.push({ t: 'op', v: ch === '×' ? '*' : ch });
      i++;
    } else i++;
  }
  return out;
}

const SUPERSCRIPT: Readonly<Record<string, string>> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻',
};

/** Index of the bracket that closes the one at `open`, or -1. */
function closing(toks: readonly Tok[], open: number): number {
  let depth = 0;
  for (let k = open; k < toks.length; k++) {
    if (toks[k].t === 'lp') depth++;
    else if (toks[k].t === 'rp' && --depth === 0) return k;
  }
  return -1;
}

const isValue = (tok: Tok | undefined): boolean =>
  tok !== undefined && (tok.t === 'num' || tok.t === 'var' || tok.t === 'const' || tok.t === 'rp');
const startsValue = (tok: Tok | undefined): boolean =>
  tok !== undefined && (tok.t === 'num' || tok.t === 'var' || tok.t === 'const' || tok.t === 'lp' || tok.t === 'fn');

/** Remove "( n )" around a single (optionally negative) number where that is safe. Repeats until stable. */
function dropRedundantBrackets(toks: Tok[]): Tok[] {
  let changed = true;
  while (changed) {
    changed = false;
    for (let k = 0; k < toks.length; k++) {
      if (toks[k].t !== 'lp') continue;
      const end = closing(toks, k);
      if (end < 0) continue;
      const inner = toks.slice(k + 1, end);
      const single =
        (inner.length === 1 && (inner[0].t === 'num' || inner[0].t === 'var' || inner[0].t === 'const')) ||
        (inner.length === 2 && inner[0].v === '-' && inner[1].t === 'num');
      const whole = k === 0 && end === toks.length - 1 && inner.length > 0;
      if (!single && !whole) continue;
      const before = toks[k - 1];
      const after = toks[end + 1];
      // "2(3)", "(3)4", "√(4)", "x(2)": the brackets are doing work (implicit product / function argument)
      if (!whole && (isValue(before) || startsValue(after) || before?.t === 'fn')) continue;
      // "-(-2)" would print as "--2": keep the brackets around a negative number after an operator
      if (!whole && inner[0].v === '-' && before !== undefined) continue;
      toks.splice(end, 1);
      toks.splice(k, 1);
      changed = true;
      break;
    }
  }
  return toks;
}

export function formatExpressionForDisplay(expression: string): string {
  const toks = dropRedundantBrackets(lex(expression));
  let out = '';
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k];
    const prev = toks[k - 1];
    if (tok.t === 'op' && tok.v === '^') {
      // simple integer exponent -> superscript; anything else stays as ^(...)
      const next = toks[k + 1];
      if (next?.t === 'num' && /^\d+$/.test(next.v)) {
        out += [...next.v].map((d) => SUPERSCRIPT[d]).join('');
        k++;
        continue;
      }
      if (next?.t === 'lp') {
        const end = closing(toks, k + 1);
        const inner = toks.slice(k + 2, end);
        const text = inner.map((t) => t.v).join('');
        if (end > 0 && /^-?\d+$/.test(text)) {
          out += [...text].map((d) => SUPERSCRIPT[d]).join('');
          k = end;
          continue;
        }
      }
      out += '^';
    } else if (tok.t === 'op' && (tok.v === '+' || tok.v === '-')) {
      // binary after a value, otherwise it is a sign (like -5)
      const sign = tok.v === '-' ? '−' : '+';
      out += isValue(prev) ? ` ${sign} ` : tok.v === '-' ? '−' : '';
    } else if (tok.t === 'op' && tok.v === '*') {
      out += ' × ';
    } else if (tok.t === 'op' && tok.v === '/') {
      out += ' ÷ ';
    } else {
      out += tok.v;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** The whole tidy line: "15 + 4 × 3 =", "x = 10", "y = x²". */
export function formatStatementForDisplay(expression: string, name?: string, trailingEquals = true): string {
  const body = formatExpressionForDisplay(expression);
  const left = name ? `${name} = ${body}` : body;
  return trailingEquals ? `${left} =` : left;
}

/** "2 \\cdot 5" -> "2 . 5": a dot before a digit is a decimal point (the same rule the calculation uses). */
function decimalDots(latex: string): string {
  const t = latex.split(' ');
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== '\\cdot' || !/^\d$/.test(t[i + 1] ?? '')) continue;
    let j = i - 1;
    let hasPoint = false;
    while (j >= 0 && (/^\d$/.test(t[j]) || t[j] === '.')) {
      if (t[j] === '.') hasPoint = true;
      j--;
    }
    const directlyAfter = j === i - 1 ? (t[j] ?? '') : '';
    if (hasPoint || /^([a-zA-Z)]|\\pi)$/.test(directlyAfter)) continue;
    t[i] = '.';
  }
  return t.join(' ');
}

/** What the model read, readable for people: "1 8 + 4 \\times 3 =" -> "18 + 4 × 3 =". */
export function prettyReading(latex: string): string {
  return decimalDots(latex)
    .replace(/\\times/g, '×')
    .replace(/\\div/g, '÷')
    .replace(/\\cdot/g, '·')
    .replace(/\\sqrt/g, '√')
    .replace(/\\pi/g, 'π')
    .replace(/\\(sin|cos|tan|log|ln)/g, '$1')
    .replace(/\\frac/g, 'frac')
    .replace(/([\d.]) (?=[\d.])/g, '$1')
    .replace(/ ?([{}^]) ?/g, '$1');
}
