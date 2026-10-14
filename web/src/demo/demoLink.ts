// Demo mode (the public GitHub Pages site): synthetic streams generated in the browser, speaking the
// same protocol as the live server so the whole UI runs unchanged. Never opens a network connection.
//
//   DemoEMG      EMG, 8 ch, 200 Hz   noise whose amplitude bursts every 4 s (two muscle groups)
//   DemoIMU      IMU, 10 ch, 50 Hz   [qw qx qy qz ax ay az gx gy gz], slowly yawing / pitching
//   DemoMarkers  Markers, string     "cue:<n>" every 2 s
//
// Recording works too: takes are cut from the generated samples and downloaded as CSV in the tool's
// format (src/lib/csv.ts).

import { formatRecording, recordingName, safePart, timestampString } from '../lib/csv';
import { TakeSequencer, type TakePlan } from '../lib/takes';
import type { Link, LinkState, PageMsg, RecStatus, ServerMsg, StreamRow } from '../protocol';

const IMU_LABELS = ['qw', 'qx', 'qy', 'qz', 'ax', 'ay', 'az', 'gx', 'gy', 'gz'];
const row = (uid: string, name: string, type: string, labels: string[], srate: number, fmt = 'float32'): StreamRow => ({
  uid, name, type, channels: labels.length, srate, fmt, hostname: 'this-browser', source_id: `demo-${uid}`,
  channel_labels: labels,
});
export const DEMO_STREAMS: StreamRow[] = [
  row('demo-emg', 'DemoEMG', 'EMG', Array.from({ length: 8 }, (_, i) => `emg${i + 1}`), 200),
  row('demo-imu', 'DemoIMU', 'IMU', IMU_LABELS, 50),
  row('demo-markers', 'DemoMarkers', 'Markers', ['marker'], 0, 'string'),
];
const TICK_MS = 33;
const MARKER_PERIOD = 2;

/** Small deterministic PRNG (mulberry32) + Box–Muller, so the demo looks the same on every load. */
function gaussian(seed: number): () => number {
  let a = seed >>> 0;
  const uni = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(uni() || 1e-12)) * Math.cos(2 * Math.PI * uni());
}

export function emgSample(ts: number, noise: () => number): number[] {
  const a = Math.max(0, Math.sin((2 * Math.PI * ts) / 4)) ** 4;        // "flexors": a burst every 4 s
  const b = Math.max(0, Math.sin((2 * Math.PI * ts) / 4 + 2.5)) ** 4;  // "extensors", phase-shifted
  return Array.from({ length: 8 }, (_, c) => noise() * ((c < 4 ? a : b) * 80 + 4));
}

export function imuSample(ts: number): number[] {
  const yaw = 0.8 * Math.sin(0.5 * ts), pitch = 0.4 * Math.sin(0.3 * ts);
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  return [cy * cp, -sy * sp, cy * sp, sy * cp, 0, 0, 9.81, 0, 0.12 * Math.cos(0.3 * ts), 0.4 * Math.cos(0.5 * ts)];
}

interface Track { row: StreamRow; t: number[]; rows: (number | string)[][] }

export class DemoLink implements Link {
  readonly mode = 'demo' as const;
  state: LinkState = 'demo';
  private msgCbs: ((m: ServerMsg) => void)[] = [];
  private subs = new Set<string>();
  private t0 = performance.now() / 1000;
  private n = { emg: 0, imu: 0, mk: 0 };
  private noise = gaussian(7);
  private seq: TakeSequencer | null = null;
  private take: { plan: TakePlan; start: number; stop: number | null; wall: Date; tracks: Map<string, Track> } | null = null;
  status: RecStatus = { type: 'rec_status', state: 'idle' };
  /** Downloaded files (name + text), for tests and the saved list. */
  readonly downloads: { name: string; text: string }[] = [];

  constructor() {
    setTimeout(() => {
      this.emit({ type: 'hello', version: 'demo', data_dir: '(your browser downloads)' });
      this.emit({ type: 'streams', streams: DEMO_STREAMS });
      this.emit(this.status);
    }, 0);
    setInterval(() => this.emit({ type: 'streams', streams: DEMO_STREAMS }), 1000);
    setInterval(() => this.tick(), TICK_MS);
  }

  onMessage(cb: (m: ServerMsg) => void): void { this.msgCbs.push(cb); }
  onState(cb: (s: LinkState) => void): void { cb(this.state); }
  private emit(m: ServerMsg): void { for (const cb of this.msgCbs) cb(m); }

  /** The demo's "LSL clock": seconds since the page loaded, offset like a real local_clock(). */
  clock(): number { return 1000 + performance.now() / 1000 - this.t0; }

  send(m: PageMsg): void {
    if (m.type === 'subscribe') {
      this.subs = new Set(m.uids.filter((u) => DEMO_STREAMS.some((s) => s.uid === u)));
    } else if (m.type === 'record_start') {
      if (this.seq?.running) { this.emit({ type: 'error', message: 'already recording; stop the current take first' }); return; }
      const uids = (m.uids?.length ? m.uids : [...this.subs]).filter((u) => DEMO_STREAMS.some((s) => s.uid === u));
      if (!uids.length) { this.emit({ type: 'error', message: 'nothing to record: subscribe to (tick) at least one stream' }); return; }
      const plan: TakePlan = {
        label: (m.label ?? '').trim(), team: (m.team ?? '').trim(), uids,
        duration: m.duration ? Math.max(0.1, m.duration) : null, countdown: Math.max(0, m.countdown ?? 0),
        repeat: Math.max(1, Math.floor(m.repeat ?? 1)), rest: Math.max(0, m.rest ?? 0),
      };
      this.seq = new TakeSequencer({
        status: (s) => { this.status = s; this.emit(s); },
        begin: () => this.begin(plan),
        end: () => this.end(),
        saved: (files, take, of) => this.emit({ type: 'saved', files, take, of }),
      });
      void this.seq.run(plan);
    } else if (m.type === 'record_stop') {
      this.seq?.stop();
    }
  }

  // ------------------------------------------------------------------ generation
  private tick(): void {
    const now = this.clock() - 1000;
    const out = new Map<string, { t: number[]; rows: (number | string)[][] }>();
    const put = (uid: string, t: number, r: (number | string)[]) => {
      let o = out.get(uid);
      if (!o) out.set(uid, (o = { t: [], rows: [] }));
      o.t.push(1000 + t);
      o.rows.push(r);
    };
    for (; this.n.emg < now * 200; this.n.emg++) put('demo-emg', this.n.emg / 200, emgSample(this.n.emg / 200, this.noise));
    for (; this.n.imu < now * 50; this.n.imu++) put('demo-imu', this.n.imu / 50, imuSample(this.n.imu / 50));
    for (; this.n.mk * MARKER_PERIOD <= now; this.n.mk++) put('demo-markers', this.n.mk * MARKER_PERIOD, [`cue:${this.n.mk + 1}`]);
    for (const [uid, o] of out) {
      this.record(uid, o.t, o.rows);
      if (!this.subs.has(uid)) continue;
      if (uid === 'demo-markers') {
        this.emit({ type: 'markers', uid, t: o.t, values: o.rows.map((r) => String(r[0])) });
      } else {
        const ch = o.rows[0].length;
        this.emit({ type: 'data', uid, t: o.t, x: Array.from({ length: ch }, (_, c) => o.rows.map((r) => r[c] as number)) });
      }
    }
  }

  // ------------------------------------------------------------------ recording (client-side CSV)
  private record(uid: string, t: number[], rows: (number | string)[][]): void {
    const tr = this.take?.tracks.get(uid);
    if (!tr || !this.take) return;
    const hi = this.take.stop ?? Infinity;
    for (let i = 0; i < t.length; i++) {
      if (t[i] >= this.take.start && t[i] < hi) { tr.t.push(t[i]); tr.rows.push(rows[i]); }
    }
  }

  private begin(plan: TakePlan): void {
    const tracks = new Map<string, Track>();
    for (const uid of plan.uids) tracks.set(uid, { row: DEMO_STREAMS.find((s) => s.uid === uid)!, t: [], rows: [] });
    this.take = { plan, start: this.clock(), stop: null, wall: new Date(), tracks };
  }

  private end(): string[] {
    const take = this.take;
    if (!take) return [];
    take.stop = this.clock();
    this.tick(); // pull in everything generated up to the stop time
    this.take = null;
    const team = safePart(take.plan.team, 'unknown'), label = safePart(take.plan.label, 'data');
    const stamp = timestampString(take.wall);
    const multi = take.tracks.size > 1;
    const names: string[] = [];
    for (const [uid, tr] of take.tracks) {
      const text = formatRecording({
        team, label, stamp, srate: tr.row.srate, duration: take.stop - take.start, channels: tr.row.channel_labels,
        stream: tr.row.name, uid, t: tr.t, rows: tr.rows,
      });
      const name = recordingName(label, stamp, tr.row.name, multi);
      this.downloads.push({ name: `${team}/${name}`, text });
      download(name, text);
      names.push(`${team}/${name}`);
    }
    return names;
  }
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
