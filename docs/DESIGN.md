# CalcInk design notes

## 1. Goal and constraints

Write `18+4×3=` by hand -> the answer appears next to the `=` and updates when the writing changes.

Hard constraints from the PS:
* 100 % client-side and offline; no cloud APIs.
* No `eval` / `new Function`.
* 60 FPS while recognising (heavy work off the main thread).
* Crisp on HiDPI screens; mouse, touch and stylus input.
* Undo/redo, stroke and pixel erasers, clear and pen width.
* Graceful errors (Undefined for `÷0`, no crashes).

## 2. Architecture

```
Main thread                                   Worker
-----------                                   ------
pointer events (mouse / pen / touch)
  -> InkCanvas: vector strokes, undo/redo, erasers, HiDPI
  -> LineRecognizer: group into lines, debounce, cache,
     one request at a time, cancel stale ones
       -- points of one line -->              strokes -> image -> tensor (OffscreenCanvas)
                                              CoMER encoder (onnxruntime-web, WASM)
       <-- LaTeX candidates + probabilities -- our beam search decoder
  -> choose.ts: pick the best valid reading
  -> solveSheet: LaTeX -> statement -> RPN -> value, top to bottom
  -> overlay canvas: answers, tidy text, graph cards
```

* Main thread: input, drawing, line grouping, solving, painting. No image processing and no inference. The main bundle
  is 81 KB and does not load onnxruntime.
* Worker: model download (with progress), ONNX sessions, rasterising strokes, encoder, decoder.
* Two stacked canvases: the ink layer (the user's strokes) and the overlay (computed text and graphs). Answers are
  never ink, so they can't be erased by accident or fed back into recognition, and repainting them is cheap.
* A scrolling page: both layers are one screen tall and show the part of the page at `scrollY`; strokes, answers and
  graph cards live in page coordinates (section 4).

## 3. Choosing the model

The PS asks for an existing open-source pre-trained model running in the browser, for digits, `+ - × ÷ . =`.
The deciding questions were size (it is downloaded once and precached), speed on a laptop CPU (no GPU assumed),
accuracy on whole handwritten lines (multi-digit numbers, decimals, multi-stroke symbols like `=`, `÷`, `+`) and
whether a browser-ready build exists.

| Option | Size | Speed (CPU, browser) | Fit for the task | Verdict |
|---|---|---|---|---|
| CoMER, INT8 ONNX (via ink-on) | 7.6 MB | about 0.9 s per line on a 2-core machine (measured, below) | Reads a whole line image to LaTeX, so no symbol segmentation is needed. Trained on handwritten math (CROHME). Handles multi-digit numbers, decimals, fractions, powers, `x`, `√`. | Chosen |
| Per-symbol CNN (MNIST / HASYv2 style) + our own segmentation | < 1 MB | very fast | Must cut the ink into symbols first. `=`, `÷`, `+` and `×` are several strokes, a decimal point is a dot next to a digit, and touching digits merge. That segmentation is the hard part, and errors there are silent. | Rejected: accuracy depends on hand-made heuristics |
| TrOCR (Transformers.js) | tens to hundreds of MB | slow on CPU | General handwritten *text* OCR, not math | Rejected: size, latency, wrong domain |
| Tesseract.js | a few MB + language data | fast | Built for printed text; weak on handwriting and math symbols | Rejected: accuracy |
| BTTR / other HMER research models | large FP32 checkpoints | slow | Same task, but no ready browser export; CoMER is the follow-up to BTTR by the same authors | Rejected: we would have to export and quantise them ourselves |
| Cloud OCR (Mathpix, MyScript, Google Vision) | - | - | Not allowed by the PS | - |

CoMER (Zhao & Gao, ECCV 2022) is a DenseNet encoder plus a Transformer decoder with an Attention Refinement Module
that models coverage: it tracks which image regions the decoder has already attended to, so a symbol is neither skipped
nor read twice. The paper reports 59.3 / 59.8 / 63.0 % expression rate on CROHME 2014 / 2016 / 2019. Those are full
math expressions with integrals, sums and so on; arithmetic lines are much easier. The INT8 export by ink-on is about
13× smaller than the FP32 original and runs on WebAssembly everywhere.

### Restricting the vocabulary

The model knows 113 LaTeX tokens. CalcInk only lets it write what can be calculated: digits, `+ - × ÷ / · . = ( )`,
`\frac`, `^`, braces, plus `x`, `y`, `√`, `π`, `e` and `\sin \cos \tan \log` for variables, functions and graphs. Probabilities are renormalised over that set
(`maskedLogSoftmax`). A `9` that the model also thinks could be the letter `g` is therefore read as a confident `9`. A
`1` that could also be a `7` stays doubtful, which is exactly what the confidence indicator should show. Measured:
adding the extra symbols costs no accuracy compared with digits-and-operators only (the same 120-sample score).

### Our own decoder

We started with ink-on's `InferenceEngine` and replaced its decoder (`src/recognition/decoder.ts`) for these reasons:

1. ink-on ends a hypothesis after 3 identical tokens, so `10000`, `1111` or `5000000` could never be read. The line
   came back as `1 0 0 0` with no `=`, and no answer was shown. We allow runs of up to 12 identical tokens; beyond that a
   runaway-loop guard still stops the hypothesis.
2. Confidence: we keep the probability of every token. The UI uses the least certain token that matters (a phantom
   token after the `=` is ignored).
3. Cancellation: if the user edits the line being read, the worker stops between decoder steps (it yields through a
   `MessageChannel`, which is never throttled like `setTimeout`).
4. All candidates are returned (best first). `choose.ts` prefers a candidate that is a valid calculation when it is
   nearly as likely as the best one.
5. Length penalty (GNMT style, α = 0.6). Average-per-token scoring rewards long outputs, and the model then likes to
   invent symbols after the `=`. α made little difference on our benchmark (97.5 % for 0.3 to 1.0); 0.6 is the standard
   middle.

### Measured accuracy

Benchmark: `tests/e2e/accuracy.spec.ts`. It covers 40 expressions with every digit and operator, decimals, brackets, and
long and repeated numbers. Each is written 3 times with seeded synthetic handwriting (random slant, size, baseline wobble
and tremor), giving 120 samples, run through the real model in Chromium.

| Engine (same model, same samples) | Correct | Median time per line |
|---|---|---|
| ink-on's original decoder (`number` mode, beam 3) | 112 / 120 = 93.3 % | 561 ms (all cores) |
| CalcInk decoder (extended symbols, beam 3) | 117 / 120 = 97.5 % | 835 ms (half the cores, see section 7) |

All of ink-on's extra failures are the repeated-digit bug (`10000+1=` -> `1 0 0 0`, `1111×2=` -> `1 1 1`). CalcInk's three
misses (latest run): `9.9+0.1=` read twice as `9.9+0=1.0` (the `.` of `0.1` landed after the `=`), and `10000+1=` read
with one zero too many (flagged by the confidence underline, 58 %). On messier
synthetic writing (`mess = 1`) CalcInk scored 79/80. Synthetic strokes are cleaner than real handwriting, so treat these
numbers as a regression benchmark rather than a promise. Variables and graphs (`x=10`, `x+5=`, `2x+1=`, `y=x²`,
`y=2x+1`, `y=x²-4`...) were read correctly in 33 of 33 samples.

## 4. Canvas and coordinates

* Pointer Events cover mouse, touch and pen with one code path. `getCoalescedEvents()` recovers the samples the
  browser merged into one frame, so fast strokes stay smooth. One pointer writes at a time; a second finger turns the
  gesture into a two-finger scroll (the first finger's stroke is dropped, nothing is drawn until both lift); touches within
  800 ms of a stylus are ignored (palm rejection); the pen's eraser end switches to the pixel eraser. Stylus pressure changes the width of
  each piece of the stroke.
* DPR handling: `canvas.width = round(cssW × dpr)`, the CSS size stays `cssW`, and the context is scaled by `dpr`.
  Pointer coordinates are converted client -> CSS px (`clientToCss` corrects for the bounding box and any CSS scaling),
  then shifted by the scroll into page coordinates. Strokes are stored in page CSS px and drawn at `dpr`. A `matchMedia('(resolution: ...)')` listener rebuilds the canvas when the
  window moves to another screen or the user zooms; a `ResizeObserver` handles layout. These conversions are pure functions
  with unit tests (dpr 1, 1.25, 1.5, 2, 3; offsets; clamping). The browser suite checks that the backing store really is
  `css × dpr` at dpr 2.
* Scrolling: the page height is the screen (or the writing, once it goes further) plus 0.8 of a screen of fresh paper.
  Both layers are drawn with the transform `scale(dpr) · translate(-scrollX, -scrollY)`, so all drawing code works in page
  coordinates. Wheel/trackpad, two-finger drag, `PageUp/PageDown` and a draggable thumb scroll; the paper pattern moves via a
  `--scroll-y` CSS variable; ink and answers repaint in the same animation frame; scrolling is ignored mid-stroke and the
  scroll is clamped when undo/erase/clear makes the page shorter.
* Sideways scrolling: when the writing is wider than the screen (browser zoom, a narrower window), the page gets wider
  than the screen (the writing plus 240 px for its answer) and scrolls sideways with Shift + wheel, a trackpad or two
  fingers. A thin bar at the bottom shows it. On a normal screen the page width is the screen width, so nothing changes.
* The page is saved to `localStorage` 400 ms after each change (points rounded to 0.1 px) and loaded on start, so a
  reload keeps the work. A loaded page is not an undo step.
* Smoothing: quadratic Béziers through stroke midpoints. The same geometry draws the live stroke piece by piece and
  redraws it from stored points, so a stroke never "jumps" when it is committed.

## 5. Editing tools

* Undo/redo: bounded (200) snapshot history of the immutable stroke array. Each step is O(1) and there is no diff
  logic to get wrong. Clear is just another undoable change. Undo, redo and clear are ignored while a stroke or an erase is
  in progress, so one gesture is always exactly one undo step.
* Stroke eraser: hit-test the eraser circle against each stroke's segments (bounding-box pre-check, then
  point-to-segment distance). One drag is one undo step.
* Pixel eraser (rub-out): vector erasing. The stroke is resampled to about 1 px spacing (pressure interpolated), points inside
  the circle are removed and the survivors become new strokes. Because the data stays vector, the recogniser sees exactly
  what the user sees.
* Scribble eraser (a tool, `S`): the stroke is drawn as a light red trail and, on release, every stroke it covers
  (>= 60 % of its points inside the trail's box) is removed. No gesture test: the tool was picked on purpose. While any
  eraser is in use (or a pen stroke turns into a scribble) the real ink is shown instead of the tidy text.
* Scratch-to-erase: a stroke with >= 4 direction reversals, a path >= 5× its extent and a compact bounding box is a
  scribble. The strokes it covers are deleted and the scribble itself is not kept. A scribble over empty paper stays as
  ink, so nothing is lost by surprise.

## 6. From strokes to answers

1. Line grouping: strokes are merged into lines by padded vertical overlap (padding scales with the median glyph
   height), so a tall `(` or a superscript doesn't split a line and two separate lines don't merge. A row is then split
   wherever the horizontal gap is wider than 3 glyph heights, so `2+3=` and `4×5=` written side by side are two lines
   with two answers (before this they were read as one line, `2+3=4×5=`, and showed a single `5` after the second one).
2. Scheduling (`LineRecognizer`):
   * Wait 0.8 s after the last pen-up, and never while the pen is down. While an edited line is re-read, its previous
     answer stays on the page at 35 % opacity instead of disappearing, then is replaced (no replay if it is unchanged).
   * Cache what the model read per line, keyed by the line's stroke set (LRU 300). Undo/redo, rewriting a previous state
     or editing another line costs no recognition.
   * One request in flight at a time, top to bottom. A request whose line changed is cancelled in the worker; a late
     result for changed strokes is dropped.
3. Stroke -> tensor (`preprocess.ts`, runs in the worker): bounding box + 16 px padding, strokes resampled every
   3 px and drawn white on black, scaled to 128 px high (<= 1024 wide), pasted into a 256 px high canvas whose
   width is a multiple of 64, luminance -> `Float32[1,1,256,W]`, plus a padding mask `[1,256,W]`. The recipe matches what
   ink-on feeds CoMER; `tests/e2e/parity.spec.ts` checks that our OffscreenCanvas version produces the same tensor as
   ink-on's original, pixel for pixel.
   One deliberate change: the stroke width. ink-on draws with the on-screen pen width, so the thickness the model
   sees depends on the pen slider and on how big you write. Measured with the real model: pen width 10 or 16 gave
   0 / 12 correct (the strokes merge into blobs), and a thin pen on very large writing turned `7` into `1`. We draw
   with `5 px / scale`, so every line reaches the model with about 5 px strokes at 128 px height: 12 / 12 for every
   size/width tested (30-160 px writing, pen 2-16). Covered by `accuracy.spec.ts`; the parity test runs with the
   original recipe (`normalizeWidth: false, normalizeSize: false`).
   Second deliberate change: very big writing is scaled down first. With a fixed 16 px margin, a calculation
   written across a phone screen (250 px tall) filled the model image edge to edge and was misread (`4×7=` ->
   `4×1=7`, phantom digits after `=` from about 150 px). Lines taller than 110 px of ink are now scaled to 110 px before
   rasterising, so they reach the model like ordinary writing; measured: the same answers from 30 to 350 px. Ordinary
   writing is below the cap and untouched (scaling every line to a fixed height was tried and cost 2.5 points on the
   benchmark, so it was rejected). A ruled line under a column may also be tilted by up to about 14°, as it often is when
   drawn with a finger.
4. Reading -> statement (`latex.ts`):
   * `... =` is a calculation. With several `=`, the segment before the first one is used, because the model sometimes
     invents a tail (`8 + 8 + 8 = 8 =`).
   * `x = ...` stores a variable, and `x = 3 + 4 =` stores it and shows 7.
   * `y = ...x...` is a graph.
   * `\times`, `\div`, `\cdot`, `\frac{a}{b}`, `^`, `\sqrt`, `\pi`, `e`, `\sin \cos \tan \log` are mapped
     (`sin x`, `sin(x)`, `sin² x`; `sin⁻¹` is refused rather than computed as 1/sin).
   * A dot before a digit is a decimal point (`2·5` = 2.5, `·5` = 0.5): the model often writes a handwritten decimal
     point as `\cdot`. Next to a letter or a bracket (`3·x`, `(2)·(3)`) the dot still multiplies.
   * `x` between two numbers is the multiplication sign, otherwise the variable. Before a bracket (`2x(1+1)`) it is kept
     ambiguous and decided by the solver: the variable when x has a value or appears elsewhere in the line, else `×`. The model reads a handwritten `×` as `x` before a negative number
     too (`5×-3` -> `5 x - 3`); when x has no value the solver retries with that `x` as `×` (`timesReading`), so
     `5×-3=` gives -15 while `x = 10` above it still makes `2x-1=` a variable.
5. Evaluation (`evaluate.ts`): tokenizer -> shunting-yard -> RPN, compiled once and run many times (a graph runs it
   400 times).
   * Precedence (high -> low): brackets, `^` (right-associative), unary minus, `× ÷`, `+ -`.
   * Implicit products: `2(3+4)`, `2x`, `2π`, `3√(4)`.
   * Exact integers: whole numbers stay exact up to 40 digits through a BigInt side-calculation, so
     `99999999 × 99999999 = 9999999800000001`.
   * Decimals: at least 10 significant digits, and never fewer than the whole part plus 2 decimals.
   * Errors (returned, never thrown): `empty`, `syntax`, `undefined` (`÷0`, `0^-1`, `√` of a negative, `log 0`,
     `tan` at a pole), `overflow`, `unknown` (a variable with no value yet).
   * Rounding noise: a sum or difference smaller than 10⁻¹² of its operands is 0, so `0.1×3-0.3 = 0`, not `5.6e-17`.
6. Page solving (`solve.ts`): lines are solved top to bottom with an environment of variables. A variable is visible
   below its definition, like on paper. Changing `x = 10` to `x = 20` re-solves the page from cached readings, with no
   model run. `y = f(x)` is also a formula: `x = 3` further down makes `y + 1 =` evaluate.
7. Equations (`solve.ts`, `graph.ts`): an equation with one unknown is solved numerically. `findZeros` samples the
   difference of the two sides, refines sign changes by bisection (a sign change across a pole such as `tan x` is
   rejected), finds touching roots like `(3x-1)² = 0` as dips of |f| that vanish (a scale-free test, so `x² + 10⁻¹² = 0`
   stays unsolvable), ignores exact zeros that are only floating-point underflow (`eˣ = 0`), and widens the search
   ±10 -> ±100 -> ... -> ±1,000,000. Every solution is checked against the original sides. Two unknowns give a curve.
   If both sides agree at every probe point (`2x = 2x`) the answer is "true for every x". A number written after the
   only "=" that equals the answer (`2 + 2 = 4`) gets a ✓; any other number there is treated as a misread. A short decimal that satisfies the equation exactly is shown with "=" (`1000x = 1`
   gives `x = 0.001`); with more than four solutions the four nearest 0 are shown.
8. Graphs (`graph.ts`, `place.ts`, `app.ts`): built in idle time with an allocation-free float evaluator (no `eval`).
   * `y = f(x)` is framed on its features (roots, turning points, intercept; a far-away pair of roots is kept together),
     with y-limits that ignore outliers and breaks at asymptotes. `F(x, y) = 0` is traced by marching squares with equal units on
     both axes (zooming in or out until the curve fits). `x = c` / `y = c` are lines; a value of x written below
     `y = f(x)` is marked on the curve.
   * Placement: each card goes to the free spot nearest its equation (grid search with a cost that prefers the same
     row, then the right, and penalises leaving the equation's screen); it never covers ink, an answer, a ruled line, the
     toolbar or another card; it shrinks on a crowded page and says no room if nothing fits. Placements are cached and
     do not change while scrolling. Cards are captioned with their equation and fade while the pen passes over them.
9. Column sums (`geometry.ts`, `column.ts`): a long, straight, flat stroke with stacked ink right above it, nothing
   beside it on its row and nothing right under it is a rule (so a minus sign or a fraction bar never is). The rows
   stacked above it are grouped with a tight gap; each must read as `[sign] number`, the sign of each row is applied top to
   bottom, and the result is written under the rule, right-aligned with the digits.

## 7. Performance and memory (measured)

`tests/e2e/performance.spec.ts` and `memory.spec.ts`, Chromium, on a 2-core test machine:

| Measurement | Result |
|---|---|
| Frame time while drawing and recognising: median / p95 | 16.7 ms / 16.7 ms (33 ms on some runs of the 2-core box) |
| Same drawing with the model idle (machine baseline): median / p95 | 16.7 ms / 16.7 ms |
| Main-thread long tasks (> 50 ms) during recognition | none |
| Recognition per line (preprocessing + encoder + decoder), beam 3: median / p95 | 835 ms / 1217 ms |
| JS heap after GC, 24 pages written, read and cleared | 2.31 MB -> 2.70 MB (+0.4 MB, flat) |
| Main bundle (main thread) / worker | 81 KB / 80 KB (onnxruntime is only loaded in the worker) |

* Recognition adds no frame-time cost: the distribution is the same as the idle baseline.
* Two rendering problems showed up when profiling on a 2-core machine:
  1. The status dot pulses while a line is being read. The status pill had `backdrop-filter: blur`, so every frame of
     the pulse re-blurred the page behind it, and drawing during recognition dropped to about 30 FPS (median frame
     33 ms, 280 frames instead of 390 for the same stroke). The pulse now stops while the pen is down.
  2. Every status text change resized the pill and re-blurred it again, giving occasional 50-70 ms tasks right after
     pen-up. The pill is now opaque.
  After both fixes: 16.7 ms median and no long task in 6 of 6 runs.
* A reading in progress also pauses between decoder steps while the pen is down (at most 2 s), so drawing doesn't
  compete with the model for the CPU. The occasional 33 ms p95 is the 2-core test box itself; on a normal laptop it is
  16.7 ms.
* Threads: inference uses at most half the cores (max 4). ink-on used all of them, which is faster per line but
  competes with the UI and the compositor. Smooth drawing is the hard requirement.
* Beam width adapts to the device: 1 on <= 2 GB RAM, 2 on <= 4 cores, otherwise 3.
* Memory is bounded by design: 200 undo snapshots that share stroke objects, a 300-entry result cache, animation
  state cleared every frame, graph samples kept in a `WeakMap` tied to the answer, and ONNX tensors disposed after every
  run (in `finally` blocks).

## 8. Offline and privacy

`onnxruntime-web` normally fetches its `.wasm` from a public CDN. `scripts/copy-ort.mjs` copies it to `/ort/` and the
worker sets `ort.env.wasm.wasmPaths` to it. The model lives in `/models/comer/` and the handwriting font is bundled.
`vite-plugin-pwa` precaches the shell, runtime, model and font, and the service worker claims the page on the first
visit (`clientsClaim`), so the first load is already enough to work offline. Verified by `offline.spec.ts`, which loads
once, switches the network off, reloads and calculates. The same suite fails on any request to another origin. The unit
safety scan fails on `eval`, `Function(` or any `http(s)://` URL in the source (and has self-tests, so it can't silently
pass).

## 9. UX details

* Paper: warm paper, ruled lines, a red margin, blue-black ink; lined, squared, dotted or plain paper (`B`); six pen
  colours (`C`); a scrolling page with a slim scrollbar; the status pill fades when your work passes under it. Answers are in a bundled handwriting font (Caveat,
  OFL), green for values, red italic Undefined, grey `?`.
* Small touches:
  * Answers are written left to right (a 420 ms clip reveal) and graphs draw their curve the same way.
  * The tidy text cross-fades over the ink.
  * A short vibration when an answer lands (phones that support it).
  * An edited line keeps its old answer, faded, while it is being read again, so nothing blinks.
  * `prefers-reduced-motion` turns the animations off.
* Confidence: if the least certain relevant symbol is below 60 %, the answer gets a dotted amber underline. The status
  bar shows the reading, its confidence, the reason for a `?` (e.g. x has no value yet) and the time it took.
* Answer size follows the handwriting. Glyphs are measured as whole symbols (strokes grouped by horizontal overlap),
  and only full-height ones count, so the answer to `7×8=` or `x+5=` is not drawn half-size.

## 10. Testing

| Area | Tests |
|---|---|
| Parser | BODMAS, nested brackets, decimals, negatives, unary chains, implicit products, `÷0`, malformed input, overflow, injection strings, big integers, precision, variables, `√`, `π` |
| LaTeX / statements | operators, fractions, powers (incl. `2 ^ - 1`), `x` as sign or variable, trailing/duplicate `=`, phantom tails, assignments, plots |
| Page solver | variables flow down, redefinition, unknown variables, Undefined in an assignment, exact big values through variables, formulas `y = f(x)` |
| Equations and graphs | linear, transcendental, double roots, no-solution, poles, underflow; framing, ticks, marching squares, circles stay round |
| Column sums and placement | row parsing (signs, decimals), per-row signs, rule detection (not a minus, not a fraction bar), grouping; card placement never overlaps, shrinks, gives up |
| Decoder (fake model) | long digit runs (the ink-on bug), runaway guard, vocabulary mask, confidence renormalisation, beam vs greedy, cancellation |
| Preprocessing | layout maths, mask, resampling, meaningful-ink check; pixel parity with ink-on in the browser |
| Coordinates / ink | dpr 1-3, offsets, scaling, round trips; hit-testing, rub-out splitting, line grouping, writing height, history bounds, scratch detection |
| Scheduler | debounce, pen-down pause, caching, stale results, cancellation, candidate choice, variables across lines, retry, dispose |
| Browser (real model) | all user flows, offline, foreign-request audit, frame timing, memory, accuracy benchmark, strict graph layout, features used together, scrolling, phone-size screen, and a seeded fuzz test (random sessions of writing, erasing, undo/redo, clear, scrolling and toggles with invariants checked after every step) |

## 11. Known limitations and next steps

* Accuracy is bounded by CoMER on very messy handwriting. `×` vs `x` and `1` vs `7` are the usual confusions; the
  confidence underline points them out. The benchmark uses synthetic handwriting, so real-world accuracy will be lower.
* Only the WASM execution provider is used (predictable, works everywhere). WebGPU could cut latency on capable devices.
* The decoder re-runs the whole prefix every step (the exported decoder has no KV cache), so long lines are slower.
* A dot between two digits is always a decimal point, so `2·3·4` is 2.3 × 4; write `×` to multiply numbers.
* Not built yet: inverse trigonometric functions and `ln` (not in the model's vocabulary), pan and zoom inside a graph,
  export of the page.
