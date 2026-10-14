// Drawing-side decimation: reduce the samples of one channel inside [t0, t1) to one min/max pair per
// pixel column, so a 10 s window of a fast stream costs O(width) to draw and spikes never vanish.

import type { RingBuffer } from './ringbuffer';

export interface ColumnEnvelope {
  min: Float32Array;
  max: Float32Array;
  /** 1 where the column holds at least one finite sample. */
  has: Uint8Array;
  /** Overall finite min / max in the window (NaN if none), for auto-scaling. */
  lo: number;
  hi: number;
}

export function columnEnvelope(rb: RingBuffer, ch: number, t0: number, t1: number, cols: number): ColumnEnvelope {
  const n = Math.max(1, Math.floor(cols));
  const min = new Float32Array(n).fill(Infinity);
  const max = new Float32Array(n).fill(-Infinity);
  const has = new Uint8Array(n);
  let lo = Infinity, hi = -Infinity;
  const span = t1 - t0;
  if (span > 0 && rb.length) {
    const xs = rb.x[ch];
    for (let i = rb.lowerBound(t0); i < rb.length; i++) {
      const p = rb.index(i);
      const t = rb.t[p];
      if (t >= t1) break;
      const v = xs[p];
      if (!Number.isFinite(v)) continue;
      const c = Math.min(n - 1, Math.floor(((t - t0) / span) * n));
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
      has[c] = 1;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return { min, max, has, lo: lo === Infinity ? NaN : lo, hi: hi === -Infinity ? NaN : hi };
}
