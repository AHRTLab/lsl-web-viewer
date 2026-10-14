// The auto-discovered stream table. Ticking a stream subscribes to it. Ticks are remembered by stream
// key (name/type/source_id/host, which survive an outlet restart even though the uid changes) in
// localStorage, so a restarted device, or a reload, comes back subscribed.

import { streamKey, type StreamRow } from '../protocol';
import { el, fmtRate, panel, store } from './dom';

export class StreamList {
  readonly root: HTMLElement;
  private table: HTMLTableSectionElement;
  private empty: HTMLDivElement;
  private wanted: Set<string>;
  rows: StreamRow[] = [];

  constructor(private onChange: (uids: string[]) => void, private mode: 'live' | 'demo') {
    const { root, body } = panel('Streams', 'streams');
    this.root = root;
    this.wanted = new Set(store.get<string[]>(`${mode}:subscribed`, mode === 'demo'
      ? ['DemoEMG|EMG|demo-demo-emg|this-browser', 'DemoIMU|IMU|demo-demo-imu|this-browser',
         'DemoMarkers|Markers|demo-demo-markers|this-browser']
      : []));
    this.empty = el('div', 'muted empty', mode === 'demo' ? 'Starting the demo streams…'
      : 'Looking for LSL streams on the network… Start an outlet (a device app, or `python -m lsl_web_viewer.fake`).');
    const t = el('table', 'stream-table');
    const head = el('thead');
    const hr = el('tr');
    for (const h of ['', 'name', 'type', 'ch', 'rate', 'host']) hr.append(el('th', '', h));
    head.append(hr);
    this.table = el('tbody');
    t.append(head, this.table);
    body.append(this.empty, t);
  }

  selected(): string[] {
    return this.rows.filter((r) => this.wanted.has(streamKey(r))).map((r) => r.uid);
  }

  update(rows: StreamRow[]): void {
    const before = this.selected().join(',');
    const sig = (rs: StreamRow[]) => rs.map((r) => r.uid).join(',');
    const changed = sig(rows) !== sig(this.rows);
    this.rows = rows;
    if (changed) this.render();
    this.empty.style.display = rows.length ? 'none' : '';
    if (this.selected().join(',') !== before) this.onChange(this.selected());
  }

  private render(): void {
    this.table.replaceChildren();
    for (const r of this.rows) {
      const tr = el('tr');
      tr.dataset.uid = r.uid;
      const cb = el('input', 'stream-check', undefined, { type: 'checkbox', 'aria-label': `subscribe to ${r.name}` });
      cb.checked = this.wanted.has(streamKey(r));
      cb.addEventListener('change', () => {
        if (cb.checked) this.wanted.add(streamKey(r)); else this.wanted.delete(streamKey(r));
        store.set(`${this.mode}:subscribed`, [...this.wanted]);
        this.onChange(this.selected());
      });
      const name = el('td', 'stream-name', r.name);
      name.title = `uid ${r.uid}\nsource_id ${r.source_id || '(none)'}\nformat ${r.fmt}\nchannels ${r.channel_labels.join(', ')}`;
      const tdc = el('td');
      tdc.append(cb);
      tr.append(tdc, name, el('td', '', r.type), el('td', 'num-cell', String(r.channels)),
        el('td', 'num-cell', fmtRate(r.srate)), el('td', 'muted host', r.hostname));
      this.table.append(tr);
    }
  }
}
