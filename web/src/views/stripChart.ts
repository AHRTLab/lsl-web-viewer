// Strip charts for one stream: one lane per channel on a single canvas, drawn from the stream's ring
// buffer as one min/max segment per pixel column (lib/decimate.ts), so the cost is O(width × channels)
// regardless of the sample rate. "Now" is the stream's newest timestamp, advanced smoothly by the wall
// clock between batches (and never more than 0.3 s past the data).

import { columnEnvelope } from '../lib/decimate';
import type { RingBuffer } from '../lib/ringbuffer';
import { fmtValue } from '../ui/dom';

const COLORS = ['#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8', '#4db6ac', '#fff176', '#90a4ae',
                '#f06292', '#aed581', '#7986cb', '#ffd54f'];
const LANE_MIN_PX = 34, LANE_MAX_PX = 90, LABEL_W = 64;

export interface ChartView {
  windowSec: number;
  auto: boolean;
  fixedRange: number;   // ± range in fixed mode (stream units)
}

export class StripChart {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ranges: { lo: number; hi: number }[];   // smoothed auto-scale per channel
  lastNow = NaN;

  constructor(private rb: RingBuffer, private labels: string[]) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'strip';
    this.ctx = this.canvas.getContext('2d')!;
    this.ranges = labels.map(() => ({ lo: NaN, hi: NaN }));
    const lane = Math.max(LANE_MIN_PX, Math.min(LANE_MAX_PX, Math.floor(480 / Math.max(1, labels.length))));
    this.canvas.style.height = `${lane * labels.length + 18}px`;
  }

  draw(now: number, view: ChartView): void {
    const c = this.canvas, ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const cssW = c.clientWidth, cssH = c.clientHeight;
    if (!cssW || !cssH) return;
    if (c.width !== Math.round(cssW * dpr) || c.height !== Math.round(cssH * dpr)) {
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    this.lastNow = now;
    const n = this.labels.length;
    const axisH = 16;
    const laneH = (cssH - axisH) / Math.max(1, n);
    const plotW = Math.max(10, cssW - LABEL_W);
    const t1 = now, t0 = now - view.windowSec;
    const cols = Math.floor(plotW);

    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (let ch = 0; ch < n; ch++) {
      const top = ch * laneH;
      const env = columnEnvelope(this.rb, ch, t0, t1, cols);
      let lo: number, hi: number;
      if (view.auto) {
        const r = this.ranges[ch];
        if (Number.isFinite(env.lo)) {
          // grow instantly, shrink slowly, so the trace doesn't pump with every burst
          r.lo = Number.isFinite(r.lo) ? Math.min(env.lo, r.lo + (env.lo - r.lo) * 0.05) : env.lo;
          r.hi = Number.isFinite(r.hi) ? Math.max(env.hi, r.hi + (env.hi - r.hi) * 0.05) : env.hi;
        }
        lo = r.lo; hi = r.hi;
        if (!Number.isFinite(lo)) { lo = -1; hi = 1; }
        if (hi - lo < 1e-12) { lo -= 0.5 * (Math.abs(lo) || 1); hi += 0.5 * (Math.abs(hi) || 1); }
        const pad = (hi - lo) * 0.08;
        lo -= pad; hi += pad;
      } else {
        lo = -view.fixedRange; hi = view.fixedRange;
      }

      // lane background + zero line
      ctx.fillStyle = ch % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.045)';
      ctx.fillRect(LABEL_W, top, plotW, laneH);
      const y = (v: number) => top + laneH - ((v - lo) / (hi - lo)) * laneH;
      if (lo < 0 && hi > 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.beginPath(); ctx.moveTo(LABEL_W, y(0)); ctx.lineTo(LABEL_W + plotW, y(0)); ctx.stroke();
      }

      // trace: a vertical min→max segment per column, joined to the next column
      ctx.save();
      ctx.beginPath();
      ctx.rect(LABEL_W, top, plotW, laneH);
      ctx.clip();
      ctx.strokeStyle = COLORS[ch % COLORS.length];
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < cols; i++) {
        if (!env.has[i]) continue;   // gaps stay open only where the data has none for a while
        const x = LABEL_W + i + 0.5;
        if (!pen) { ctx.moveTo(x, y(env.min[i])); pen = true; } else ctx.lineTo(x, y(env.min[i]));
        if (env.max[i] !== env.min[i]) ctx.lineTo(x, y(env.max[i]));
      }
      ctx.stroke();
      ctx.restore();

      // label + range
      ctx.fillStyle = COLORS[ch % COLORS.length];
      ctx.fillText(this.labels[ch], 6, top + laneH / 2 - (laneH > 40 ? 7 : 0));
      if (laneH > 40) {
        ctx.fillStyle = 'rgba(232,234,237,0.45)';
        ctx.fillText(`±${fmtValue(Math.max(Math.abs(lo), Math.abs(hi)))}`, 6, top + laneH / 2 + 8);
      }
    }

    // time axis (seconds before now)
    ctx.fillStyle = 'rgba(232,234,237,0.5)';
    ctx.textBaseline = 'alphabetic';
    const ticks = view.windowSec <= 2 ? 0.5 : view.windowSec <= 5 ? 1 : 2;
    for (let s = 0; s <= view.windowSec + 1e-9; s += ticks) {
      const x = LABEL_W + plotW - (s / view.windowSec) * plotW;
      ctx.fillRect(x, cssH - axisH, 1, 4);
      const label = s === 0 ? 'now' : `-${s}s`;
      ctx.fillText(label, Math.min(cssW - 24, Math.max(LABEL_W, x - 10)), cssH - 3);
    }
  }
}
