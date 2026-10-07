export type Tone = 'answer' | 'error';

/** Short vibration where the device supports it; silently does nothing elsewhere (desktop, iOS). */
export function haptic(tone: Tone): void {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(tone === 'answer' ? 12 : [8, 40, 8]);
  } catch {
    // some browsers throw without a recent user gesture
  }
}
