import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

// Cross-origin isolation lets onnxruntime-web use multi-threaded WASM (SharedArrayBuffer).
// Everything CalcInk loads is same-origin, so `require-corp` is safe.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },

  resolve: {
    alias: [
      // WASM-only build of onnxruntime-web (smaller, and copy-ort.mjs copies exactly its files)
      { find: /^onnxruntime-web$/, replacement: 'onnxruntime-web/wasm' },
    ],
  },

  worker: {
    format: 'es',
    // onnxruntime-web also emits its .wasm into assets/, but the worker loads it from /ort/ (wasmPaths),
    // so that copy is never used. Drop it so the 14 MB file isn't deployed twice.
    plugins: () => [
      {
        name: 'drop-unused-ort-wasm',
        generateBundle(_options, bundle) {
          for (const name of Object.keys(bundle)) if (/ort-wasm.*\.wasm$/.test(name)) delete bundle[name];
        },
      },
    ],
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },

  // ink-on ships ES modules that import onnxruntime-web; keep both out of the pre-bundler's way
  // so the alias above applies and the WASM files are loaded from /ort/ (not inlined).
  optimizeDeps: { exclude: ['onnxruntime-web'] },

  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false, // main.ts registers the service worker itself
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'CalcInk',
        short_name: 'CalcInk',
        description: 'Handwritten calculator. Runs entirely on your device, even offline.',
        theme_color: '#f3ecdc',
        background_color: '#fbf7ec',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        // Precache the app shell and the recogniser (WASM runtime + model files) so the very
        // first visit is enough to work offline.
        globPatterns: ['**/*.{js,css,html,svg,png,json,woff2}', 'ort/*.{wasm,mjs}', 'models/**/*.{onnx,json}'],
        maximumFileSizeToCacheInBytes: 120 * 1024 * 1024,
        navigateFallback: '/index.html',
        // take control of the page on the first visit (otherwise only after a reload), and replace an old
        // version as soon as a new one is installed
        clientsClaim: true,
        skipWaiting: true,
        cleanupOutdatedCaches: true,
      },
    }),
  ],

  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
