// Copy onnxruntime-web's WASM files into public/ort/ so they are served locally instead of from a CDN
// (needed for offline use). Runs after `npm install`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules', 'onnxruntime-web', 'dist');
const dest = path.join(root, 'public', 'ort');

if (!fs.existsSync(src)) {
  console.warn('[copy-ort] onnxruntime-web is not installed yet - skipping.');
  process.exit(0);
}

// the slim WASM build only needs the plain (non-JSEP/WebGPU/asyncify) runtime files
const wanted = (f) => /^ort-wasm.*\.(wasm|mjs)$/.test(f) && !/jsep|asyncify|jspi|webgpu/.test(f);

fs.mkdirSync(dest, { recursive: true });
let n = 0;
for (const f of fs.readdirSync(src).filter(wanted)) {
  fs.copyFileSync(path.join(src, f), path.join(dest, f));
  n++;
}
console.log(`[copy-ort] copied ${n} onnxruntime-web runtime file(s) to public/ort/`);
if (n === 0) console.warn('[copy-ort] no ort-wasm* files found - check the onnxruntime-web version.');
