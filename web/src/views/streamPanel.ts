// Everything shown for one subscribed stream: a header with its metadata and display controls, the
// strip charts, and, depending on the stream, RMS bars (EMG), a 3D orientation box (IMU, >= 4 ch) and a
// value readout + log (markers and low-rate streams). Marker streams get only the readout + log.

import { RingBuffer } from '../lib/ringbuffer';
import { isEmg, isImu, isLowRate, isMarker, type StreamRow } from '../protocol';
import { el, fmtRate, labeled, numberInput } from '../ui/dom';
import { ImuView } from './imuView';
import { MarkerView } from './markerView';
import { RmsBars } from './rmsBars';
import { StripChart, type ChartView } from './stripChart';

const MAX_DISPLAY_RATE = 600; // the server decimates to this (lsl_web_viewer/inlets.py)
const MAX_WINDOW_SEC = 10;

export class StreamPanel {
  readonly root: HTMLElement;
  readonly rb: RingBuffer;
  private chart: StripChart | null = null;
  private rms: RmsBars | null = null;
  readonly imu: ImuView | null = null;
  private markers: MarkerView | null = null;
  private lastT = NaN;
  private lastArrival = 0;
  readonly view: ChartView = { windowSec: 5, auto: true, fixedRange: 100 };
  /** Points received (after server-side decimation) and messages, for the status line / tests. */
  received = 0;
  batches = 0;

  constructor(public row: StreamRow) {
    const labels = row.channel_labels.length === row.channels ? row.channel_labels
      : Array.from({ length: row.channels }, (_, i) => `ch${i + 1}`);
    const rate = row.srate > 0 ? Math.min(row.srate, MAX_DISPLAY_RATE) : 400;
    this.rb = new RingBuffer(Math.ceil((MAX_WINDOW_SEC + 1) * rate) + 64, row.channels);

    this.root = el('section', 'stream-panel');
    this.root.dataset.uid = row.uid;
    const head = el('header', 'stream-head');
    const title = el('div', 'stream-title');
    title.append(el('strong', '', row.name),
      el('span', 'muted', ` ${row.type || '—'} · ${row.channels} ch · ${fmtRate(row.srate)} · ${row.fmt} · ${row.hostname}`));
    head.append(title);
    this.root.append(head);

    if (!isMarker(row)) {
      head.append(this.controls());
      const body = el('div', 'stream-body');
      this.chart = new StripChart(this.rb, labels);
      const main = el('div', 'stream-main');
      main.append(this.chart.canvas);
      body.append(main);
      const side = el('div', 'stream-side');
      if (isEmg(row)) {
        this.rms = new RmsBars(this.rb, labels);
        side.append(el('div', 'side-title', 'RMS (200 ms) · peak hold'), this.rms.canvas);
      }
      if (isImu(row)) {
        this.imu = new ImuView(this.rb);
        side.append(el('div', 'side-title', `orientation · [${labels.slice(0, 4).join(', ')}] as w x y z`), this.imu.root);
      }
      if (isLowRate(row)) {
        this.markers = new MarkerView(labels);
        side.append(el('div', 'side-title', 'latest values'), this.markers.root);
      }
      if (side.childElementCount) body.append(side);
      this.root.append(body);
    } else {
      this.markers = new MarkerView(labels);
      this.root.append(this.markers.root);
    }
  }

  private controls(): HTMLElement {
    const box = el('div', 'stream-controls');
    const win = el('select', 'sel');
    for (const s of [2, 5, 10]) {
      const o = el('option', '', `${s} s`, { value: String(s) });
      if (s === this.view.windowSec) o.selected = true;
      win.append(o);
    }
    win.addEventListener('change', () => { this.view.windowSec = Number(win.value); });
    const scale = el('select', 'sel');
    scale.append(el('option', '', 'auto', { value: 'auto' }), el('option', '', 'fixed ±', { value: 'fixed' }));
    const range = numberInput(this.view.fixedRange, 0, 1e12, 1);
    range.disabled = true;
    scale.addEventListener('change', () => { this.view.auto = scale.value === 'auto'; range.disabled = this.view.auto; });
    range.addEventListener('input', () => {
      const v = Number(range.value);
      if (Number.isFinite(v) && v > 0) this.view.fixedRange = v;
    });
    box.append(labeled('window', win, 'field inline'), labeled('scale', scale, 'field inline'), range);
    return box;
  }

  onData(t: number[], x: (number | null)[][]): void {
    if (!t.length) return;
    this.rb.push(t, x);
    this.received += t.length;
    this.batches++;
    this.lastT = t[t.length - 1];
    this.lastArrival = performance.now();
    this.markers?.addNumbers(t, x);
  }

  onMarkers(t: number[], values: string[]): void {
    this.received += values.length;
    this.batches++;
    this.markers?.addText(t, values);
  }

  /** Called every animation frame. */
  draw(): void {
    if (!Number.isFinite(this.lastT)) return;
    const since = (performance.now() - this.lastArrival) / 1000;
    const now = this.lastT + Math.min(since, 0.3);
    this.chart?.draw(now, this.view);
    this.rms?.draw(this.lastT);
    this.imu?.draw();
  }

  dispose(): void {
    this.imu?.dispose();
    this.root.remove();
  }
}
