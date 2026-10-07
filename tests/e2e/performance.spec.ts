import { expect, test } from '@playwright/test';
import { openApp, settled, write } from './helpers.ts';

test('drawing stays smooth during recognition', async ({ page }, info) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __frames: number[]; __long: Array<{ start: number; duration: number }> };
    w.__frames = [];
    w.__long = [];
    const tick = (t: number): void => {
      w.__frames.push(t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__long.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  });
  await openApp(page, '?delay=0');
  await page.waitForTimeout(500); // let start-up work finish

  /** Draw a long wavy line and return frame stats + main-thread long tasks while drawing. */
  const drawWave = async (y: number, watch: boolean) => {
    const t0 = await page.evaluate(() => performance.now());
    let sawReading = false;
    await page.mouse.move(100, y);
    await page.mouse.down();
    for (let i = 0; i < 240; i++) {
      await page.mouse.move(100 + i * 4, y + Math.sin(i / 6) * 40);
      if (watch && i % 20 === 0 && /Reading/.test((await page.textContent('#status-text')) ?? '')) sawReading = true;
    }
    await page.mouse.up();
    const t1 = await page.evaluate(() => performance.now());
    const { frames, long } = await page.evaluate(([a, b]) => {
      const w = window as unknown as { __frames: number[]; __long: Array<{ start: number; duration: number }> };
      return { frames: w.__frames.filter((t) => t >= a && t <= b), long: w.__long.filter((l) => l.start >= a - 50 && l.start <= b) };
    }, [t0, t1]);
    const gaps = frames.slice(1).map((t, i) => t - frames[i]).sort((x, y) => x - y);
    return {
      durationMs: Math.round(t1 - t0),
      frames: frames.length,
      p50Ms: +gaps[Math.floor(gaps.length * 0.5)].toFixed(1),
      p95Ms: +gaps[Math.floor(gaps.length * 0.95)].toFixed(1),
      maxMs: +gaps[gaps.length - 1].toFixed(1),
      longTasks: long,
      sawReading,
    };
  };

  // 1) baseline: the same drawing with nothing being recognised (measures the test machine itself)
  const baseline = await drawWave(560, false);
  await settled(page);
  // 2) one line to read, then keep drawing while it is being read
  await write(page, '123+456=', { x: 120, y: 140, seed: 1 });
  const busy = await drawWave(420, true);
  const sawReading = busy.sawReading;
  await settled(page);
  const long = busy.longTasks;
  const summary = { baseline, whileRecognising: busy };
  info.annotations.push({ type: 'frame-timing', description: JSON.stringify(summary) });
  console.log('frame timing:', JSON.stringify(summary));

  expect(sawReading, 'recognition was running while we drew').toBe(true);
  expect(long, 'no main-thread task over 50 ms during recognition').toEqual([]);
  // recognition must not make drawing any less smooth than the same drawing with the model idle
  // (on a normal machine both are ~16.7 ms = 60 FPS; a loaded CI box raises both equally)
  expect(busy.p95Ms).toBeLessThanOrEqual(Math.max(20, baseline.p95Ms * 1.25));
  expect(busy.p50Ms).toBeLessThanOrEqual(Math.max(18, baseline.p50Ms * 1.25));
});
