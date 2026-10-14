// EMG activation bars: per-channel RMS over the last 200 ms with a peak-hold tick. The bar scale follows
// the largest held peak (auto), so it works for raw counts and volts alike.

import type { RingBuffer } from '../lib/ringbuffer';
import { PeakHold, rmsWindow, RMS_WINDOW_SEC } from '../lib/rms';
import { fmtValue } from '../ui/dom';

export class RmsBars {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private peaks: PeakHold[];
  private scale = NaN;
  levels: number[];

  constructor(private rb: RingBuffer, private labels: string[]) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'rms';
    this.ctx = this.canvas.getContext('2d')!;
    this.peaks = labels.map(() => new PeakHold(1.0, 0.6));
    this.levels = labels.map(() => NaN);
  }

  draw(now: number): void {
    const c = this.canvas, ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const wall = performance.now() / 1000;
    const n = this.labels.length;
    let top = 0;
    for (let ch = 0; ch < n; ch++) {
      const v = rmsWindow(this.rb, ch, now, RMS_WINDOW_SEC);
      this.levels[ch] = v;
      top = Math.max(top, this.peaks[ch].update(v, wall));
    }
    if (top > 0) this.scale = Number.isFinite(this.scale) ? Math.max(top, this.scale * 0.995) : top;
    const scale = this.scale > 0 ? this.scale * 1.1 : 1;
    const labelH = 28, barH = h - labelH - 4;
    const slot = w / n, bw = Math.max(6, Math.min(36, slot * 0.6));
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (let ch = 0; ch < n; ch++) {
      const cx = slot * ch + slot / 2;
      const v = this.levels[ch];
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(cx - bw / 2, 4, bw, barH);
      if (Number.isFinite(v)) {
        const bh = Math.min(1, v / scale) * barH;
        ctx.fillStyle = '#4fc3f7';
        ctx.fillRect(cx - bw / 2, 4 + barH - bh, bw, bh);
      }
      const pk = this.peaks[ch].value;
      if (pk > 0) {
        ctx.fillStyle = '#ffb74d';
        ctx.fillRect(cx - bw / 2 - 2, 4 + barH - Math.min(1, pk / scale) * barH - 1, bw + 4, 2);
      }
      ctx.fillStyle = 'rgba(232,234,237,0.8)';
      ctx.fillText(this.labels[ch], cx, h - 16);
      ctx.fillStyle = 'rgba(232,234,237,0.5)';
      ctx.fillText(fmtValue(v), cx, h - 3);
    }
    ctx.textAlign = 'start';
  }
}
