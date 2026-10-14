// Fixed-capacity ring buffer of multichannel samples: one Float64Array of timestamps plus one
// Float32Array per channel. Oldest samples are overwritten. Index 0 is the oldest sample held.

export class RingBuffer {
  readonly capacity: number;
  readonly channels: number;
  readonly t: Float64Array;
  readonly x: Float32Array[];
  private head = 0;   // next write position
  private n = 0;

  constructor(capacity: number, channels: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.channels = channels;
    this.t = new Float64Array(this.capacity);
    this.x = Array.from({ length: channels }, () => new Float32Array(this.capacity));
  }

  get length(): number { return this.n; }

  /** Physical array index of logical sample i (0 = oldest). */
  index(i: number): number {
    return (this.head - this.n + i + this.capacity) % this.capacity;
  }

  timeAt(i: number): number { return this.t[this.index(i)]; }
  valueAt(ch: number, i: number): number { return this.x[ch][this.index(i)]; }

  get lastTime(): number { return this.n ? this.timeAt(this.n - 1) : NaN; }
  get firstTime(): number { return this.n ? this.timeAt(0) : NaN; }

  /** Append a channel-major batch: x[ch][i] belongs to t[i]. null (non-finite on the wire) → NaN. */
  push(t: ArrayLike<number>, x: ArrayLike<ArrayLike<number | null>>): void {
    const m = t.length;
    for (let i = 0; i < m; i++) {
      this.t[this.head] = t[i];
      for (let c = 0; c < this.channels; c++) {
        const v = x[c]?.[i];
        this.x[c][this.head] = v == null ? NaN : v;
      }
      this.head = (this.head + 1) % this.capacity;
    }
    this.n = Math.min(this.capacity, this.n + m);
  }

  /** First logical index with time >= t (binary search; times are non-decreasing). */
  lowerBound(time: number): number {
    let lo = 0, hi = this.n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.timeAt(mid) < time) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  clear(): void { this.head = 0; this.n = 0; }
}
