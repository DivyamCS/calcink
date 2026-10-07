/**
 * InkCanvas: the drawing surface.
 */
import { backingStoreSize, clientToCss, normalizeDpr } from './coords.ts';
import { eraseStrokesAt, erasePartAt } from './geometry.ts';
import { History } from './history.ts';
import { IncrementalStroke, drawStroke } from './render.ts';
import { isScratchGesture, strokesUnderScratch } from './scratch.ts';
import type { Point, Size, Stroke, Tool } from './types.ts';

/** `ctx` is already shifted to page coordinates; `size` is the page width and the screen height (css px). */
export type OverlayRenderer = (ctx: CanvasRenderingContext2D, size: Size) => void;

export interface InkCanvasOptions {
  lineWidth?: number;
  inkColor?: string;
  /** Fired after every committed change to the strokes. */
  onChange?: (strokes: readonly Stroke[]) => void;
  /** Fired when undo/redo availability changes. */
  onHistory?: (state: { canUndo: boolean; canRedo: boolean }) => void;
  /** Fired when a pointer goes down (true) and when it is released or cancelled (false). */
  onActive?: (active: boolean) => void;
  /** true while the user is erasing (eraser tool, stylus eraser or a pen scribble), so the app can show the real ink. */
  onRevealInk?: (on: boolean) => void;
  /** Fired when the page scrolls. */
  onScroll?: (scrollY: number) => void;
}

const MIN_SAMPLE_DISTANCE = 0.6; // CSS px; drops duplicate pointer samples
const PEN_ERASER_BUTTON = 32; // PointerEvent.buttons bit for a stylus' eraser end
const SCRIBBLE_COLOR = 'rgba(214, 40, 57, 0.5)'; // trail drawn by the scribble eraser
const SCRIBBLE_CHECK_EVERY = 8; // re-run scribble detection on the live pen stroke every N samples
const LINE_PX = 40; // one wheel "line" (deltaMode 1), css px
/** blank paper kept below the lowest writing, as a fraction of the screen height */
const PAGE_TAIL = 0.8;
/** room kept right of the writing when it is wider than the screen (for its answer) */
const PAGE_RIGHT_ROOM = 240;

export class InkCanvas {
  readonly inkCanvas: HTMLCanvasElement;
  readonly overlayCanvas: HTMLCanvasElement;

  private readonly host: HTMLElement;
  private readonly inkCtx: CanvasRenderingContext2D;
  private readonly overlayCtx: CanvasRenderingContext2D;
  private readonly ring: HTMLElement;
  private readonly onChange: (s: readonly Stroke[]) => void;
  private readonly onHistory: (h: { canUndo: boolean; canRedo: boolean }) => void;
  private readonly onActive: (active: boolean) => void;
  private readonly onRevealInk: (on: boolean) => void;
  private readonly onScroll: (y: number) => void;
  private readonly thumb: HTMLElement;
  private readonly thumbX: HTMLElement;
  private _scrollY = 0;
  /** sideways scroll: only non-zero when the writing is wider than the screen (zoomed in, narrow window) */
  private _scrollX = 0;
  private scrollFrame = 0;
  /** touch pointers currently down, for two-finger scrolling */
  private readonly touches = new Map<number, { x: number; y: number }>();
  private pan: { x: number; y: number } | null = null;
  /** after a two-finger pan, the finger left on the screen must lift before it draws again */
  private touchBlocked = false;
  private revealing = false;
  private liveIsScribble = false; // the live stroke belongs to the scribble eraser, not the pen
  private hidden: ReadonlySet<number> = new Set();
  private readonly inkColor: string;
  /** colour of new strokes (undefined = default ink) */
  private _color: string | undefined;

  private strokes: readonly Stroke[] = [];
  private readonly history = new History<readonly Stroke[]>(200);
  private idCounter = 1;

  private _tool: Tool = 'pen';
  private _lineWidth: number;

  private cssSize: Size = { width: 0, height: 0 };
  private dpr = 1;

  // gesture state
  private activePointer: number | null = null;
  private live: IncrementalStroke | null = null;
  private erasing = false;
  private eraseChanged = false;
  private lastErasePoint: Point | null = null;
  private lastPenSeen = -Infinity;

  private overlayRenderer: OverlayRenderer | null = null;
  private overlayFrame = 0;
  private resizeObserver: ResizeObserver | null = null;
  private dprQuery: MediaQueryList | null = null;
  private readonly listeners: Array<() => void> = [];
  private disposed = false;

  constructor(host: HTMLElement, opts: InkCanvasOptions = {}) {
    this.host = host;
    this._lineWidth = opts.lineWidth ?? 4;
    this.inkColor = opts.inkColor ?? '#1c2541';
    this.onChange = opts.onChange ?? (() => {});
    this.onHistory = opts.onHistory ?? (() => {});
    this.onActive = opts.onActive ?? (() => {});
    this.onRevealInk = opts.onRevealInk ?? (() => {});
    this.onScroll = opts.onScroll ?? (() => {});

    host.classList.add('ink-surface');

    this.inkCanvas = document.createElement('canvas');
    this.inkCanvas.className = 'ink-layer';
    this.inkCanvas.setAttribute('role', 'img');
    this.inkCanvas.setAttribute('aria-label', 'Drawing surface. Write a calculation ending with an equals sign.');
    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.className = 'overlay-layer';
    this.overlayCanvas.setAttribute('aria-hidden', 'true');

    this.ring = document.createElement('div');
    this.ring.className = 'eraser-ring';
    this.ring.hidden = true;

    this.thumb = document.createElement('div');
    this.thumb.className = 'scroll-thumb';
    this.thumb.setAttribute('aria-hidden', 'true');
    this.thumbX = document.createElement('div');
    this.thumbX.className = 'scroll-thumb-x';
    this.thumbX.setAttribute('aria-hidden', 'true');
    this.thumbX.hidden = true;

    host.append(this.inkCanvas, this.overlayCanvas, this.ring, this.thumb, this.thumbX);

    const ink = this.inkCanvas.getContext('2d');
    const overlay = this.overlayCanvas.getContext('2d');
    if (!ink || !overlay) throw new Error('Canvas 2D is not available in this browser.');
    this.inkCtx = ink;
    this.overlayCtx = overlay;

    this.bindPointerEvents();
    this.bindLayout();
    this.resize();
    this.applyToolAttributes();
  }

  // public API

  get tool(): Tool {
    return this._tool;
  }
  set tool(tool: Tool) {
    this._tool = tool;
    this.applyToolAttributes();
  }

  /** Colour of the next strokes (existing strokes keep theirs). */
  get color(): string {
    return this._color ?? this.inkColor;
  }
  set color(c: string) {
    this._color = c === this.inkColor ? undefined : c;
  }

  get lineWidth(): number {
    return this._lineWidth;
  }
  set lineWidth(w: number) {
    this._lineWidth = Math.min(24, Math.max(1, w));
    this.updateRingSize();
  }

  get currentStrokes(): readonly Stroke[] {
    return this.strokes;
  }
  get canUndo(): boolean {
    return this.history.canUndo;
  }
  get canRedo(): boolean {
    return this.history.canRedo;
  }
  get size(): Size {
    return { ...this.cssSize };
  }

  /** How far the page is scrolled (css px from the top of the page). */
  get scrollY(): number {
    return this._scrollY;
  }
  /** Bottom of the lowest stroke (page coordinates), 0 for an empty page. */
  get contentBottom(): number {
    if (this.bottomOf?.strokes === this.strokes) return this.bottomOf.y;
    let bottom = 0;
    for (const s of this.strokes) for (const p of s.points) if (p.y > bottom) bottom = p.y;
    this.bottomOf = { strokes: this.strokes, y: bottom };
    return bottom;
  }
  private bottomOf: { strokes: readonly Stroke[]; y: number } | null = null;
  /** Height of the page: the screen (or the writing, when it goes further) plus most of a screen of fresh paper. */
  get pageHeight(): number {
    return Math.round(Math.max(this.cssSize.height, this.contentBottom) + this.cssSize.height * PAGE_TAIL);
  }

  /** How far the page is scrolled sideways (css px). 0 unless the writing is wider than the screen. */
  get scrollX(): number {
    return this._scrollX;
  }
  /** Right edge of the rightmost stroke (page coordinates). */
  get contentRight(): number {
    if (this.rightOf?.strokes === this.strokes) return this.rightOf.x;
    let right = 0;
    for (const s of this.strokes) for (const p of s.points) if (p.x + s.lineWidth > right) right = p.x + s.lineWidth;
    this.rightOf = { strokes: this.strokes, x: right };
    return right;
  }
  private rightOf: { strokes: readonly Stroke[]; x: number } | null = null;
  /** Width of the page: the screen, or the writing plus room for its answers when the writing is wider. */
  get pageWidth(): number {
    const right = this.contentRight;
    return right > this.cssSize.width ? Math.round(right + PAGE_RIGHT_ROOM) : this.cssSize.width;
  }

  /** Scroll to `y` (clamped to the page). Not while a stroke is being drawn. */
  scrollTo(y: number, x: number = this._scrollX): void {
    if (this.activePointer !== null) return;
    const max = Math.max(0, this.pageHeight - this.cssSize.height);
    const next = Math.round(Math.min(max, Math.max(0, y)));
    const maxX = Math.max(0, this.pageWidth - this.cssSize.width);
    const nextX = Math.round(Math.min(maxX, Math.max(0, x)));
    if (next === this._scrollY && nextX === this._scrollX) return;
    this._scrollY = next;
    this._scrollX = nextX;
    this.host.style.setProperty('--scroll-y', `${next}px`);
    this.host.style.setProperty('--scroll-x', `${nextX}px`);
    this.updateThumb();
    this.onScroll(next);
    // ink and answers move together in one frame
    if (this.scrollFrame || this.disposed) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0;
      this.redrawInk();
      cancelAnimationFrame(this.overlayFrame);
      this.overlayFrame = 0;
      this.paintOverlay();
    });
  }
  scrollBy(dy: number, dx = 0): void {
    this.scrollTo(this._scrollY + dy, this._scrollX + dx);
  }

  undo(): void {
    if (this.activePointer !== null) return; // not in the middle of a stroke or an erase (it would split its undo step)
    const prev = this.history.undo(this.strokes);
    if (prev) this.restore(prev);
  }

  redo(): void {
    if (this.activePointer !== null) return;
    const next = this.history.redo(this.strokes);
    if (next) this.restore(next);
  }

  /** Put back a saved page. Not an undo step; the strokes get new ids. */
  load(strokes: readonly Stroke[]): void {
    if (this.activePointer !== null) return;
    this.history.clear();
    this.restore(strokes.map((s) => ({ ...s, id: this.newId() })));
  }

  clear(): void {
    if (this.strokes.length === 0 || this.activePointer !== null) return;
    this.history.record(this.strokes);
    this.restore([], false);
  }

  /** Register what to paint on the answer layer; call invalidateOverlay() to repaint. */
  setOverlayRenderer(renderer: OverlayRenderer): void {
    this.overlayRenderer = renderer;
    this.invalidateOverlay();
  }

  /** Repaint the answer layer on the next animation frame (coalesces multiple calls). */
  invalidateOverlay(): void {
    if (this.overlayFrame || this.disposed) return;
    this.overlayFrame = requestAnimationFrame(() => {
      this.overlayFrame = 0;
      this.paintOverlay();
    });
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.overlayFrame);
    cancelAnimationFrame(this.scrollFrame);
    this.resizeObserver?.disconnect();
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    for (const off of this.listeners) off();
    this.listeners.length = 0;
    this.history.clear();
    this.strokes = [];
    this.inkCanvas.remove();
    this.overlayCanvas.remove();
    this.ring.remove();
    this.thumb.remove();
    this.thumbX.remove();
  }

  // state changes

  /** Replace the strokes (undo/redo/clear) and notify. */
  private restore(next: readonly Stroke[], notifyHistory = true): void {
    this.strokes = next;
    this.redrawInk();
    this.emitChange();
    if (notifyHistory) this.emitHistory();
  }

  private emitChange(): void {
    // the page may have become shorter (undo, erase, clear): stay inside it
    const max = Math.max(0, this.pageHeight - this.cssSize.height);
    const maxX = Math.max(0, this.pageWidth - this.cssSize.width);
    if (this._scrollY > max || this._scrollX > maxX) this.scrollTo(Math.min(this._scrollY, max), Math.min(this._scrollX, maxX));
    this.updateThumb();
    this.onChange(this.strokes);
    this.emitHistory();
  }

  private emitHistory(): void {
    this.onHistory({ canUndo: this.history.canUndo, canRedo: this.history.canRedo });
  }

  private newId = (): number => this.idCounter++;

  // layout & DPR

  private bindLayout(): void {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.watchDpr();
  }

  private readonly onDprChange = (): void => {
    this.resize();
    this.watchDpr();
  };

  /** devicePixelRatio changes on browser zoom or when the window moves between monitors. */
  private watchDpr(): void {
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.dprQuery.addEventListener('change', this.onDprChange, { once: true });
  }

  private resize(): void {
    const rect = this.host.getBoundingClientRect();
    const css: Size = {
      width: Math.max(1, Math.round(this.host.clientWidth || rect.width)),
      height: Math.max(1, Math.round(this.host.clientHeight || rect.height)),
    };
    const dpr = normalizeDpr(window.devicePixelRatio);
    if (css.width === this.cssSize.width && css.height === this.cssSize.height && dpr === this.dpr) return;

    this.cssSize = css;
    this.dpr = dpr;
    const px = backingStoreSize(css, dpr);

    for (const canvas of [this.inkCanvas, this.overlayCanvas]) {
      canvas.width = px.width; // resets the bitmap
      canvas.height = px.height;
      canvas.style.width = `${css.width}px`;
      canvas.style.height = `${css.height}px`;
    }
    // a wider window may not need the sideways scroll any more
    const maxX = Math.max(0, this.pageWidth - css.width);
    if (this._scrollX > maxX) {
      this._scrollX = maxX;
      this.host.style.setProperty('--scroll-x', `${maxX}px`);
    }
    this.redrawInk();
    this.invalidateOverlay();
    this.updateThumb();
  }

  /** The scrollbar: shown when the page is taller than the screen; its size and place mirror the view. */
  private updateThumb(): void {
    this.updateThumbX();
    const view = this.cssSize.height;
    const page = this.pageHeight;
    const scrollable = page > view + 1;
    this.thumb.hidden = !scrollable;
    if (!scrollable) return;
    const track = view - 16;
    const h = Math.max(32, (track * view) / page);
    const top = 8 + ((track - h) * this._scrollY) / (page - view);
    this.thumb.style.height = `${h}px`;
    this.thumb.style.transform = `translateY(${top}px)`;
  }

  /** Sideways bar, only when the writing is wider than the screen. */
  private updateThumbX(): void {
    const view = this.cssSize.width;
    const page = this.pageWidth;
    const scrollable = page > view + 1;
    this.thumbX.hidden = !scrollable;
    if (!scrollable) return;
    const track = view - 16;
    const w = Math.max(32, (track * view) / page);
    const left = 8 + ((track - w) * this._scrollX) / (page - view);
    this.thumbX.style.width = `${w}px`;
    this.thumbX.style.transform = `translateX(${left}px)`;
  }

  // drawing

  /** Clear a layer and leave it drawing in page coordinates (scaled for HiDPI, shifted by the scroll). */
  private clearCtx(ctx: CanvasRenderingContext2D): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, -this._scrollX * this.dpr, -this._scrollY * this.dpr);
  }

  private redrawInk(): void {
    this.clearCtx(this.inkCtx);
    for (const s of this.strokes) if (!this.hidden.has(s.id)) drawStroke(this.inkCtx, s, s.color ?? this.inkColor);
    // keep the stroke being drawn right now on screen if the layer is repainted mid-stroke
    if (this.live && this.live.points.length > 1) {
      const color = this.liveIsScribble ? SCRIBBLE_COLOR : this.live.color;
      drawStroke(this.inkCtx, { id: 0, points: this.live.points, lineWidth: this.live.lineWidth }, color);
    }
  }

  private setReveal(on: boolean): void {
    if (this.revealing === on) return;
    this.revealing = on;
    this.onRevealInk(on);
  }

  /** Strokes that are kept but not painted because tidy mode shows them as text. */
  setHiddenStrokes(ids: ReadonlySet<number>): void {
    if (ids.size === this.hidden.size && [...ids].every((id) => this.hidden.has(id))) return;
    this.hidden = ids;
    this.redrawInk();
  }

  private paintOverlay(): void {
    this.clearCtx(this.overlayCtx);
    this.overlayRenderer?.(this.overlayCtx, { width: this.pageWidth, height: this.cssSize.height });
  }

  // pointer input

  private bindPointerEvents(): void {
    const c = this.inkCanvas;
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (e: HTMLElementEventMap[K]) => void,
    ): void => {
      c.addEventListener(type, handler as EventListener);
      this.listeners.push(() => c.removeEventListener(type, handler as EventListener));
    };

    on('pointerdown', (e) => this.onPointerDown(e));
    on('pointermove', (e) => this.onPointerMove(e));
    on('pointerup', (e) => this.onPointerEnd(e, false));
    on('pointercancel', (e) => this.onPointerEnd(e, true));
    on('lostpointercapture', (e) => this.onPointerEnd(e as PointerEvent, true));
    on('pointerleave', () => {
      if (this.activePointer === null) this.ring.hidden = true;
    });
    on('contextmenu', (e) => e.preventDefault());

    // wheel / trackpad scrolls the page (the surface never scrolls the document itself)
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey) return; // pinch-zoom gesture: leave it to the browser
      e.preventDefault();
      const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? this.cssSize.height : 1;
      // shift + wheel scrolls sideways on a mouse; trackpads send deltaX directly
      if (e.shiftKey && e.deltaX === 0) this.scrollBy(0, e.deltaY * unit);
      else this.scrollBy(e.deltaY * unit, e.deltaX * unit);
    };
    this.host.addEventListener('wheel', onWheel, { passive: false });
    this.listeners.push(() => this.host.removeEventListener('wheel', onWheel));

    // dragging the scrollbar
    let drag: { y: number; scroll: number } | null = null;
    const down = (e: PointerEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      drag = { y: e.clientY, scroll: this._scrollY };
      try {
        this.thumb.setPointerCapture(e.pointerId);
      } catch {
        // synthetic pointers can't be captured
      }
    };
    const move = (e: PointerEvent): void => {
      if (!drag) return;
      const ratio = this.pageHeight / Math.max(1, this.cssSize.height - 16);
      this.scrollTo(drag.scroll + (e.clientY - drag.y) * ratio);
    };
    const up = (): void => {
      drag = null;
    };
    this.thumb.addEventListener('pointerdown', down);
    this.thumb.addEventListener('pointermove', move);
    this.thumb.addEventListener('pointerup', up);
    this.thumb.addEventListener('pointercancel', up);
    this.listeners.push(() => {
      this.thumb.removeEventListener('pointerdown', down);
      this.thumb.removeEventListener('pointermove', move);
      this.thumb.removeEventListener('pointerup', up);
      this.thumb.removeEventListener('pointercancel', up);
    });
  }

  /** Pointer position on the screen part of the surface (css px, not shifted by the scroll). */
  private toScreen(e: PointerEvent): Point {
    return clientToCss(e.clientX, e.clientY, this.inkCanvas.getBoundingClientRect(), this.cssSize);
  }

  /** Pointer position on the page (css px from the top of the page). */
  private toCss(e: PointerEvent): Point {
    const p = this.toScreen(e);
    p.x += this._scrollX;
    p.y += this._scrollY;
    // pressure only from a real stylus (mice report a constant 0.5, many touch screens 0 or 1)
    if (e.pointerType === 'pen' && e.pressure > 0) p.p = e.pressure;
    return p;
  }

  private effectiveTool(e: PointerEvent): Tool {
    // the eraser end of a stylus always erases
    if (e.pointerType === 'pen' && (e.buttons & PEN_ERASER_BUTTON) !== 0) return 'pixel-eraser';
    return this._tool;
  }

  private eraserRadius(tool: Tool = this._tool): number {
    return tool === 'pixel-eraser' ? 6 + this._lineWidth * 2 : 5 + this._lineWidth;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2) {
        // a second finger: this is a two-finger scroll, not writing; drop what the first finger began
        this.cancelActive();
        this.pan = this.touchMid();
        this.touchBlocked = true;
        e.preventDefault();
        return;
      }
      if (this.touches.size > 2 || this.touchBlocked) return;
    }
    if (this.activePointer !== null) return; // one pointer at a time (ignore extra fingers)
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const now = performance.now();
    if (e.pointerType === 'pen') this.lastPenSeen = now;
    // palm rejection: ignore touches that arrive right after a stylus
    if (e.pointerType === 'touch' && now - this.lastPenSeen < 800) return;

    e.preventDefault();
    try {
      this.inkCanvas.setPointerCapture(e.pointerId);
    } catch {
      // synthetic or already-released pointers can't be captured; drawing still works
    }
    this.activePointer = e.pointerId;
    this.onActive(true);

    const p = this.toCss(e);
    const tool = this.effectiveTool(e);

    if (tool === 'pen') {
      this.liveIsScribble = false;
      this.live = new IncrementalStroke(this.inkCtx, this._color ?? this.inkColor, this._lineWidth);
      this.live.add(p);
    } else if (tool === 'scribble-eraser') {
      // scribble eraser: draw a light red trail; on release, whatever it scribbled over is removed
      this.setReveal(true);
      this.liveIsScribble = true;
      this.live = new IncrementalStroke(this.inkCtx, SCRIBBLE_COLOR, Math.max(3, this._lineWidth));
      this.live.add(p);
    } else {
      this.setReveal(true);
      this.erasing = true;
      this.eraseChanged = false;
      this.lastErasePoint = null;
      this.eraseAlong(p, tool);
      this.moveRing(e, tool);
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pan !== null && this.touches.size >= 2) {
        const mid = this.touchMid();
        this.scrollBy(this.pan.y - mid.y, this.pan.x - mid.x);
        this.pan = mid;
        return;
      }
    }
    const tool = this.effectiveTool(e);

    if (this.activePointer === null) {
      // hovering: only the eraser ring follows the pointer
      this.moveRing(e, tool);
      return;
    }
    if (e.pointerId !== this.activePointer) return;

    // coalesced events recover the samples the browser merged into this frame
    const samples = e.getCoalescedEvents?.() ?? [];
    const events = samples.length > 0 ? samples : [e];

    if (this.live) {
      for (const ev of events) {
        const p = this.toCss(ev);
        const last = this.live.points[this.live.points.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) >= MIN_SAMPLE_DISTANCE) this.live.add(p);
      }
      // a pen stroke turning into a scribble: show the real handwriting under it straight away
      const n = this.live.points.length;
      if (!this.liveIsScribble && !this.revealing && n % SCRIBBLE_CHECK_EVERY === 0 && isScratchGesture(this.live.points)) {
        this.setReveal(true);
      }
    } else if (this.erasing) {
      for (const ev of events) this.eraseAlong(this.toCss(ev), tool);
      this.moveRing(e, tool);
    }
  }

  private onPointerEnd(e: PointerEvent, cancelled: boolean): void {
    if (e.pointerType === 'touch' && this.touches.delete(e.pointerId)) {
      if (this.touches.size < 2) this.pan = null;
      if (this.touches.size === 0) this.touchBlocked = false;
    }
    if (e.pointerId !== this.activePointer) return;
    this.activePointer = null;
    if (this.inkCanvas.hasPointerCapture?.(e.pointerId)) this.inkCanvas.releasePointerCapture(e.pointerId);
    this.onActive(false);

    if (this.live) {
      const live = this.live;
      const scribble = this.liveIsScribble;
      this.live = null;
      this.liveIsScribble = false;
      if (cancelled) {
        this.redrawInk(); // drop the half-drawn stroke
      } else if (scribble) {
        this.eraseUnderScribble(live.points);
      } else {
        live.finish();
        this.commitStroke(live);
      }
      this.setReveal(false);
    } else if (this.erasing) {
      this.erasing = false;
      this.lastErasePoint = null;
      this.setReveal(false);
      if (this.eraseChanged) this.emitChange();
      if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') this.ring.hidden = true;
    }
  }

  private touchMid(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    for (const t of this.touches.values()) {
      x += t.x;
      y += t.y;
    }
    const n = Math.max(1, this.touches.size);
    return { x: x / n, y: y / n };
  }

  /** Abandon the stroke or erase in progress (a second finger turned it into a scroll). */
  private cancelActive(): void {
    if (this.activePointer === null) return;
    const id = this.activePointer;
    this.activePointer = null;
    if (this.inkCanvas.hasPointerCapture?.(id)) this.inkCanvas.releasePointerCapture(id);
    if (this.live) {
      this.live = null;
      this.liveIsScribble = false;
      this.redrawInk();
    } else if (this.erasing) {
      this.erasing = false;
      this.lastErasePoint = null;
      if (this.eraseChanged) this.emitChange(); // what was already rubbed out stays rubbed out (one undo)
    }
    this.setReveal(false);
    this.onActive(false);
  }

  private commitStroke(live: IncrementalStroke): void {
    let points = live.points;
    if (points.length === 1) {
      // a tap becomes a dot (decimal point!) - give it a tiny extent so it has a direction
      points = [points[0], { x: points[0].x + 0.01, y: points[0].y }];
    }

    // scratch-to-erase: a scribble over ink rubs it out instead of adding ink
    if (isScratchGesture(points)) {
      const covered = strokesUnderScratch(this.strokes, points);
      if (covered.length > 0) {
        const gone = new Set(covered);
        this.history.record(this.strokes);
        this.strokes = this.strokes.filter((s) => !gone.has(s));
        this.redrawInk();
        this.emitChange();
        return;
      }
    }

    this.history.record(this.strokes);
    const color = live.color !== this.inkColor ? { color: live.color } : {};
    this.strokes = [...this.strokes, { id: this.newId(), points, lineWidth: live.lineWidth, ...color }];
    this.emitChange();
  }

  /** Scribble eraser: remove every stroke the trail covers. Unlike scratch-to-erase, any scribble counts. */
  private eraseUnderScribble(points: readonly Point[]): void {
    const covered = points.length > 1 ? strokesUnderScratch(this.strokes, points) : [];
    if (covered.length > 0) {
      const gone = new Set(covered);
      this.history.record(this.strokes);
      this.strokes = this.strokes.filter((s) => !gone.has(s));
      this.redrawInk();
      this.emitChange();
    } else {
      this.redrawInk(); // just wipe the trail
    }
  }

  /** Erase at p, interpolating from the previous sample so fast swipes leave no gaps. */
  private eraseAlong(p: Point, tool: Tool): void {
    const radius = this.eraserRadius(tool);
    const from = this.lastErasePoint;
    this.lastErasePoint = p;

    const steps = from ? Math.max(1, Math.ceil(Math.hypot(p.x - from.x, p.y - from.y) / (radius / 2))) : 1;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const q = from ? { x: from.x + (p.x - from.x) * t, y: from.y + (p.y - from.y) * t } : p;
      const next =
        tool === 'stroke-eraser'
          ? eraseStrokesAt(this.strokes, q, radius)
          : erasePartAt(this.strokes, q, radius, this.newId);
      if (next !== this.strokes) {
        if (!this.eraseChanged) {
          this.history.record(this.strokes); // one undo step per erase gesture
          this.eraseChanged = true;
        }
        this.strokes = next;
        this.redrawInk();
      }
    }
  }

  // eraser ring & cursor

  private applyToolAttributes(): void {
    this.host.dataset.tool = this._tool;
    this.updateRingSize();
    if (this._tool === 'pen' || this._tool === 'scribble-eraser') this.ring.hidden = true;
  }

  private updateRingSize(): void {
    const d = this.eraserRadius() * 2;
    this.ring.style.width = `${d}px`;
    this.ring.style.height = `${d}px`;
  }

  private moveRing(e: PointerEvent, tool: Tool): void {
    if (tool === 'pen' || tool === 'scribble-eraser') {
      this.ring.hidden = true;
      return;
    }
    const r = this.eraserRadius(tool);
    const p = this.toScreen(e);
    this.ring.hidden = false;
    this.ring.style.width = `${r * 2}px`;
    this.ring.style.height = `${r * 2}px`;
    this.ring.style.transform = `translate(${p.x - r}px, ${p.y - r}px)`;
  }
}
