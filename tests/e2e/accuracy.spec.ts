import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { parseStatement } from '../../src/math/latex.ts';
import { ACCURACY_SET, expectedExpression, handwrite } from './handwriting.ts';
import { openApp } from './helpers.ts';

interface Read {
  latex: string;
  confidence: number;
  ms: number;
}

test('arithmetic accuracy on synthetic handwriting is at least 95 %', async ({ page }, info) => {
  test.setTimeout(900_000);
  await openApp(page, '?beam=3'); // fixed beam (the default adapts to the device) so results are comparable
  const rows: Array<{ text: string; seed: number; latex: string; ok: boolean; confidence: number; ms: number }> = [];
  for (const text of ACCURACY_SET) {
    for (const seed of [1, 2, 3]) {
      const r: Read = await page.evaluate((s) => (window as any).calcink.read(s), handwrite(text, { seed, mess: 0.6 }));
      const st = parseStatement(r.latex);
      const ok = st.kind === 'solve' && st.expression === expectedExpression(text);
      rows.push({ text, seed, latex: r.latex, ok, confidence: r.confidence, ms: r.ms });
    }
  }
  const correct = rows.filter((r) => r.ok).length;
  const accuracy = correct / rows.length;
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const summary = {
    samples: rows.length,
    correct,
    accuracyPct: +(accuracy * 100).toFixed(1),
    medianMs: ms[Math.floor(ms.length / 2)],
    p95Ms: ms[Math.floor(ms.length * 0.95)],
    wrong: rows.filter((r) => !r.ok).map((r) => `${r.text} -> ${r.latex} (confidence ${r.confidence.toFixed(2)})`),
  };
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/accuracy.json', JSON.stringify({ summary, rows }, null, 2));
  info.annotations.push({ type: 'accuracy', description: JSON.stringify(summary) });
  console.log('accuracy:', JSON.stringify(summary, null, 1));
  expect(accuracy).toBeGreaterThanOrEqual(0.95);
});

test('variables and graphs are read as statements', async ({ page }) => {
  await openApp(page);
  const cases: Array<[string, Record<string, unknown>]> = [
    ['x=10', { kind: 'assign', name: 'x', expression: '10' }],
    ['x+5=', { kind: 'solve', expression: 'x+5' }],
    ['2x+1=', { kind: 'solve', expression: '2x+1' }],
    ['y=x²', { kind: 'plot', expression: 'x^(2)' }],
    ['y=2x+1', { kind: 'plot', expression: '2x+1' }],
  ];
  for (const [text, expected] of cases) {
    const r: Read = await page.evaluate((s) => (window as any).calcink.read(s), handwrite(text, { seed: 2, mess: 0.6 }));
    expect(parseStatement(r.latex), `${text} read as ${r.latex}`).toMatchObject(expected);
  }
});

test('same result for any pen width and writing size', async ({ page }) => {
  test.setTimeout(600_000);
  await openApp(page, '?beam=3');
  // before normalisation: 0/12 at pen width 10 and 16, and "7" read as "1" with a thin pen on big writing
  const set = ['12+34=', '7×8=', '18+4×3=', '3.5+1.25=', '45÷9=', '0.5×4='];
  const wrong: string[] = [];
  for (const [size, lineWidth] of [[30, 2], [30, 16], [56, 9], [56, 16], [120, 2], [160, 16]] as const) {
    for (const text of set) {
      const r: Read = await page.evaluate((s) => (window as any).calcink.read(s), handwrite(text, { seed: 1, size, lineWidth }));
      const st = parseStatement(r.latex);
      if (!(st.kind === 'solve' && st.expression === expectedExpression(text))) wrong.push(`${size}px/${lineWidth}: ${text} -> ${r.latex}`);
    }
  }
  expect(wrong, wrong.join('\n')).toEqual([]);
});
