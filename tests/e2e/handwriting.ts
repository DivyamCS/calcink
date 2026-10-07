export interface Pt {
  x: number;
  y: number;
}
export interface SynthStroke {
  points: Pt[];
  lineWidth: number;
  /** index of the character in the written text this stroke belongs to */
  char: number;
}

type Shape = Array<Array<[number, number]>>; // strokes of (u, v) in a 0.6 x 1 box (v down)

const ell = (cx: number, cy: number, rx: number, ry: number, n = 28): Array<[number, number]> =>
  Array.from({ length: n + 1 }, (_, i): [number, number] => {
    const a = -Math.PI / 2 - (2 * Math.PI * i) / n;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  });

export const GLYPHS: Readonly<Record<string, Shape>> = {
  '0': [ell(0.3, 0.5, 0.26, 0.5)],
  '1': [[[0.12, 0.2], [0.34, 0], [0.34, 1]]],
  '2': [[[0.02, 0.25], [0.12, 0.06], [0.32, 0], [0.52, 0.12], [0.52, 0.35], [0.3, 0.62], [0.02, 1], [0.6, 1]]],
  '3': [[[0.03, 0.12], [0.25, 0], [0.5, 0.08], [0.52, 0.3], [0.25, 0.48], [0.52, 0.62], [0.55, 0.85], [0.3, 1], [0.02, 0.9]]],
  '4': [[[0.42, 0], [0.02, 0.65], [0.6, 0.65]], [[0.45, 0.3], [0.45, 1]]],
  '5': [[[0.55, 0], [0.1, 0], [0.06, 0.45], [0.35, 0.38], [0.58, 0.55], [0.56, 0.86], [0.3, 1], [0.02, 0.9]]],
  '6': [[[0.5, 0.03], [0.25, 0.15], [0.08, 0.5], [0.12, 0.86], [0.32, 1], [0.52, 0.88], [0.53, 0.64], [0.32, 0.54], [0.1, 0.7]]],
  '7': [[[0.02, 0], [0.6, 0], [0.22, 1]]],
  '8': [ell(0.3, 0.25, 0.21, 0.25), ell(0.3, 0.74, 0.27, 0.26)],
  '9': [ell(0.3, 0.27, 0.25, 0.27), [[0.55, 0.27], [0.5, 1]]],
  '+': [[[0, 0.5], [0.6, 0.5]], [[0.3, 0.2], [0.3, 0.8]]],
  '-': [[[0.02, 0.5], [0.55, 0.5]]],
  '×': [[[0.08, 0.28], [0.52, 0.72]], [[0.52, 0.28], [0.08, 0.72]]],
  '÷': [[[0, 0.5], [0.6, 0.5]], ell(0.3, 0.24, 0.035, 0.035, 8), ell(0.3, 0.76, 0.035, 0.035, 8)],
  '=': [[[0, 0.38], [0.6, 0.38]], [[0, 0.62], [0.6, 0.62]]],
  '(': [[[0.4, -0.05], [0.15, 0.22], [0.1, 0.5], [0.15, 0.78], [0.4, 1.05]]],
  ')': [[[0.1, -0.05], [0.35, 0.22], [0.4, 0.5], [0.35, 0.78], [0.1, 1.05]]],
  '.': [ell(0.15, 0.95, 0.03, 0.03, 8)],
  // handwritten letter x: two arcs back to back (not the symmetric "×" cross)
  x: [[[0.04, 0.48], [0.2, 0.52], [0.3, 0.74], [0.4, 0.96], [0.56, 1]], [[0.52, 0.48], [0.3, 0.74], [0.06, 1]]],
  y: [[[0.04, 0.45], [0.28, 0.82]], [[0.52, 0.45], [0.26, 1.02], [0.12, 1.28]]],
  // lowercase letters for function names (x-height: v from 0.45 to 1)
  s: [[[0.46, 0.52], [0.3, 0.45], [0.1, 0.52], [0.12, 0.66], [0.3, 0.72], [0.46, 0.8], [0.46, 0.94], [0.28, 1], [0.06, 0.94]]],
  i: [[[0.2, 0.47], [0.2, 1]], ell(0.2, 0.28, 0.03, 0.03, 8)],
  n: [[[0.06, 0.47], [0.06, 1]], [[0.06, 0.62], [0.2, 0.47], [0.4, 0.47], [0.48, 0.6], [0.48, 1]]],
  c: [[[0.48, 0.52], [0.3, 0.45], [0.1, 0.55], [0.06, 0.75], [0.12, 0.94], [0.3, 1], [0.48, 0.94]]],
  o: [ell(0.28, 0.73, 0.22, 0.27)],
  t: [[[0.24, 0.2], [0.24, 0.92], [0.34, 1], [0.46, 0.96]], [[0.06, 0.48], [0.44, 0.48]]],
  a: [[[0.46, 0.6], [0.32, 0.47], [0.12, 0.52], [0.06, 0.78], [0.18, 0.98], [0.36, 0.96], [0.46, 0.78]], [[0.46, 0.47], [0.46, 1]]],
  l: [[[0.22, 0], [0.22, 1]]],
  g: [ell(0.26, 0.68, 0.2, 0.22), [[0.46, 0.5], [0.46, 1.15], [0.3, 1.3], [0.08, 1.22]]],
  e: [[[0.08, 0.74], [0.46, 0.72], [0.4, 0.52], [0.24, 0.46], [0.08, 0.58], [0.06, 0.8], [0.18, 0.98], [0.36, 1], [0.48, 0.92]]],
};

const NARROW = new Set(['1', '.', '(', ')', 'i', 'l', 't']);
/** "²" etc.: a small raised digit. */
const SUPERSCRIPTS: Readonly<Record<string, string>> = { '²': '2', '³': '3' };

/** Small seeded PRNG (mulberry32) so every test run draws exactly the same "handwriting". */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface WriteOptions {
  x?: number;
  y?: number;
  /** glyph height in CSS px */
  size?: number;
  /** 0 = perfectly regular; 1 = typical messy handwriting */
  mess?: number;
  seed?: number;
  lineWidth?: number;
}

/** Strokes for `text` (characters from glyphs, spaces, ² ³). */
export function handwrite(text: string, opts: WriteOptions = {}): SynthStroke[] {
  const size = opts.size ?? 56;
  const mess = opts.mess ?? 0.6;
  const rand = rng(opts.seed ?? 1);
  const jitter = (amount: number): number => (rand() * 2 - 1) * amount * mess;
  const slant = jitter(0.15); // whole line leans the same way
  const strokes: SynthStroke[] = [];
  let pen = opts.x ?? 100;
  const base = opts.y ?? 100;

  let charIndex = -1;
  for (const raw of text) {
    charIndex++;
    if (raw === ' ') {
      pen += size * 0.35;
      continue;
    }
    const sup = SUPERSCRIPTS[raw];
    const ch = sup ?? raw;
    const shape = GLYPHS[ch];
    if (!shape) throw new Error(`no glyph for ${JSON.stringify(raw)}`);
    const h = size * (sup ? 0.55 : 1) * (1 + jitter(0.1));
    const top = base + (sup ? -size * 0.25 : 0) + jitter(size * 0.06);
    const rot = jitter(0.08);
    for (const s of shape) {
      const pts: Pt[] = [];
      for (let i = 0; i < s.length; i++) {
        const [u0, v0] = s[i];
        const [u1, v1] = s[Math.min(i + 1, s.length - 1)];
        const steps = i === s.length - 1 ? 1 : Math.max(1, Math.ceil((Math.hypot(u1 - u0, v1 - v0) * h) / 3));
        for (let k = 0; k < steps; k++) {
          const t = k / steps;
          const u = u0 + (u1 - u0) * t;
          const v = v0 + (v1 - v0) * t;
          const lx = u * h + (0.5 - v) * h * slant;
          const ly = v * h;
          pts.push({
            x: pen + lx * Math.cos(rot) - ly * Math.sin(rot) + jitter(0.8),
            y: top + lx * Math.sin(rot) + ly * Math.cos(rot) + jitter(0.8),
          });
        }
      }
      strokes.push({ points: pts, lineWidth: opts.lineWidth ?? 4, char: charIndex });
    }
    pen += h * (NARROW.has(ch) ? 0.55 : 0.82) + Math.max(0, jitter(size * 0.12)) + size * 0.06;
  }
  return strokes;
}

/** What the evaluator should receive for a test expression written with the glyph characters. */
export function expectedExpression(text: string): string {
  return text
    .replace(/=$/, '')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/²/g, '^(2)')
    .replace(/³/g, '^(3)')
    .replace(/\s/g, '');
}

/** The accuracy benchmark set: every digit, every operator, decimals, brackets, long and repeated numbers. */
export const ACCURACY_SET: readonly string[] = [
  '12+34=', '7×8=', '9÷0=', '100+5=', '10000+1=', '2+3×4=', '1111×2=', '56-78=', '3.5+1.25=', '0.5×4=',
  '(2+3)×4=', '45÷9=', '999+1=', '6×7=', '81-9×3=', '250÷5=', '12.5-0.5=', '3×(4+5)=', '88×11=', '1000-1=',
  '7.25×4=', '64÷8+2=', '5-8=', '90+10=', '123+456=', '2×2×2=', '40÷0=', '9.9+0.1=', '300×3=', '15-(4+6)=',
  '6.6÷2=', '77+33=', '4×25=', '0×9=', '18+4×3=', '36÷6×2=', '2.5×2.5=', '505+505=', '49-50=', '8+8+8=',
];
