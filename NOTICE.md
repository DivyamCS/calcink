# Third-party notices

CalcInk's own source code is MIT licensed (see `LICENSE`). It builds on the following open-source work.

| Component | Used for | License |
|---|---|---|
| CoMER handwritten-math-expression recogniser (Zhao & Gao, ECCV 2022, [github.com/Green-Wood/CoMER](https://github.com/Green-Wood/CoMER)), trained on CROHME | The model in `public/models/comer/` | We found no licence file in the CoMER repository, so all rights stay with the authors; used unmodified, with attribution, for a non-commercial project. CROHME data: competition terms. Check before reusing the model files commercially. |
| [ink-on](https://github.com/kimseungdae/ink-on) | The INT8 ONNX export of CoMER and its `vocab.json` (downloaded by `scripts/fetch-models.mjs`). Its stroke-preprocessing recipe was adapted in `src/recognition/preprocess.ts`, rewritten to run in a Web Worker. The beam-search decoder in `src/recognition/decoder.ts` follows the shape of its decoder. Used unmodified as a dev dependency only by the parity test and the baseline benchmark. | Apache-2.0 |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) | Runs the ONNX model in the browser (WebAssembly) | MIT |
| Caveat font (Impallari Type) via [@fontsource/caveat](https://fontsource.org/fonts/caveat) | Handwriting font for answers, bundled for offline use | SIL Open Font License 1.1 |
| [Vite](https://vitejs.dev), [vite-plugin-pwa](https://github.com/vite-pwa/vite-plugin-pwa), [Vitest](https://vitest.dev), [Playwright](https://playwright.dev), TypeScript | Tooling and tests | MIT / Apache-2.0 |

Reference projects that informed the design (no code copied):
AI-Math-Notes (the UI idea of answers written beside the equation) and Sagyam's arithmetic-recognition project (symbol
list and dataset ideas; GPL-3.0, deliberately not copied).

## Apache-2.0 attribution for the adapted preprocessing

`src/recognition/preprocess.ts` reproduces the image-preparation constants and steps of ink-on's
`src/core/preprocessing.ts` (Copyright 2025 kimseungdae, Apache License 2.0), because the model expects its input prepared
exactly that way. The code was rewritten to take a canvas factory (OffscreenCanvas in the worker) and split into pure,
unit-tested functions. A copy of the Apache License 2.0 is available at https://www.apache.org/licenses/LICENSE-2.0 and
ships with the ink-on package (`node_modules/ink-on/LICENSE`).
