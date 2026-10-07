import { expect, test } from '@playwright/test';
import { openApp, settled, write } from './helpers.ts';

test('memory stays flat over a long drawing session', async ({ page }, info) => {
  test.setTimeout(600_000);
  await openApp(page, '?delay=0');
  const cdp = await page.context().newCDPSession(page);
  const heap = async (): Promise<number> => {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    return (await cdp.send('Runtime.getHeapUsage')).usedSize;
  };

  const samples: number[] = [];
  const pages = 24;
  for (let i = 0; i < pages; i++) {
    await write(page, `${i % 9 + 1}+${(i * 7) % 10}=`, { x: 120, y: 140, seed: i + 1, mess: 0.5 });
    await write(page, `${(i * 3) % 9 + 1}×${i % 7 + 2}=`, { x: 120, y: 280, seed: i + 50, mess: 0.5 });
    await settled(page);
    // erase with undo/redo churn too, then clear the page
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+Shift+z');
    await page.click('#clear');
    if (i === 5 || i === pages - 1) samples.push(await heap());
  }
  const growthMb = (samples[1] - samples[0]) / 1048576;
  const summary = { afterWarmupMb: +(samples[0] / 1048576).toFixed(2), endMb: +(samples[1] / 1048576).toFixed(2), growthMb: +growthMb.toFixed(2), pages };
  info.annotations.push({ type: 'memory', description: JSON.stringify(summary) });
  console.log('heap after GC:', JSON.stringify(summary));
  expect(growthMb).toBeLessThan(2);
});
