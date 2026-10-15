// Record panel: where takes are saved (with Change…), team + label (with recent-label chips),
// Record / Stop, timed-take settings (duration, countdown, repeat, rest), the take status, and the list
// of saved files. The tool writes the files; Change… asks it to open the computer's own folder dialog,
// and if it has none (e.g. headless Linux) a path box appears instead.
// Shortcuts (ignored while typing in a field): R = record / stop, Esc = stop.

import type { Link, RecStatus } from '../protocol';
import { button, el, isTyping, labeled, numberInput, panel, store } from './dom';

const MAX_RECENT = 8;

export class RecordPanel {
  readonly root: HTMLElement;
  private team: HTMLInputElement;
  private label: HTMLInputElement;
  private chips: HTMLDivElement;
  private recBtn: HTMLButtonElement;
  private timed: HTMLInputElement;
  private dur: HTMLInputElement;
  private countdown: HTMLInputElement;
  private repeat: HTMLInputElement;
  private rest: HTMLInputElement;
  private statusEl: HTMLDivElement;
  private big: HTMLDivElement;
  private files: HTMLOListElement;
  private folderPath: HTMLSpanElement;
  private folderBtn: HTMLButtonElement;
  private folderBox: HTMLDivElement;
  private folderInput: HTMLInputElement;
  folder = '';
  private recent: string[];
  status: RecStatus = { type: 'rec_status', state: 'idle' };
  saved: string[] = [];

  constructor(private link: Link, private selected: () => string[]) {
    const { root, body } = panel('Record', 'record');
    this.root = root;
    const s = store.get('record', { team: '', label: '', timed: true, duration: 5, countdown: 3, repeat: 1, rest: 3 });
    this.recent = store.get<string[]>('recent-labels', []);

    this.team = el('input', 'text', undefined, { type: 'text', placeholder: 'team / participant id', id: 'rec-team' });
    this.team.value = s.team;
    this.label = el('input', 'text', undefined, { type: 'text', placeholder: 'label, e.g. fist', id: 'rec-label' });
    this.label.value = s.label;
    this.chips = el('div', 'chips');
    this.recBtn = button('● Record', () => this.toggle(), 'rec');
    this.recBtn.id = 'rec-btn';

    this.timed = el('input', '', undefined, { type: 'checkbox', id: 'rec-timed' });
    this.timed.checked = s.timed;
    this.dur = numberInput(s.duration, 0.1, 86400, 0.5, 'rec-duration');
    this.countdown = numberInput(s.countdown, 0, 60, 1, 'rec-countdown');
    this.repeat = numberInput(s.repeat, 1, 1000, 1, 'rec-repeat');
    this.rest = numberInput(s.rest, 0, 3600, 0.5, 'rec-rest');
    const timedBox = el('div', 'timed');
    timedBox.append(labeled('duration s', this.dur), labeled('countdown s', this.countdown),
      labeled('repeat ×', this.repeat), labeled('rest s', this.rest));
    const timedToggle = el('label', 'check');
    timedToggle.append(this.timed, el('span', '', ' timed takes (otherwise record until Stop)'));
    const syncTimed = () => { timedBox.classList.toggle('disabled', !this.timed.checked); this.persist(); };
    this.timed.addEventListener('change', syncTimed);
    for (const i of [this.team, this.label, this.dur, this.countdown, this.repeat, this.rest]) {
      i.addEventListener('change', () => this.persist());
    }
    this.label.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.toggle(); });

    this.big = el('div', 'rec-big');
    this.statusEl = el('div', 'rec-status muted', 'idle');
    this.statusEl.id = 'rec-status';
    this.files = el('ol', 'saved-files');
    this.files.id = 'saved-files';

    this.folderPath = el('span', 'folder-path', '…');
    this.folderPath.id = 'rec-folder';
    this.folderBtn = button('Change…', () => this.link.send({ type: 'choose_folder' }), 'small');
    this.folderBtn.id = 'rec-folder-btn';
    this.folderBtn.title = 'Pick the folder recordings are saved to (opens your computer\'s folder dialog)';
    const folderRow = el('div', 'folder-row');
    folderRow.append(el('span', 'muted small', 'saving to'), this.folderPath, this.folderBtn);
    this.folderInput = el('input', 'text', undefined, { type: 'text', placeholder: 'full folder path, e.g. ~/Documents/recordings', id: 'rec-folder-input' });
    const useBtn = button('Use', () => this.link.send({ type: 'set_folder', path: this.folderInput.value.trim() }), 'small');
    this.folderInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') useBtn.click(); });
    this.folderBox = el('div', 'folder-box hidden');
    this.folderBox.append(this.folderInput, useBtn);
    if (link.mode === 'demo') this.folderBtn.classList.add('hidden');

    body.append(folderRow, this.folderBox, labeled('team', this.team), labeled('label', this.label), this.chips, timedToggle, timedBox,
      this.recBtn, this.big, this.statusEl, el('div', 'side-title', 'saved'), this.files);
    syncTimed();
    this.renderChips();

    window.addEventListener('keydown', (e) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); this.toggle(); }
      else if (e.key === 'Escape' && this.active()) { e.preventDefault(); this.link.send({ type: 'record_stop' }); }
    });
  }

  private persist(): void {
    store.set('record', {
      team: this.team.value, label: this.label.value, timed: this.timed.checked, duration: Number(this.dur.value),
      countdown: Number(this.countdown.value), repeat: Number(this.repeat.value), rest: Number(this.rest.value),
    });
  }

  private renderChips(): void {
    this.chips.replaceChildren(...this.recent.map((l) => {
      const c = button(l, () => { this.label.value = l; this.persist(); }, 'chip');
      c.title = `use label "${l}"`;
      return c;
    }));
  }

  active(): boolean {
    return ['countdown', 'recording', 'saving', 'rest'].includes(this.status.state);
  }

  toggle(): void {
    if (this.active()) { this.link.send({ type: 'record_stop' }); return; }
    const label = this.label.value.trim();
    if (label) {
      this.recent = [label, ...this.recent.filter((l) => l !== label)].slice(0, MAX_RECENT);
      store.set('recent-labels', this.recent);
      this.renderChips();
    }
    const num = (i: HTMLInputElement, d: number) => (Number.isFinite(Number(i.value)) && i.value !== '' ? Number(i.value) : d);
    this.link.send({
      type: 'record_start', label, team: this.team.value.trim(), uids: this.selected(),
      ...(this.timed.checked ? { duration: num(this.dur, 5), repeat: num(this.repeat, 1), rest: num(this.rest, 0) } : {}),
      countdown: num(this.countdown, 0),
    });
  }

  setStatus(s: RecStatus): void {
    this.status = s;
    const active = this.active();
    this.recBtn.textContent = active ? '■ Stop' : '● Record';
    this.recBtn.classList.toggle('stop', active);
    this.root.classList.toggle('is-recording', s.state === 'recording');
    const takeTxt = s.of && s.of > 1 ? ` · take ${s.take} of ${s.of}` : '';
    const rem = s.remaining == null ? '' : `${Math.ceil(s.remaining)}`;
    switch (s.state) {
      case 'countdown':
        this.big.textContent = rem; this.big.className = 'rec-big countdown';
        this.statusEl.textContent = `get ready: "${s.label}"${takeTxt}`;
        break;
      case 'recording':
        this.big.textContent = s.remaining == null ? `${(s.elapsed ?? 0).toFixed(1)} s` : `${(s.remaining ?? 0).toFixed(1)} s`;
        this.big.className = 'rec-big recording';
        this.statusEl.textContent = `● recording "${s.label}" (${s.team})${takeTxt}`;
        break;
      case 'saving':
        this.statusEl.textContent = `saving${takeTxt}…`;
        break;
      case 'rest':
        this.big.textContent = rem; this.big.className = 'rec-big rest';
        this.statusEl.textContent = `rest${takeTxt}`;
        break;
      case 'done':
        this.big.textContent = ''; this.big.className = 'rec-big';
        this.statusEl.textContent = `done: ${s.files ?? 0} file${s.files === 1 ? '' : 's'} saved`;
        break;
      default:
        this.big.textContent = ''; this.big.className = 'rec-big';
        this.statusEl.textContent = 'idle';
    }
    this.statusEl.dataset.state = s.state;
  }

  addSaved(files: string[], demo: boolean): void {
    for (const f of files) {
      this.saved.push(f);
      const li = el('li');
      const name = f.split(/[\\/]/).slice(-2).join('/');
      li.append(el('span', 'saved-name', name));
      li.title = demo ? `${f} (downloaded by your browser)` : f;
      this.files.prepend(li);
    }
  }

  /** The tool's current save folder (hello / folder messages). */
  setFolder(path: string): void {
    this.folder = path;
    const short = path.replace(/^\/(Users|home)\/[^/]+/, '~');
    this.folderPath.textContent = short.length > 42 ? `…${short.slice(-41)}` : short;
    this.folderPath.title = path;
    this.folderBox.classList.add('hidden');
  }

  error(message: string, noDialog = false): void {
    this.statusEl.textContent = `⚠ ${message}`;
    if (noDialog) {
      this.folderInput.value = this.folder;
      this.folderBox.classList.remove('hidden');
      this.folderInput.focus();
    }
  }
}
