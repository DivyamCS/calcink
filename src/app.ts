// Wires the canvas, line recogniser, answer overlay and toolbar together.
// The recogniser is passed in so tests can use a fake one.
import { haptic } from './feedback.ts';
import { errorWait } from './reveal.ts';
import { overlaps, placeCard, type Box, type Placement } from './place.ts';
import { InkCanvas } from './ink/canvas.ts';
import { answerPlacement, findRules, medianGlyphHeight, pointsBBox, writingHeight } from './ink/geometry.ts';
import { findColumns, type Column } from './math/column.ts';
import type { Line, Size, Stroke, Tool } from './ink/types.ts';
import { formatStatementForDisplay, prettyReading } from './math/display.ts';
import { graphFunction, graphImplicit, graphSides, niceTicks, tickLabel, type Graph } from './math/graph.ts';
import { formatExpressionForDisplay } from './math/display.ts';
import type { Answer } from './math/solve.ts';
import { LineRecognizer } from './recognition/line-recognizer.ts';
import type { LineResult, Recognizer, RecognizerStatus } from './recognition/types.ts';
import type { ModelState } from './recognition/worker-recognizer.ts';

export interface AppOptions {
  /** Element that becomes the drawing surface. */
  surface: HTMLElement;
  /** Toolbar / status elements (looked up by the markup in index.html). */
  root?: ParentNode;
  makeRecognizer: (onModelState: (state: ModelState) => void) => Recognizer;
  debounceMs?: number;
  /** Replace the handwriting of a read line by clean text in the answer font. Default: false (your own ink stays). */
  tidy?: boolean;
  /** Draw graph cards for y = ... and other equations. Default: the last choice on this device, else off. */
  graphs?: boolean;
  /** Keep the page in localStorage so a reload doesn't lose it. Default: true. */
  keepPage?: boolean;
}

const PAGE_KEY = 'calcink.page';
const round1 = (v: number): number => Math.round(v * 10) / 10;

/** Strokes as compact JSON: [x, y] or [x, y, pressure] per point. */
function pageToJson(strokes: readonly Stroke[]): string {
  return JSON.stringify(
    strokes.map((s) => ({
      w: s.lineWidth,
      c: s.color,
      p: s.points.map((p) => (p.p === undefined ? [round1(p.x), round1(p.y)] : [round1(p.x), round1(p.y), Math.round(p.p * 100) / 100])),
    })),
  );
}

function pageFromJson(text: string | null): Stroke[] {
  if (!text) return [];
  try {
    const data = JSON.parse(text) as Array<{ w: number; c?: string; p: number[][] }>;
    if (!Array.isArray(data)) return [];
    return data
      .filter((s) => Array.isArray(s.p) && s.p.length > 0 && Number.isFinite(s.w))
      .map((s, i) => ({
        id: i + 1,
        lineWidth: s.w,
        color: typeof s.c === 'string' ? s.c : undefined,
        points: s.p.filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1])).map((q) => (q.length > 2 ? { x: q[0], y: q[1], p: q[2] } : { x: q[0], y: q[1] })),
      }));
  } catch {
    return [];
  }
}

/** "x = 5" / "y = 3": also drawn as a vertical / horizontal line when graphs are on. */
function lineValue(a: Answer): { name: 'x' | 'y'; c: number } | null {
  if (a.kind !== 'assigned' || (a.name !== 'x' && a.name !== 'y')) return null;
  const c = Number(a.text.replace(/−/g, '-'));
  return Number.isFinite(c) ? { name: a.name, c } : null;
}

/** Examples for the empty page, one picked at random. */
export const HINT_EXAMPLES = ['√144 + 3² =', '2.5 × (8 − 3) =', '(15 + 30) × 2 =', '7² − 4 × 6 =', '3/4 + 0.25 =', '2x + 4 = 10'];
export const PAPERS = ['lines', 'grid', 'dots', 'plain'] as const;
export type Paper = (typeof PAPERS)[number];

/** localStorage that never throws (private mode, blocked storage): a remembered choice is only a convenience. */
const pref = {
  get(key: string): string | null {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // not remembered, still works
    }
  },
};

export interface AppHandle {
  canvas: InkCanvas;
  recognizer: LineRecognizer;
  /** What was actually painted next to each line in the last frame (answer kind or 'hidden'); for tests. */
  readonly painted: readonly string[];
  /** graph cards on? */
  readonly graphs: boolean;
  /** graph cards drawn in the last frame (for tests) */
  readonly cards: number;
  /** where things were painted in the last frame (css px), for layout tests */
  readonly layout: { width: number; height: number; cards: Box[]; texts: Box[]; ink: Box[]; skipped: number; faded: number };
  /** graph cards drawn in the last frame: caption and marked points (for tests) */
  readonly drawnGraphs: ReadonlyArray<{ caption: string; marks: ReadonlyArray<{ x: number; y: number; kind: string }> }>;
  /** column sums on the page in the last frame: the answer under each rule ('...' while a row is being read) */
  readonly columns: readonly string[];
  setTidy(on: boolean): void;
  dispose(): void;
}

const INK = '#1c2541';
const TYPESET_COLOR = '#14161c'; // the clean text that replaces the handwriting
const MUTED = '#8a8473';
const UNSURE = '#c27c0e';
const ANSWER_COLORS = {
  value: '#0b6e4f',
  undefined: '#b3261e',
  error: '#7a7468',
  assigned: '#0b6e4f',
  plot: '#2456a6',
  solved: '#0b6e4f',
} as const;
/** curve colours: main, and the right-hand side of an x-only equation */
const CURVE_COLORS = ['#2456a6', '#c9541a'] as const;
/** height / width of a graph card (implicit curves are traced with the same aspect, so circles stay round) */
const GRAPH_ASPECT = 0.68;
/** Bundled with the app (works offline); system handwriting fonts only as a fallback. */
export const ANSWER_FONT =
  '"Caveat", "Segoe Print", "Bradley Hand", "Chalkboard SE", "Marker Felt", "Comic Sans MS", cursive';
const UI_FONT = '"Segoe UI", system-ui, -apple-system, sans-serif';
/** The answer is "written" left to right over this time. */
const WRITE_MS = 420;
/** Below this the model's least certain symbol is flagged as unsure (dotted underline + status line). */
export const LOW_CONFIDENCE = 0.6;
/** Quiet time after the last pen-up before we read the writing. Pen-down already blocks reading. */
export const DEFAULT_PAUSE_MS = 800;

const easeOut = (t: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Tidy text for a line, or null when we have nothing reliable to show instead of the ink. */
function tidyText(a: Answer): string | null {
  switch (a.kind) {
    case 'value':
    case 'undefined':
      return formatStatementForDisplay(a.expression);
    case 'assigned':
      return formatStatementForDisplay(a.expression, a.name, a.show);
    case 'plot':
      return formatStatementForDisplay(a.expression, 'y', false);
    case 'solved':
    case 'curve':
      return `${formatExpressionForDisplay(a.leftText)} = ${formatExpressionForDisplay(a.rightText)}`;
    default:
      return null;
  }
}

export function createApp(opts: AppOptions): AppHandle {
  const root: ParentNode = opts.root ?? document;
  const $ = <T extends HTMLElement>(sel: string): T | null => root.querySelector<T>(sel);

  const hint = $('#hint');
  const keepPage = opts.keepPage ?? true;
  let saveTimer = 0;
  const statusText = $('#status-text');
  const statusDot = $('#status-dot');
  const statusEl = $('.status');
  const toolbarBox = $('.toolbar');
  const undoBtn = $<HTMLButtonElement>('#undo');
  const redoBtn = $<HTMLButtonElement>('#redo');
  const clearBtn = $<HTMLButtonElement>('#clear');
  const widthInput = $<HTMLInputElement>('#width');
  const widthDot = $('#width-dot');
  const tidyBtn = $<HTMLButtonElement>('#tidy');
  const colorBtn = $<HTMLButtonElement>('#color');
  const graphsBtn = $<HTMLButtonElement>('#graphs');
  const paperBtn = $<HTMLButtonElement>('#paper');
  const papersMenu = $<HTMLElement>('#papers');
  const paperChoices = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-paper]'));
  let graphsOn = opts.graphs ?? pref.get('calcink.graphs') === 'on';
  const hintEq = $('#hint-eq');
  if (hintEq) hintEq.textContent = HINT_EXAMPLES[Math.floor(Math.random() * HINT_EXAMPLES.length)];
  const palette = $<HTMLElement>('#palette');
  const swatches = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-color]'));
  let tidy = opts.tidy ?? false;
  let inkRevealed = false; // true while the user is erasing: show their own handwriting, not the tidy text
  const toolButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-tool]'));
  const reducedMotion =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // status line

  let model: ModelState = { phase: 'loading' };
  let recog: RecognizerStatus = { phase: 'idle' };

  /** What the model read on the most recently answered line, how sure it was, and why an answer is missing. */
  function lastReading(): string {
    const seen = (holder.lines?.views ?? []).filter((v) => v.result && v.result.latex && !v.result.stale);
    const r = seen[seen.length - 1]?.result;
    if (!r) return '';
    let text = ` · read: ${prettyReading(r.latex)}`;
    if (r.confidence !== undefined) text += ` · ${Math.round(r.confidence * 100)}% sure`;
    if (r.answer.kind === 'error' && r.answer.reason) text += ` · ${r.answer.reason}`;
    if (/\\(sin|cos|tan)/.test(r.latex)) text += ' · angles in radians';
    if (r.ms > 0) text += ` · ${r.ms} ms`;
    return text;
  }

  function renderStatus(): void {
    if (!statusText || !statusDot) return;
    let text: string;
    let tone: 'busy' | 'ok' | 'bad';

    if (model.phase === 'loading') {
      const pct = model.progress !== undefined ? ` ${Math.round(model.progress * 100)}%` : '';
      text = `Loading handwriting model…${pct} (first visit only, then it works offline)`;
      tone = 'busy';
    } else if (model.phase === 'failed') {
      text = `Model failed to load: ${model.message}`;
      tone = 'bad';
    } else if (recog.phase === 'error') {
      text = `Couldn't read that: ${recog.message}`;
      tone = 'bad';
    } else if (recog.phase === 'waiting') {
      text = 'Waiting until you finish writing…';
      tone = 'busy';
    } else if (recog.phase === 'recognizing') {
      text = 'Reading your writing…';
      tone = 'busy';
    } else {
      text = (navigator.onLine ? 'Ready · runs entirely on your device' : 'Ready · working offline') + lastReading();
      tone = 'ok';
    }
    statusText.textContent = text;
    statusDot.dataset.tone = tone;
  }

  // recognition

  // A recogniser may report its state synchronously (before `lineRecognizer` exists), so go through a holder.
  const holder: { lines?: LineRecognizer } = {};

  const recognizerImpl = opts.makeRecognizer((state) => {
    model = state;
    renderStatus();
    // lines that failed while the model was still loading deserve another go
    if (state.phase === 'ready') holder.lines?.retry();
  });

  const lineRecognizer: LineRecognizer = new LineRecognizer({
    recognizer: recognizerImpl,
    debounceMs: opts.debounceMs ?? DEFAULT_PAUSE_MS,
    onChange: () => {
      canvas.invalidateOverlay();
      renderStatus();
    },
    onStatus: (s) => {
      recog = s;
      renderStatus();
    },
  });

  holder.lines = lineRecognizer;

  // error marks wait for a real pause (see reveal.ts)

  let lastInkChange = -Infinity;
  let penDown = false;
  let errorTimer = 0;
  /** Repaint once the earliest held-back error mark is due. */
  function wakeForErrors(wait: number): void {
    if (!Number.isFinite(wait)) return; // pen is down: lifting it repaints anyway
    clearTimeout(errorTimer);
    errorTimer = window.setTimeout(() => canvas.invalidateOverlay(), Math.max(16, wait + 16));
  }

  // canvas

  const canvas = new InkCanvas(opts.surface, {
    lineWidth: widthInput ? Number(widthInput.value) : 4,
    inkColor: INK,
    onChange: (strokes) => {
      if (hint) hint.hidden = strokes.length > 0;
      lastInkChange = performance.now();
      lineRecognizer.update(strokes);
      if (keepPage) {
        clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => pref.set(PAGE_KEY, pageToJson(strokes)), 400);
      }
    },
    onActive: (active) => {
      penDown = active;
      // style.css stops the status dot pulsing while this is set, so only the ink repaints during a stroke
      document.documentElement.toggleAttribute('data-writing', active);
      if (!active) touchedCards.clear();
      lastInkChange = performance.now();
      lineRecognizer.setWriting(active);
      canvas.invalidateOverlay();
    },
    onRevealInk: (on) => {
      inkRevealed = on;
      canvas.invalidateOverlay();
    },
    onHistory: ({ canUndo, canRedo }) => {
      if (undoBtn) undoBtn.disabled = !canUndo;
      if (redoBtn) redoBtn.disabled = !canRedo;
      if (clearBtn) clearBtn.disabled = canvas.currentStrokes.length === 0;
    },
  });

  // answers on the paper

  /** When each answer first appeared, for the write-on animation (and to give the haptic tick once). */
  const shownAt = new Map<string, number>();
  // graphs are cached per answer and built in idle time (the first one can take ~70 ms)
  const graphs = new WeakMap<object, Map<string, Graph>>();
  const pendingGraphs = new WeakMap<object, Set<string>>();
  function graphFor(answer: Answer, at?: number): Graph | undefined {
    const key = String(at);
    const ready = graphs.get(answer)?.get(key);
    const pending = pendingGraphs.get(answer) ?? new Set<string>();
    if (ready || pending.has(key)) return ready;
    pending.add(key);
    pendingGraphs.set(answer, pending);
    const build = (): void => {
      const byAt = graphs.get(answer) ?? new Map<string, Graph>();
      byAt.set(key, buildGraph(answer, at));
      graphs.set(answer, byAt);
      canvas.invalidateOverlay();
    };
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (idle) idle(build, { timeout: 120 });
    else setTimeout(build, 0);
    return undefined;
  }
  let lastSize: Size = { width: 0, height: 0 };
  /** rectangles a graph card must not cover: cards placed so far, every line's ink, every answer's text */
  const cardRects: Box[] = [];
  const textRects: Box[] = [];
  let inkRects: readonly Box[] = [];
  /** graph cards waiting for the second pass of a frame */
  const cardQueue: Array<{ line: Line; answer: Answer; w: number; h: number; x: number; alpha: number; at?: number }> = [];
  /** for each y = f(x) line: the value given to x on the nearest line below it, marked on its graph */
  let xBelow = new Map<string, number>();

  /** Toolbar rect in page coordinates, so graph cards stay clear of it. */
  function chromeRects(dy = 0, dx = 0): Box[] {
    if (!toolbarBox) return [];
    const base = opts.surface.getBoundingClientRect();
    const r = toolbarBox.getBoundingClientRect();
    if (r.width === 0) return [];
    return [{ minX: r.left - base.left + dx, minY: r.top - base.top + dy, maxX: r.right - base.left + dx, maxY: r.bottom - base.top + dy }];
  }

  /** Height of the strip at the bottom of the screen taken by the status pill (and its margin). */
  function statusStrip(): number {
    if (!statusEl) return 0;
    const base = opts.surface.getBoundingClientRect();
    const r = statusEl.getBoundingClientRect();
    return r.height === 0 ? 0 : Math.max(0, base.bottom - r.top) + 6;
  }

  /** Fade the status pill while ink, an answer or a graph is under it, so it never hides your work. */
  function statusCover(): void {
    if (!statusEl) return;
    const base = opts.surface.getBoundingClientRect();
    const r = statusEl.getBoundingClientRect();
    const y = canvas.scrollY;
    const x = canvas.scrollX;
    const box = { minX: r.left - base.left + x, minY: r.top - base.top + y, maxX: r.right - base.left + x, maxY: r.bottom - base.top + y };
    const covered = [...inkRects, ...textRects, ...cardRects].some((o) => overlaps(o, box, 4));
    if (covered !== (statusEl.dataset.covered === 'true')) statusEl.dataset.covered = String(covered);
  }
  /** placements of the last frame, reused while nothing on the page moved (the search is a few ms) */
  let placeMemo: { key: string; spots: Array<Placement | null> } | null = null;
  /** cards (by line id) the pen has passed over during the current stroke */
  const touchedCards = new Set<string>();
  const onPenMove = (e: PointerEvent): void => {
    if (!penDown || !placeMemo) return;
    const base = opts.surface.getBoundingClientRect();
    const x = e.clientX - base.left + canvas.scrollX;
    const y = e.clientY - base.top + canvas.scrollY; // page coordinates
    cardQueue.forEach((c, i) => {
      const b = placeMemo?.spots[i]?.box;
      if (!b || touchedCards.has(c.line.id) || x < b.minX - 12 || x > b.maxX + 12 || y < b.minY - 12 || y > b.maxY + 12) return;
      touchedCards.add(c.line.id);
      canvas.invalidateOverlay();
    });
  };
  opts.surface.addEventListener('pointermove', onPenMove);
  const onPenDown = (e: PointerEvent): void => queueMicrotask(() => onPenMove(e)); // after the canvas marked the pen down
  opts.surface.addEventListener('pointerdown', onPenDown);
  let drawn: Array<{ caption: string; marks: ReadonlyArray<{ x: number; y: number; kind: string }> }> = [];
  /** graph cards that found no room in the last frame */
  let skippedCards = 0;

  // second pass: place each graph card in the nearest free spot (see place.ts), shrink it or leave it out
  function placeCards(ctx: CanvasRenderingContext2D, size: Size, progress: (key: string, tone?: 'answer' | 'error') => number): void {
    const ui = chromeRects();
    // the whole page (writing plus the fresh paper below it), so a card may sit below the screen: scroll to it
    const pageH = canvas.pageHeight;
    const bounds = { minX: 12, minY: 12, maxX: size.width - 12, maxY: pageH - 12 };
    const r = (b: Box): string => `${Math.round(b.minX)},${Math.round(b.minY)},${Math.round(b.maxX)},${Math.round(b.maxY)}`;
    const key = [size.width, pageH, ...ui.map(r), ...inkRects.map(r), ...textRects.map(r), ...cardQueue.map((c) => `${c.line.id}|${c.w}|${Math.round(c.x)}`)].join(';');
    // placements are kept while you scroll (the key has no scroll in it): cards never jump under your eyes
    const screenBottom = canvas.scrollY + size.height - statusStrip();
    if (!placeMemo || placeMemo.key !== key) {
      // also where the toolbar floats right now, so a card placed while scrolled is not hidden under it (not part
      // of the key: scrolling alone never moves cards)
      const scrolled = canvas.scrollY > 0 || canvas.scrollX > 0;
      const fixed = [...ui, ...(scrolled ? chromeRects(canvas.scrollY, canvas.scrollX) : []), ...inkRects, ...textRects];
      const placed: Box[] = [];
      const spots = cardQueue.map((c) => {
        // an equation on screen keeps its card on screen when it can (above the status pill)
        const onScreen = c.line.bbox.maxY <= screenBottom;
        const spot = placeCard({ x: c.x, y: Math.max(bounds.minY, c.line.bbox.minY - 6) }, c.w, c.h, [...fixed, ...placed], bounds, onScreen ? { softBottom: screenBottom } : {});
        if (spot) placed.push(spot.box);
        return spot;
      });
      placeMemo = { key, spots };
    }
    skippedCards = 0;
    drawn = [];
    cardQueue.forEach((c, i) => {
      const spot = placeMemo!.spots[i];
      if (!spot) {
        // nowhere to put it without covering something: say so quietly instead of piling cards up
        skippedCards++;
        const note = 'no room for the graph';
        ctx.save();
        ctx.font = `italic 13px ${UI_FONT}`;
        ctx.fillStyle = MUTED;
        ctx.textBaseline = 'middle';
        const nx = Math.min(c.x, size.width - 12 - ctx.measureText(note).width);
        ctx.fillText(note, nx, (c.line.bbox.minY + c.line.bbox.maxY) / 2);
        ctx.restore();
        return;
      }
      const { box } = spot;
      cardRects.push(box);
      const graph = graphFor(c.answer, c.at);
      if (!graph) return;
      drawn.push({ caption: tidyText(c.answer) ?? '', marks: graph.marks });
      ctx.save();
      // the pen went over this card: it steps back so the ink being written stays visible (it moves away once
      // the pen lifts, because the new ink becomes an obstacle)
      ctx.globalAlpha = touchedCards.has(c.line.id) ? c.alpha * 0.12 : c.alpha;
      drawGraph(ctx, graph, c.answer, box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY, progress(`${c.line.id}|graph|${tidyText(c.answer)}|${c.at}`, 'answer'));
      ctx.restore();
    });
  }
  /** per line, what the last frame painted (exposed for tests) */
  let painted: string[] = [];
  let columnTexts: string[] = [];
  /** rules under columns, recomputed only when the ink changes */
  let rulesFor: { strokes: readonly unknown[]; rules: Box[]; glyph: number } | null = null;
  function columnsNow(): Column[] {
    const strokes = canvas.currentStrokes;
    if (!rulesFor || rulesFor.strokes !== strokes) {
      rulesFor = { strokes, rules: findRules(strokes).map((r) => pointsBBox(r.points)), glyph: medianGlyphHeight(strokes) };
    }
    if (rulesFor.rules.length === 0) return [];
    const lines = lineRecognizer.views.map((v) => ({ id: v.line.id, bbox: v.line.bbox, latex: v.result && !v.result.stale ? v.result.latex : undefined }));
    return findColumns(rulesFor.rules, lines, rulesFor.glyph);
  }

  /** The sum of a column, right-aligned under its rule like the digits above it. */
  function drawColumn(ctx: CanvasRenderingContext2D, col: Column, rowLines: Line[], progress: (key: string, tone?: 'answer' | 'error') => number): void {
    const a = col.answer;
    if (!a) return;
    // measured per row: stacked digits of different rows must not merge into one tall "glyph"
    const hs = rowLines.map((l) => writingHeight(l.strokes)).sort((p, q) => p - q);
    const glyph = hs.length ? hs[Math.floor(hs.length / 2)] : 40;
    const px = clamp(glyph * 1.3, 22, 150);
    ctx.save();
    ctx.font = `${a.kind === 'undefined' ? 'italic ' : ''}600 ${px}px ${ANSWER_FONT}`;
    ctx.fillStyle = ANSWER_COLORS[a.kind];
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(a.text).width;
    const x = Math.max(4, col.right - w);
    const y = col.rule.maxY + px * 0.62;
    const k = progress(`${Math.round(col.rule.minX)},${Math.round(col.rule.minY)}|column|${a.text}`, a.kind === 'error' ? 'error' : 'answer');
    writeText(ctx, a.text, x, y, k, px);
    textRects.push({ minX: x, minY: y - px * 0.6, maxX: x + w, maxY: y + px * 0.6 });
    ctx.restore();
  }

  canvas.setOverlayRenderer((ctx: CanvasRenderingContext2D, size: Size) => {
    const now = performance.now();
    const live = new Set<string>();
    const hide = new Set<number>(); // strokes shown as clean text instead of ink
    let animating = false;

    /** 0..1 progress of the appearance animation of `key`; vibrates once the first time. */
    const progress = (key: string, tone?: 'answer' | 'error'): number => {
      live.add(key);
      if (!shownAt.has(key)) {
        shownAt.set(key, now);
        if (tone) haptic(tone);
      }
      if (reducedMotion) return 1;
      const t = (now - (shownAt.get(key) as number)) / WRITE_MS;
      if (t < 1) animating = true;
      return easeOut(t);
    };

    const frame: string[] = [];
    lastSize = size;
    let soonestError = Infinity;
    // graph cards placed so far this frame; later cards avoid them and the ink of other lines
    cardRects.length = 0;
    textRects.length = 0;
    cardQueue.length = 0;
    inkRects = lineRecognizer.views.map((v) => v.line.bbox);
    xBelow = new Map();
    let nextX: number | undefined;
    for (let i = lineRecognizer.views.length - 1; i >= 0; i--) {
      const r = lineRecognizer.views[i].result;
      if (!r || r.stale) continue;
      const v = lineValue(r.answer);
      if (v?.name === 'x') nextX = v.c;
      else if (r.answer.kind === 'plot' && nextX !== undefined) xBelow.set(lineRecognizer.views[i].line.id, nextX);
    }
    // column arithmetic: the rows of a column get one answer under the rule, not one each
    const columns = columnsNow();
    // ruled lines are ink too (they belong to no line): a card never covers one
    if (rulesFor && rulesFor.strokes === canvas.currentStrokes && rulesFor.rules.length) inkRects = [...inkRects, ...rulesFor.rules];
    const inColumn = new Set(columns.flatMap((c) => c.rows));
    const texts: string[] = [];
    for (const col of columns) {
      const rowLines = lineRecognizer.views.filter((v) => col.rows.includes(v.line.id)).map((v) => v.line);
      if (col.answer?.kind === 'error') {
        const wait = errorWait(now, lastInkChange, penDown);
        if (wait > 0) {
          soonestError = Math.min(soonestError, wait);
          texts.push('…');
          continue;
        }
      }
      texts.push(col.answer ? col.answer.text : '…');
      drawColumn(ctx, col, rowLines, progress);
    }
    columnTexts = texts;
    for (const { line, result } of lineRecognizer.views) {
      if (inColumn.has(line.id)) {
        frame.push('column');
        continue;
      }
      if (!result || result.answer.kind === 'none') {
        frame.push('none');
        continue;
      }
      if (result.answer.kind === 'error') {
        // "?" waits for a real pause so it never flickers next to the pen while you write
        const wait = errorWait(now, lastInkChange, penDown);
        if (wait > 0) {
          soonestError = Math.min(soonestError, wait);
          frame.push('hidden');
          continue;
        }
      }
      frame.push(result.answer.kind);
      drawLine(ctx, size, line, result, progress, hide);
    }
    placeCards(ctx, size, progress);
    statusCover();
    painted = frame;
    if (soonestError < Infinity) wakeForErrors(soonestError);

    for (const key of shownAt.keys()) if (!live.has(key)) shownAt.delete(key);
    canvas.setHiddenStrokes(hide);
    if (animating) canvas.invalidateOverlay();
  });

  /** Text that appears as if written left to right (clip reveal). */
  function writeText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, k: number, fontPx: number): number {
    const w = ctx.measureText(text).width;
    ctx.save();
    if (k < 1) {
      ctx.beginPath();
      ctx.rect(x - 4, y - fontPx * 1.2, (w + 8) * k, fontPx * 2.4);
      ctx.clip();
    }
    ctx.fillText(text, x, y);
    ctx.restore();
    return w;
  }

  function drawLine(
    ctx: CanvasRenderingContext2D,
    size: Size,
    line: Line,
    result: LineResult,
    progress: (key: string, tone?: 'answer' | 'error') => number,
    hide: Set<number>,
  ): void {
    const answer = result.answer;
    const glyph = writingHeight(line.strokes);
    const place = answerPlacement(line, glyph);
    // Caveat's digits are about 0.66 em tall: this makes typed digits roughly as tall as the handwritten ones
    let fontSize = clamp(glyph * 1.3, 22, 150);
    const font = (px: number, italic = false): string => `${italic ? 'italic ' : ''}600 ${px}px ${ANSWER_FONT}`;
    const unsure = result.confidence !== undefined && result.confidence < LOW_CONFIDENCE;

    // what goes right of "=" (text answers); plots and plain assignments are handled separately
    let answerText: string | null = null;
    let color: string = ANSWER_COLORS.value;
    let tone: 'answer' | 'error' = 'answer';
    let small = false;
    if (answer.kind === 'value' || answer.kind === 'undefined' || answer.kind === 'error') {
      answerText = answer.text;
      color = ANSWER_COLORS[answer.kind];
      tone = answer.kind === 'error' ? 'error' : 'answer';
    } else if (!graphsOn && (answer.kind === 'plot' || answer.kind === 'curve')) {
      // graphs are off: the equation is kept (y = f(x) can be used further down), a quiet tick says so
      answerText = '✓';
      color = MUTED;
      small = true;
    } else if (answer.kind === 'solved') {
      answerText = answer.text; // "x = 3", "x ~ -1.895, 0, 1.895"
      color = answer.solutions.length ? ANSWER_COLORS.solved : MUTED;
    } else if (answer.kind === 'assigned') {
      if (answer.show) answerText = answer.text;
      else {
        answerText = answer.literal ? '✓' : `→ ${answer.text}`; // "x = 3 + 4" quietly confirms x is 7
        color = MUTED;
        small = true;
      }
    }
    const italic = answer.kind === 'undefined';

    // Tidy text only while writing with the pen: with an eraser in hand you must see where your real ink is,
    // and an answer that is being re-read (stale) is shown over the ink, faded.
    const typeset = tidy && canvas.tool === 'pen' && !inkRevealed && !result.stale ? tidyText(answer) : null;
    const cy = typeset !== null ? (line.bbox.minY + line.bbox.maxY) / 2 : place.y;
    let x = place.x;
    let y = place.y;

    ctx.save();
    ctx.textBaseline = 'middle';
    if (result.stale) ctx.globalAlpha = 0.35;

    if (typeset !== null) {
      const left = line.bbox.minX;
      const gap = (px: number): number => Math.max(12, px * 0.3);
      const widthAt = (px: number): number => {
        ctx.font = font(px);
        let w = ctx.measureText(typeset).width;
        if (answerText) {
          ctx.font = font(small ? px * 0.6 : px, italic);
          w += gap(px) + ctx.measureText(answerText).width;
        }
        return w;
      };
      // shrink if "15 + 4 = 19" would not fit on the page
      const room = size.width - left - 12;
      const total = widthAt(fontSize);
      if (total > room && room > 0) fontSize = Math.max(14, fontSize * (room / total));

      const tk = progress(`${line.id}|tidy|${typeset}`);
      ctx.font = font(fontSize);
      ctx.fillStyle = TYPESET_COLOR;
      ctx.globalAlpha = tk;
      ctx.fillText(typeset, left, cy);
      x = left + ctx.measureText(typeset).width + gap(fontSize);
      y = cy;
      // the ink goes away once the clean text is mostly visible (a short cross-fade)
      if (tk >= 0.5) for (const st of line.strokes) hide.add(st.id);
      ctx.globalAlpha = 1;
    }

    if (answerText !== null) {
      const px = small ? fontSize * 0.6 : fontSize;
      ctx.font = font(px, italic);
      ctx.fillStyle = color;
      // keyed by the line's position and text, so a re-read that gives the same answer does not replay
      const k = progress(`${Math.round(line.bbox.minX)},${Math.round(line.bbox.minY)}|${answer.kind}|${answerText}`, small || result.stale ? undefined : tone);
      let width = ctx.measureText(answerText).width;
      if (typeset === null && x + width > size.width - 12) {
        // no room on the right: tuck the answer under the equation instead
        x = line.bbox.minX;
        y = line.bbox.maxY + px * 0.75;
        // a very long number (like 40 digits) can still be wider than the screen: shrink it to fit
        const room = size.width - x - 12;
        if (width > room && room > 0) {
          ctx.font = font(Math.max(12, px * (room / width)), italic);
          width = ctx.measureText(answerText).width;
        }
      }
      const tw = writeText(ctx, answerText, x, y, k, px);
      textRects.push({ minX: x, minY: y - px * 0.6, maxX: x + tw, maxY: y + px * 0.6 });

      // the model was unsure about at least one symbol: dotted amber underline
      if (unsure && !small && !result.stale && k >= 1) {
        ctx.strokeStyle = UNSURE;
        ctx.lineWidth = Math.max(1.5, px * 0.05);
        ctx.setLineDash([2, Math.max(4, px * 0.12)]);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x, y + px * 0.42);
        ctx.lineTo(x + width, y + px * 0.42);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    if (graphsOn && (answer.kind === 'plot' || answer.kind === 'solved' || answer.kind === 'curve' || lineValue(answer) !== null)) {
      // placed after every line's text is on the page (placeCards), so a card never covers a later answer
      const w = clamp(glyph * 7, 280, Math.min(420, size.width - 24));
      const after = answerText !== null ? x + ctx.measureText(answerText).width + 16 : x;
      cardQueue.push({ line, answer, w, h: Math.round(w * GRAPH_ASPECT), x: after, alpha: result.stale ? 0.35 : 1, at: answer.kind === 'plot' ? xBelow.get(line.id) : undefined });
    }

    ctx.restore();
  }

  /** The graph to draw for an answer (pure maths in graph.ts; here we only bind the variables). */
  function buildGraph(answer: Answer, at?: number): Graph {
    const line = lineValue(answer);
    if (line) {
      // "x = 5": the vertical line x = 5; "y = 2": the horizontal line y = 2
      // framed so the line and the origin are both comfortably in view (equal units on both axes)
      const { name, c } = line;
      const half = Math.max(name === 'x' ? 10 : 10 * GRAPH_ASPECT, Math.abs(c) * 1.6);
      const hx = name === 'x' ? half : half / GRAPH_ASPECT;
      const hy = name === 'x' ? half * GRAPH_ASPECT : half;
      const view = { xMin: -hx, xMax: hx, yMin: -hy, yMax: hy };
      const seg = name === 'x' ? [{ x: c, y: -hy }, { x: c, y: hy }] : [{ x: -hx, y: c }, { x: hx, y: c }];
      const mark = name === 'x' ? { x: c, y: 0, kind: 'root' as const } : { x: 0, y: c, kind: 'intercept' as const };
      return { view, curves: [{ segments: [seg], tone: 0 }], marks: [mark], equalAspect: true };
    }
    if (answer.kind === 'plot') {
      const f = answer.program.fast(answer.env, ['x']);
      return graphFunction((x) => f(x, NaN), at);
    }
    if (answer.kind === 'solved') {
      const v = answer.variable;
      const l = answer.left.fast(answer.env, [v]);
      const r = answer.right.fast(answer.env, [v]);
      const at = (fn: (x: number, y: number) => number) => (t: number): number => (v === 'x' ? fn(t, NaN) : fn(NaN, t));
      return graphSides(at(l), at(r), answer.solutions);
    }
    if (answer.kind === 'curve') {
      const l = answer.left.fast(answer.env);
      const r = answer.right.fast(answer.env);
      return graphImplicit((x, y) => l(x, y) - r(x, y), GRAPH_ASPECT);
    }
    return { view: { xMin: -10, xMax: 10, yMin: -7, yMax: 7 }, curves: [], marks: [], equalAspect: false };
  }

  /** Draw a graph card: grid, axes, curves and labelled key points. */
  function drawGraph(ctx: CanvasRenderingContext2D, g: Graph, answer: Answer, x: number, y: number, w: number, h: number, k: number): void {
    const pad = 10;
    const head = 20; // caption strip: which equation this card belongs to
    const left = x + pad;
    const top = y + head + 4;
    const pw = w - 2 * pad;
    const ph = h - head - 4 - pad;
    // a circle must stay round whatever the card's shape: widen the tighter axis to equal units per pixel
    let v = g.view;
    if (g.equalAspect) {
      const ux = (v.xMax - v.xMin) / pw;
      const uy = (v.yMax - v.yMin) / ph;
      const u = Math.max(ux, uy);
      const cx = (v.xMin + v.xMax) / 2;
      const cyv = (v.yMin + v.yMax) / 2;
      v = { xMin: cx - (u * pw) / 2, xMax: cx + (u * pw) / 2, yMin: cyv - (u * ph) / 2, yMax: cyv + (u * ph) / 2 };
    }
    const sx = (t: number): number => left + ((t - v.xMin) / (v.xMax - v.xMin)) * pw;
    const sy = (t: number): number => top + ph - ((t - v.yMin) / (v.yMax - v.yMin)) * ph;
    const hName = answer.kind === 'solved' ? answer.variable : 'x';
    const vName = answer.kind === 'solved' ? '' : 'y';

    ctx.save();
    ctx.globalAlpha = Math.min(1, k * 2);
    // card
    ctx.fillStyle = 'rgba(253, 250, 241, 0.96)';
    ctx.strokeStyle = 'rgba(60, 50, 20, 0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, 10);
    else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();

    // caption: the equation (two colour keys for "left = right"), cut to the card width
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 4, y, w - 8, head + 4);
    ctx.clip();
    ctx.font = `600 12px ${UI_FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const cy = y + 4 + head / 2;
    if (answer.kind === 'solved') {
      let lx = x + pad;
      for (const [i, t] of [answer.leftText, answer.rightText].entries()) {
        const label = formatExpressionForDisplay(t);
        ctx.fillStyle = CURVE_COLORS[i];
        ctx.fillRect(lx, cy - 1.25, 12, 2.5);
        ctx.fillStyle = 'rgba(20, 22, 28, 0.8)';
        ctx.fillText(label, lx + 16, cy);
        lx += 16 + ctx.measureText(label).width + 14;
      }
    } else {
      ctx.fillStyle = CURVE_COLORS[0];
      ctx.fillText(tidyText(answer) ?? '', x + pad, cy);
    }
    ctx.restore();

    ctx.beginPath();
    ctx.rect(left, top, pw, ph);
    ctx.clip();

    // grid
    const xt = niceTicks(v.xMin, v.xMax, Math.max(4, Math.round(pw / 64)));
    const yt = niceTicks(v.yMin, v.yMax, Math.max(3, Math.round(ph / 48)));
    ctx.strokeStyle = 'rgba(36, 86, 166, 0.10)';
    ctx.beginPath();
    for (const t of xt) {
      ctx.moveTo(Math.round(sx(t)) + 0.5, top);
      ctx.lineTo(Math.round(sx(t)) + 0.5, top + ph);
    }
    for (const t of yt) {
      ctx.moveTo(left, Math.round(sy(t)) + 0.5);
      ctx.lineTo(left + pw, Math.round(sy(t)) + 0.5);
    }
    ctx.stroke();

    // axes (or the plot edge when the axis is off the window)
    const ax = v.yMin <= 0 && v.yMax >= 0 ? sy(0) : null;
    const ay = v.xMin <= 0 && v.xMax >= 0 ? sx(0) : null;
    ctx.strokeStyle = 'rgba(28, 37, 65, 0.55)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    if (ax !== null) {
      ctx.moveTo(left, ax);
      ctx.lineTo(left + pw, ax);
    }
    if (ay !== null) {
      ctx.moveTo(ay, top);
      ctx.lineTo(ay, top + ph);
    }
    ctx.stroke();

    // tick labels along the axes
    ctx.fillStyle = 'rgba(28, 37, 65, 0.62)';
    ctx.font = `10px ${UI_FONT}`;
    const xLabelY = ax !== null ? clamp(ax + 3, top + 2, top + ph - 12) : top + ph - 12;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    for (const t of xt) {
      if (t === 0 && ay !== null) continue;
      const px = sx(t);
      if (px < left + 8 || px > left + pw - 8) continue;
      ctx.fillText(tickLabel(t), px, xLabelY);
    }
    const yLabelX = ay !== null ? clamp(ay - 4, left + 22, left + pw - 2) : left + 24;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const t of yt) {
      if (t === 0 && ax !== null) continue;
      const py = sy(t);
      if (py < top + 6 || py > top + ph - 6) continue;
      ctx.fillText(tickLabel(t), yLabelX, py);
    }
    if (ax !== null && ay !== null) {
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText('0', ay - 3, Math.min(ax + 3, top + ph - 12)); // never clipped by the plot's bottom edge
    }
    // axis names
    ctx.font = `italic 12px ${UI_FONT}`;
    ctx.fillStyle = 'rgba(28, 37, 65, 0.75)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    if (ax !== null) ctx.fillText(hName, left + pw - 3, ax - 2);
    if (ay !== null && vName) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(vName, ay + 4, top + 2);
    }

    // curves, revealed left to right like a pen
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, (pw * Math.min(1, k)) | 0, ph);
    ctx.clip();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = 2.4;
    for (const c of g.curves) {
      ctx.strokeStyle = CURVE_COLORS[c.tone];
      ctx.beginPath();
      for (const seg of c.segments) seg.forEach((p, i) => (i === 0 ? ctx.moveTo(sx(p.x), sy(p.y)) : ctx.lineTo(sx(p.x), sy(p.y))));
      ctx.stroke();
    }
    ctx.restore();

    // key points with their coordinates
    if (k >= 1) {
      ctx.font = `10px ${UI_FONT}`;
      ctx.textBaseline = 'bottom';
      // every key point gets a dot; only the few nearest the origin get their coordinates (no clutter)
      const first = (m: { kind: string }): number => (m.kind === 'solution' ? 0 : 1); // a marked x value is always labelled
      const labelled = new Set([...g.marks].sort((a, b) => first(a) - first(b) || Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y)).slice(0, 3));
      // a label goes in the first of four spots around its dot that is clear of the plot edge, other labels and
      // other dots; if none is clear it is left out (the dot stays)
      const dots: Box[] = g.marks.map((m) => ({ minX: sx(m.x) - 5, minY: sy(m.y) - 5, maxX: sx(m.x) + 5, maxY: sy(m.y) + 5 }));
      const labels: Box[] = [];
      for (const m of g.marks) {
        const px = sx(m.x);
        const py = sy(m.y);
        ctx.fillStyle = m.kind === 'solution' ? ANSWER_COLORS.solved : CURVE_COLORS[0];
        ctx.strokeStyle = '#fdfaf1';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, 3.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (!labelled.has(m)) continue;
        const label = `(${tickLabel(Number(m.x.toPrecision(3)))}, ${tickLabel(Number(m.y.toPrecision(3)))})`;
        const lw = ctx.measureText(label).width;
        const own = g.marks.indexOf(m);
        const spots = [
          [px + 6, py - 16],
          [px - 6 - lw, py - 16],
          [px + 6, py + 4],
          [px - 6 - lw, py + 4],
        ];
        const free = spots
          .map(([lx, ly]) => ({ minX: lx - 2, minY: ly, maxX: lx + lw + 2, maxY: ly + 13 }))
          .find(
            (b) =>
              b.minX >= left && b.maxX <= left + pw && b.minY >= top && b.maxY <= top + ph &&
              !labels.some((o) => overlaps(o, b)) && !dots.some((d, j) => j !== own && overlaps(d, b)),
          );
        if (!free) continue;
        labels.push(free);
        ctx.fillStyle = 'rgba(20, 22, 28, 0.78)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(label, free.minX + 2, free.minY);
      }
    }

    ctx.restore();
  }

  // toolbar

  function setTool(tool: Tool): void {
    canvas.tool = tool;
    canvas.invalidateOverlay(); // tidy text steps aside while an eraser is in hand
    for (const b of toolButtons) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  }
  for (const b of toolButtons) b.addEventListener('click', () => setTool(b.dataset.tool as Tool));
  setTool('pen');

  const setWidth = (w: number): void => {
    canvas.lineWidth = w;
    if (widthInput) widthInput.value = String(canvas.lineWidth);
    if (widthDot) widthDot.style.setProperty('--size', `${canvas.lineWidth}px`);
  };
  widthInput?.addEventListener('input', () => setWidth(Number(widthInput.value)));
  setWidth(canvas.lineWidth);

  /* pen colour: one button showing the current colour, opening a small palette */
  const toolbarEl = colorBtn?.closest<HTMLElement>('.toolbar') ?? null;
  for (const sw of swatches) sw.style.setProperty('--swatch', sw.dataset.color ?? INK);
  const setColor = (c: string): void => {
    canvas.color = c;
    toolbarEl?.style.setProperty('--pen', c);
    for (const sw of swatches) sw.setAttribute('aria-checked', String(sw.dataset.color === c));
    if (canvas.tool !== 'pen') setTool('pen'); // picking a colour means you want to write
  };
  const showPalette = (open: boolean): void => {
    if (!palette || !colorBtn) return;
    palette.hidden = !open;
    colorBtn.setAttribute('aria-expanded', String(open));
  };
  colorBtn?.addEventListener('click', () => showPalette(!!palette?.hidden));
  for (const sw of swatches) {
    sw.addEventListener('click', () => {
      setColor(sw.dataset.color ?? INK);
      showPalette(false);
    });
  }
  const onOutside = (e: PointerEvent): void => {
    if (palette && !palette.hidden && !palette.contains(e.target as Node) && e.target !== colorBtn && !colorBtn?.contains(e.target as Node)) showPalette(false);
  };
  document.addEventListener('pointerdown', onOutside, true);
  const cycleColor = (): void => {
    const list = swatches.map((sw) => sw.dataset.color ?? INK);
    if (list.length) setColor(list[(list.indexOf(canvas.color) + 1) % list.length]);
  };
  setColor(INK);

  /* graphs on/off (G) */
  const setGraphs = (on: boolean): void => {
    graphsOn = on;
    pref.set('calcink.graphs', on ? 'on' : 'off');
    graphsBtn?.setAttribute('aria-pressed', String(on));
    canvas.invalidateOverlay();
  };
  graphsBtn?.addEventListener('click', () => setGraphs(!graphsOn));
  setGraphs(graphsOn);

  /* paper style (B cycles) */
  const surfaceEl = opts.surface;
  const setPaper = (p: Paper): void => {
    surfaceEl.dataset.paper = p;
    pref.set('calcink.paper', p);
    for (const b of paperChoices) b.setAttribute('aria-checked', String(b.dataset.paper === p));
  };
  const showPapers = (open: boolean): void => {
    if (!papersMenu || !paperBtn) return;
    papersMenu.hidden = !open;
    paperBtn.setAttribute('aria-expanded', String(open));
  };
  paperBtn?.addEventListener('click', () => showPapers(!!papersMenu?.hidden));
  for (const b of paperChoices) {
    b.addEventListener('click', () => {
      setPaper((b.dataset.paper as Paper) ?? 'lines');
      showPapers(false);
    });
  }
  const onOutsidePapers = (e: PointerEvent): void => {
    if (papersMenu && !papersMenu.hidden && !papersMenu.contains(e.target as Node) && !paperBtn?.contains(e.target as Node)) showPapers(false);
  };
  document.addEventListener('pointerdown', onOutsidePapers, true);
  const savedPaper = pref.get('calcink.paper');
  setPaper((PAPERS as readonly string[]).includes(savedPaper ?? '') ? (savedPaper as Paper) : 'lines');
  const cyclePaper = (): void => {
    const now = PAPERS.indexOf((surfaceEl.dataset.paper as Paper) ?? 'lines');
    setPaper(PAPERS[(now + 1) % PAPERS.length]);
  };

  const setTidy = (on: boolean): void => {
    tidy = on;
    tidyBtn?.setAttribute('aria-pressed', String(on));
    canvas.invalidateOverlay();
  };
  tidyBtn?.addEventListener('click', () => setTidy(!tidy));
  setTidy(tidy);

  undoBtn?.addEventListener('click', () => canvas.undo());
  redoBtn?.addEventListener('click', () => canvas.redo());
  clearBtn?.addEventListener('click', () => canvas.clear());

  const onKey = (e: KeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) canvas.redo();
      else canvas.undo();
    } else if (mod && key === 'y') {
      e.preventDefault();
      canvas.redo();
    } else if (!mod && !e.altKey && !(e.target instanceof HTMLInputElement && e.target.type === 'text')) {
      if (key === 'p') setTool('pen');
      else if (key === 'e') setTool('stroke-eraser');
      else if (key === 'r') setTool('pixel-eraser');
      else if (key === 's') setTool('scribble-eraser');
      else if (key === 't') setTidy(!tidy);
      else if (key === 'c') cycleColor();
      else if (key === 'g') setGraphs(!graphsOn);
      else if (key === 'b') cyclePaper();
      else if (key === 'escape') {
        showPalette(false);
        showPapers(false);
      }
      else if (key === 'pagedown') canvas.scrollBy(lastSize.height * 0.8);
      else if (key === 'pageup') canvas.scrollBy(-lastSize.height * 0.8);
      else if (key === '[') setWidth(canvas.lineWidth - 1);
      else if (key === ']') setWidth(canvas.lineWidth + 1);
    }
  };
  window.addEventListener('keydown', onKey);

  const onNet = (): void => renderStatus();
  window.addEventListener('online', onNet);
  window.addEventListener('offline', onNet);

  // the bundled handwriting font may arrive after the first paint: repaint answers once it is ready
  void document.fonts?.load(`600 40px "Caveat"`).then(() => canvas.invalidateOverlay(), () => {});

  // initial UI state
  if (undoBtn) undoBtn.disabled = true;
  if (redoBtn) redoBtn.disabled = true;
  if (clearBtn) clearBtn.disabled = true;
  renderStatus();

  if (keepPage) {
    const saved = pageFromJson(pref.get(PAGE_KEY));
    if (saved.length > 0) canvas.load(saved);
  }

  return {
    canvas,
    recognizer: lineRecognizer,
    get painted() {
      return painted;
    },
    get graphs() {
      return graphsOn;
    },
    get cards() {
      return cardRects.length;
    },
    get layout() {
      return { width: lastSize.width, height: canvas.pageHeight, cards: [...cardRects], texts: [...textRects], ink: [...inkRects], skipped: skippedCards, faded: touchedCards.size };
    },
    get drawnGraphs() {
      return drawn;
    },
    get columns() {
      return columnTexts;
    },
    setTidy,
    dispose(): void {
      clearTimeout(errorTimer);
      clearTimeout(saveTimer);
      window.removeEventListener('keydown', onKey);
      opts.surface.removeEventListener('pointermove', onPenMove);
      opts.surface.removeEventListener('pointerdown', onPenDown);
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('pointerdown', onOutsidePapers, true);
      window.removeEventListener('online', onNet);
      window.removeEventListener('offline', onNet);
      lineRecognizer.dispose();
      recognizerImpl.dispose?.(); // the worker and its model session
      canvas.dispose();
    },
  };
}
