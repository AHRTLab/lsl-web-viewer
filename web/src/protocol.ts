// The WebSocket protocol between the page and `lsl-web-viewer` (lsl_web_viewer/server.py; README.md).
// The demo link (src/demo/demoLink.ts) speaks the same messages, so the UI never knows the difference.

export interface StreamRow {
  uid: string;
  name: string;
  type: string;
  channels: number;
  srate: number;          // nominal rate in Hz; 0 = irregular
  fmt: string;            // float32 | double64 | int8..int64 | string
  hostname: string;
  source_id: string;
  channel_labels: string[];
}

export type RecState = 'idle' | 'countdown' | 'recording' | 'saving' | 'rest' | 'done';

export interface RecStatus {
  type: 'rec_status';
  state: RecState;
  label?: string;
  team?: string;
  take?: number;
  of?: number;
  remaining?: number | null;  // seconds left in this phase (null = manual take)
  elapsed?: number;
  duration?: number | null;
  uids?: string[];
  files?: number;
}

export type ServerMsg =
  | { type: 'hello'; version: string; data_dir: string }
  | { type: 'streams'; streams: StreamRow[] }
  | { type: 'data'; uid: string; t: number[]; x: (number | null)[][] }   // x[ch][i] ↔ t[i]
  | { type: 'markers'; uid: string; t: number[]; values: string[] }
  | RecStatus
  | { type: 'saved'; files: string[]; take?: number; of?: number }
  | { type: 'folder'; data_dir: string }                   // the save folder changed (any page's Change…)
  | { type: 'error'; message: string; no_dialog?: boolean };

export interface RecordStart {
  type: 'record_start';
  label: string;
  team: string;
  uids?: string[];
  duration?: number;   // omitted = manual take (until record_stop)
  countdown?: number;
  repeat?: number;
  rest?: number;
}

export type PageMsg =
  | { type: 'subscribe'; uids: string[] }
  | RecordStart
  | { type: 'record_stop' }
  | { type: 'choose_folder' }               // the tool opens the computer's own folder dialog
  | { type: 'set_folder'; path: string };   // typed path, when no dialog is available

export type LinkState = 'connecting' | 'open' | 'closed' | 'demo';

/** Where messages come from: the live WebSocket, or the in-browser demo generator. */
export interface Link {
  readonly mode: 'live' | 'demo';
  state: LinkState;
  onMessage(cb: (m: ServerMsg) => void): void;
  onState(cb: (s: LinkState) => void): void;
  send(m: PageMsg): void;
}

// ---------------------------------------------------------------------------------- stream kinds
export const isMarker = (s: StreamRow): boolean => s.fmt === 'string';
export const isEmg = (s: StreamRow): boolean => !isMarker(s) && (s.type.toUpperCase() === 'EMG' || /emg/i.test(s.name));
export const isImu = (s: StreamRow): boolean =>
  !isMarker(s) && s.channels >= 4 && (s.type.toUpperCase() === 'IMU' || /imu/i.test(s.name));
/** Irregular or slow numeric streams also get a value readout + log next to their chart. */
export const isLowRate = (s: StreamRow): boolean => !isMarker(s) && s.srate < 5;
/** Remembers a stream across restarts of its outlet (the uid changes, these don't). */
export const streamKey = (s: StreamRow): string => `${s.name}|${s.type}|${s.source_id}|${s.hostname}`;
