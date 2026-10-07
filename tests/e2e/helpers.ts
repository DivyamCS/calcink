import { expect, type Page } from '@playwright/test';
import { handwrite, type SynthStroke, type WriteOptions } from './handwriting.ts';

export interface AnswerView {
  kind: string;
  text?: string;
  latex?: string;
  confidence?: number;
}

/** Open the app and wait until the model is loaded. */
export async function openApp(page: Page, query = ''): Promise<void> {
  await page.goto(`/${query}`);
  await expect(page.locator('#status-text')).toContainText('Ready', { timeout: 150_000 });
}

/** Draw strokes with real pointer events (mouse). */
export async function drawStrokes(page: Page, strokes: readonly SynthStroke[]): Promise<void> {
  for (const s of strokes) {
    await page.mouse.move(s.points[0].x, s.points[0].y);
    await page.mouse.down();
    for (const p of s.points.slice(1)) await page.mouse.move(p.x, p.y);
    await page.mouse.up();
  }
}

export async function write(page: Page, text: string, opts: WriteOptions = {}): Promise<SynthStroke[]> {
  const strokes = handwrite(text, opts);
  await drawStrokes(page, strokes);
  return strokes;
}

/** Answers currently on the page, top to bottom. */
export function answers(page: Page): Promise<AnswerView[]> {
  return page.evaluate(() => {
    const app = (window as unknown as { calcink: { app: { recognizer: { views: Array<{ result?: { latex: string; confidence?: number; answer: { kind: string; text?: string } } }> } } } }).calcink.app;
    return app.recognizer.views.map((v) =>
      v.result && !(v.result as { stale?: boolean }).stale ? { kind: v.result.answer.kind, text: v.result.answer.text, latex: v.result.latex, confidence: v.result.confidence } : { kind: 'pending' },
    );
  });
}

/** Wait until every line has been read and the status is back to Ready. */
export async function settled(page: Page): Promise<AnswerView[]> {
  await expect
    .poll(async () => (await answers(page)).every((a) => a.kind !== 'pending') && /Ready/.test((await page.textContent('#status-text')) ?? ''), {
      timeout: 60_000,
    })
    .toBe(true);
  return answers(page);
}

/** Bounding box of the strokes of one character of a written text. */
export function charBox(strokes: readonly SynthStroke[], char: number): { minX: number; minY: number; maxX: number; maxY: number } {
  const pts = strokes.filter((s) => s.char === char).flatMap((s) => s.points);
  return {
    minX: Math.min(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)),
    maxX: Math.max(...pts.map((p) => p.x)),
    maxY: Math.max(...pts.map((p) => p.y)),
  };
}
