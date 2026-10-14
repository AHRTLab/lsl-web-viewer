// Recording CSV, byte-for-byte the format lsl_web_viewer/recorder.py writes (which in turn matches the
// BioRadio data-collection GUI), so demo-mode downloads load with the same `load_recording()`.
// Header lines end in \n; the CSV rows end in \r\n (Python's csv.writer default). Numbers are printed
// like Python's repr(float): 1 → "1.0", 1e-7 → "1e-07".

export interface RecordingFile {
  team: string;
  label: string;
  stamp: string;          // YYYYmmdd_HHMMSS (wall clock at the take's start)
  srate: number;
  duration: number;       // seconds
  channels: string[];
  stream: string;
  uid: string;
  t: number[];
  rows: (number | string)[][];   // one row per sample, values in channel order
}

export function pyFloat(v: number): string {
  if (Number.isNaN(v)) return 'nan';
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
  if (v === 0) return Object.is(v, -0) ? '-0.0' : '0.0';
  // Both languages print the shortest round-trip digits; they differ only in when they switch to
  // scientific notation (Python: exponent < -4 or >= 16) and in how they write the exponent.
  const [mant, ex] = v.toExponential().split('e');
  const exp = Number(ex);
  if (exp < -4 || exp >= 16) return `${mant}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  const s = String(v);
  return Number.isInteger(v) ? `${s}.0` : s;
}

/** Python's csv.writer quoting (QUOTE_MINIMAL) for one field. */
function field(v: number | string): string {
  if (typeof v === 'number') return pyFloat(v);
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** filename-safe team / label (spaces → _), mirroring recorder.safe_part */
export function safePart(text: string, fallback: string): string {
  const s = (text ?? '').trim() || fallback;
  const out = s.replace(/ /g, '_').replace(/[^\w.\-+=@]/g, '_').replace(/^\.+|\.+$/g, '');
  return out || fallback;
}

export function timestampString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function formatRecording(r: RecordingFile): string {
  const head = [
    `# team: ${r.team}`,
    `# label: ${r.label}`,
    `# timestamp: ${r.stamp}`,
    `# sample_rate: ${pyFloat(r.srate)}`,
    `# samples: ${r.t.length}`,
    `# duration_sec: ${r.duration.toFixed(3)}`,
    `# channels: ${r.channels.join(',')}`,
    `# stream: ${r.stream}`,
    `# lsl_uid: ${r.uid}`,
    '#',
  ].join('\n') + '\n';
  const lines = [['timestamp', ...r.channels].map(field).join(',')];
  for (let i = 0; i < r.t.length; i++) lines.push([pyFloat(r.t[i]), ...r.rows[i].map(field)].join(','));
  return head + lines.join('\r\n') + '\r\n';
}

/** Mirrors recorder.write_take naming: <label>_<stamp>.csv, or …_<stream>.csv for multi-stream takes. */
export function recordingName(label: string, stamp: string, stream: string, multi: boolean): string {
  return `${label}_${stamp}${multi ? `_${safePart(stream, 'stream')}` : ''}.csv`;
}
