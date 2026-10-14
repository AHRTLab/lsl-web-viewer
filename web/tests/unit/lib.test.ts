import { describe, expect, it, vi } from 'vitest';
import { formatRecording, pyFloat, recordingName, safePart, timestampString } from '../../src/lib/csv';
import { columnEnvelope } from '../../src/lib/decimate';
import { RingBuffer } from '../../src/lib/ringbuffer';
import { PeakHold, rmsWindow } from '../../src/lib/rms';
import { TakeSequencer } from '../../src/lib/takes';
import type { RecStatus } from '../../src/protocol';

function filled(n: number, rate: number, f: (t: number) => number, cap = n): RingBuffer {
  const rb = new RingBuffer(cap, 1);
  const t = Array.from({ length: n }, (_, i) => i / rate);
  rb.push(t, [t.map(f)]);
  return rb;
}

describe('RingBuffer', () => {
  it('keeps the newest samples in order and wraps', () => {
    const rb = new RingBuffer(4, 2);
    rb.push([1, 2, 3], [[10, 20, 30], [-1, -2, -3]]);
    expect(rb.length).toBe(3);
    rb.push([4, 5, 6], [[40, 50, 60], [-4, -5, null]]);
    expect(rb.length).toBe(4);
    expect([0, 1, 2, 3].map((i) => rb.timeAt(i))).toEqual([3, 4, 5, 6]);
    expect([0, 1, 2, 3].map((i) => rb.valueAt(0, i))).toEqual([30, 40, 50, 60]);
    expect(rb.valueAt(1, 3)).toBeNaN();   // null on the wire → NaN
    expect(rb.firstTime).toBe(3);
    expect(rb.lastTime).toBe(6);
  });
  it('lowerBound finds the first sample at or after a time', () => {
    const rb = new RingBuffer(5, 1);
    rb.push([1, 2, 3, 4, 5, 6, 7], [[0, 0, 0, 0, 0, 0, 0]]);  // holds 3..7
    expect(rb.lowerBound(0)).toBe(0);
    expect(rb.lowerBound(4.5)).toBe(2);
    expect(rb.lowerBound(7)).toBe(4);
    expect(rb.lowerBound(99)).toBe(5);
  });
});

describe('columnEnvelope', () => {
  it('reduces a window to one min/max per column and keeps spikes', () => {
    const rb = filled(1000, 1000, (t) => Math.sin(2 * Math.PI * 3 * t));
    rb.x[0][rb.index(500)] = 7;  // one-sample spike
    const env = columnEnvelope(rb, 0, 0, 1, 50);
    expect(env.min.length).toBe(50);
    expect(env.has.every((h) => h === 1)).toBe(true);
    expect(env.hi).toBe(7);
    expect(Math.max(...env.max)).toBe(7);
    expect(env.lo).toBeCloseTo(-1, 3);
  });
  it('only looks inside [t0, t1) and reports empty columns', () => {
    const rb = filled(8, 8, () => 1);   // t = 0, 0.125, … 0.875 (exact in binary)
    const env = columnEnvelope(rb, 0, 0.5, 1.5, 8);
    expect(Array.from(env.has)).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
    const none = columnEnvelope(new RingBuffer(4, 1), 0, 0, 1, 10);
    expect(none.lo).toBeNaN();
  });
});

describe('rms', () => {
  it('matches the RMS of a sine (0.707 A) over the last 200 ms, ignoring DC', () => {
    const rb = filled(2000, 1000, (t) => 5 + 2 * Math.sin(2 * Math.PI * 50 * t));
    expect(rmsWindow(rb, 0, rb.lastTime, 0.2)).toBeCloseTo(2 / Math.SQRT2, 2);
  });
  it('only uses the window', () => {
    const rb = filled(2000, 1000, (t) => (t < 1.5 ? 100 * Math.sin(2 * Math.PI * 50 * t) : 0));
    expect(rmsWindow(rb, 0, rb.lastTime, 0.2)).toBe(0);
    expect(rmsWindow(new RingBuffer(3, 1), 0, 0)).toBeNaN();
  });
  it('peak hold holds, then decays toward the level', () => {
    const p = new PeakHold(1.0, 0.5);
    expect(p.update(10, 0)).toBe(10);
    expect(p.update(2, 0.5)).toBe(10);    // still holding
    const v = p.update(2, 2.0);           // 1 s past the hold → decayed
    expect(v).toBeLessThan(10);
    expect(v).toBeGreaterThan(2);
    expect(p.update(20, 2.1)).toBe(20);   // new peak
  });
});

describe('csv (same format as recorder.py)', () => {
  it('prints numbers like Python repr(float)', () => {
    expect(pyFloat(1)).toBe('1.0');
    expect(pyFloat(200)).toBe('200.0');
    expect(pyFloat(0.1)).toBe('0.1');
    expect(pyFloat(-2.5)).toBe('-2.5');
    expect(pyFloat(0.0001)).toBe('0.0001');
    expect(pyFloat(0.00001)).toBe('1e-05');
    expect(pyFloat(1.5e-7)).toBe('1.5e-07');
    expect(pyFloat(1e16)).toBe('1e+16');
    expect(pyFloat(1234.5678)).toBe('1234.5678');
    expect(pyFloat(0)).toBe('0.0');
  });
  it('formats header + rows', () => {
    const text = formatRecording({
      team: 'team_7', label: 'fist', stamp: '20260301_101500', srate: 200, duration: 0.01, channels: ['a', 'b'],
      stream: 'DemoEMG', uid: 'u-1', t: [1000, 1000.005], rows: [[1, -0.5], [2, 0.25]],
    });
    expect(text).toBe([
      '# team: team_7', '# label: fist', '# timestamp: 20260301_101500', '# sample_rate: 200.0', '# samples: 2',
      '# duration_sec: 0.010', '# channels: a,b', '# stream: DemoEMG', '# lsl_uid: u-1', '#', '',
    ].join('\n') + 'timestamp,a,b\r\n1000.0,1.0,-0.5\r\n1000.005,2.0,0.25\r\n');
    const marker = formatRecording({ team: 't', label: 'l', stamp: 's', srate: 0, duration: 1, channels: ['marker'],
      stream: 'M', uid: 'u', t: [1], rows: [['a,"b"']] });
    expect(marker.endsWith('1.0,"a,""b"""\r\n')).toBe(true);
  });
  it('names files like the server', () => {
    expect(safePart(' team 7 ', 'unknown')).toBe('team_7');
    expect(safePart('', 'unknown')).toBe('unknown');
    expect(recordingName('fist', '20260301_101500', 'DemoEMG', false)).toBe('fist_20260301_101500.csv');
    expect(recordingName('fist', '20260301_101500', 'Demo EMG', true)).toBe('fist_20260301_101500_Demo_EMG.csv');
    expect(timestampString(new Date(2026, 2, 1, 9, 5, 7))).toBe('20260301_090507');
  });
});

describe('TakeSequencer', () => {
  it('runs countdown → recording → rest → recording and saves each take', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const states: RecStatus[] = [];
    const ends: number[] = [];
    const seq = new TakeSequencer({
      status: (s) => states.push(s), begin: () => {}, end: (k) => { ends.push(k); return [`f${k}`]; },
      saved: () => {}, now: () => clock,
    });
    const done = seq.run({ label: 'x', team: '', uids: ['u'], duration: 1, countdown: 0.5, repeat: 2, rest: 0.5 });
    for (let i = 0; i < 60; i++) { clock += 0.1; await vi.advanceTimersByTimeAsync(100); }
    expect(await done).toEqual(['f1', 'f2']);
    expect(ends).toEqual([1, 2]);
    const seen = [...new Set(states.map((s) => s.state))];
    expect(seen).toEqual(['countdown', 'recording', 'rest', 'done']);
    expect(states.at(-1)?.team).toBe('unknown');
    vi.useRealTimers();
  });
  it('stop during recording saves that take and ends the sequence', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const seq = new TakeSequencer({ status: () => {}, begin: () => {}, end: (k) => [`f${k}`], saved: () => {}, now: () => clock });
    const done = seq.run({ label: 'x', team: 't', uids: ['u'], duration: null, countdown: 0, repeat: 5, rest: 0 });
    for (let i = 0; i < 5; i++) { clock += 0.1; await vi.advanceTimersByTimeAsync(100); }
    seq.stop();
    expect(await done).toEqual(['f1']);
    vi.useRealTimers();
  });
});
