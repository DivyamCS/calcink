// Error marks ("?") wait until the pen is up and the page has been quiet for a moment, otherwise
// they flicker while a line is half written. Answers show immediately.
export const ERROR_DELAY_MS = 2500;

/** ms until an error mark may be shown (0 = show now, Infinity = pen is down, wait for it to lift). */
export function errorWait(now: number, lastInkChange: number, penDown: boolean, delay = ERROR_DELAY_MS): number {
  if (penDown) return Infinity;
  return Math.max(0, lastInkChange + delay - now);
}
