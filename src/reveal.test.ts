import { describe, expect, it } from 'vitest';
import { ERROR_DELAY_MS, errorWait } from './reveal.ts';

describe('errorWait', () => {
  it('holds an error mark back until the page has been quiet for the delay', () => {
    expect(errorWait(1000, 1000, false)).toBe(ERROR_DELAY_MS);
    expect(errorWait(1000 + ERROR_DELAY_MS - 1, 1000, false)).toBe(1);
    expect(errorWait(1000 + ERROR_DELAY_MS, 1000, false)).toBe(0);
    expect(errorWait(99_999, 1000, false)).toBe(0);
  });

  it('never shows one while the pen is down', () => {
    expect(errorWait(99_999, 1000, true)).toBe(Infinity);
  });

  it('a fresh stroke restarts the wait', () => {
    expect(errorWait(5000, 4900, false, 1000)).toBe(900);
  });
});
