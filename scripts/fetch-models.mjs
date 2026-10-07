// Download the CoMER model files (INT8 ONNX from ink-on) into public/models/comer/ if they are missing.
// They are committed to the repo, so this normally does nothing.
//
//   node scripts/fetch-models.mjs            download if missing
//   node scripts/fetch-models.mjs --force    download again
//   MODEL_BASE_URL=https://my.mirror/path node scripts/fetch-models.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'public', 'models', 'comer');
const FILES = ['encoder_int8.onnx', 'decoder_int8.onnx', 'vocab.json'];
const force = process.argv.includes('--force');

const BASES = [
  process.env.MODEL_BASE_URL,
  'https://github.com/kimseungdae/ink-on/releases/download/v0.1.0',
  'https://github.com/kimseungdae/ink-on/releases/latest/download',
].filter(Boolean);

fs.mkdirSync(dest, { recursive: true });

async function download(file) {
  const target = path.join(dest, file);
  if (!force && fs.existsSync(target) && fs.statSync(target).size > 0) return 'cached';
  let lastError = 'no source worked';
  for (const base of BASES) {
    const url = `${base.replace(/\/$/, '')}/${file}`;
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) { lastError = `${url} -> HTTP ${res.status}`; continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) { lastError = `${url} -> empty file`; continue; }
      fs.writeFileSync(target + '.part', buf);
      fs.renameSync(target + '.part', target);
      return `downloaded (${(buf.length / 1048576).toFixed(1)} MB)`;
    } catch (e) {
      lastError = `${url} -> ${e instanceof Error ? e.message : e}`;
    }
  }
  throw new Error(lastError);
}

let failed = false;
for (const file of FILES) {
  try {
    console.log(`[models] ${file}: ${await download(file)}`);
  } catch (e) {
    failed = true;
    console.warn(`[models] ${file}: FAILED (${e.message})`);
  }
}

if (failed) {
  console.warn(
    '\n[models] Could not fetch every model file. The app will still start, but it cannot read handwriting\n' +
      'until public/models/comer/ contains: ' + FILES.join(', ') + '\n' +
      'Download them from https://github.com/kimseungdae/ink-on/releases (or set MODEL_BASE_URL) and re-run `npm run models`.\n',
  );
}
// never block `npm run dev` / `npm run build` on the network
process.exit(0);
