import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { parseStatement } from '../../src/math/latex.ts';
import { ACCURACY_SET, expectedExpression, handwrite } from './handwriting.ts';

test('baseline: ink-on original decoder on the accuracy set', async ({ page }) => {
  test.skip(!process.env.BENCH, 'benchmark only: BENCH=1 npx playwright test compare-inkon');
  test.setTimeout(900_000);
  await page.goto('http://localhost:5173/tests/e2e/fixtures/inkon.html');
  await expect(page).toHaveTitle('ready', { timeout: 120_000 });
  let correct = 0;
  const wrong: string[] = [];
  const ms: number[] = [];
  for (const text of ACCURACY_SET) {
    for (const seed of [1, 2, 3]) {
      const strokes = handwrite(text, { seed, mess: 0.6 }).map(({ points, lineWidth }) => ({ points, lineWidth }));
      const r = await page.evaluate((s) => (window as any).inkon(s), strokes);
      const st = parseStatement(r.latex);
      ms.push(r.ms);
      if (st.kind === 'solve' && st.expression === expectedExpression(text)) correct++;
      else wrong.push(`${text} -> ${r.latex}`);
    }
  }
  ms.sort((a, b) => a - b);
  const summary = { samples: 120, correct, accuracyPct: +((correct / 120) * 100).toFixed(1), medianMs: ms[60], wrong };
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/accuracy-inkon-baseline.json', JSON.stringify(summary, null, 2));
  console.log('ink-on baseline:', JSON.stringify(summary, null, 1));
});
