// EMG activation: RMS over the last `window` seconds (after removing the window's mean, so a DC offset
// doesn't read as activity), plus a peak-hold marker that holds for `holdSec` and then decays.

import type { RingBuffer } from './ringbuffer';

export const RMS_WINDOW_SEC = 0.2;

export function rmsWindow(rb: RingBuffer, ch: number, tEnd: number, window = RMS_WINDOW_SEC): number {
  if (!rb.length) return NaN;
  const xs = rb.x[ch];
  let n = 0, sum = 0, sum2 = 0;
  for (let i = rb.lowerBound(tEnd - window); i < rb.length; i++) {
    const p = rb.index(i);
    if (rb.t[p] > tEnd) break;
    const v = xs[p];
    if (!Number.isFinite(v)) continue;
    n++; sum += v; sum2 += v * v;
  }
  if (!n) return NaN;
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
}

export class PeakHold {
  value = 0;
  private heldAt = -Infinity;
  private last = NaN;

  /** decayPerSec: fraction of the peak lost per second once the hold time has passed. */
  constructor(private holdSec = 1.0, private decayPerSec = 0.5) {}

  /** Feed the current level at time `now` (seconds); returns the held peak. */
  update(level: number, now: number): number {
    const dt = Number.isFinite(this.last) ? Math.max(0, now - this.last) : 0;
    this.last = now;
    if (!Number.isFinite(level)) return this.value;
    if (level >= this.value) {
      this.value = level;
      this.heldAt = now;
    } else if (now - this.heldAt > this.holdSec) {
      this.value = Math.max(level, this.value * Math.pow(1 - this.decayPerSec, dt));
    }
    return this.value;
  }

  reset(): void { this.value = 0; this.heldAt = -Infinity; this.last = NaN; }
}
