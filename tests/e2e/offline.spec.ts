import { expect, test } from '@playwright/test';
import { openApp, settled, write } from './helpers.ts';

test('no request ever leaves the page origin', async ({ page }) => {
  const foreign: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol !== 'data:' && u.protocol !== 'blob:' && u.host !== 'localhost:4173') foreign.push(r.url());
  });
  await openApp(page, '?delay=300');
  await write(page, '18+4×3=', { x: 120, y: 160, seed: 3 });
  expect((await settled(page))[0]).toMatchObject({ text: '30' });
  expect(foreign).toEqual([]);
});

test('works offline after the first visit (service worker precache)', async ({ page, context }) => {
  await openApp(page, '?delay=300');
  // the service worker takes control on the first visit and precaches the app, runtime and model
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 60_000 }).toBe(true);
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const urls: string[] = [];
          for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) urls.push(r.url);
          return ['encoder_int8.onnx', 'decoder_int8.onnx', 'vocab.json', 'ort-wasm-simd-threaded.wasm', 'index.html'].every((f) =>
            urls.some((u) => u.includes(f)),
          );
        }),
      { timeout: 120_000 },
    )
    .toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#status-text')).toContainText('Ready', { timeout: 150_000 });
  await expect(page.locator('#status-text')).toContainText('offline');
  await write(page, '7×8=', { x: 120, y: 160, seed: 2 });
  expect((await settled(page))[0]).toMatchObject({ kind: 'value', text: '56' });
  await context.setOffline(false);
});
