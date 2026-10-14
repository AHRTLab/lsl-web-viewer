// Marker / low-rate streams: the latest value in large type, plus a scrolling log (newest on top).

import { el, fmtValue } from '../ui/dom';

const MAX_LOG = 200;

export class MarkerView {
  readonly root: HTMLDivElement;
  private value: HTMLDivElement;
  private log: HTMLOListElement;
  count = 0;

  constructor(private labels: string[]) {
    this.root = el('div', 'markers');
    this.value = el('div', 'marker-value', '–');
    this.log = el('ol', 'marker-log');
    this.root.append(this.value, this.log);
  }

  /** Text values (marker streams). */
  addText(t: number[], values: string[]): void {
    for (let i = 0; i < values.length; i++) this.add(t[i], values[i]);
  }

  /** Numeric samples (low-rate streams), channel-major like the data message. */
  addNumbers(t: number[], x: (number | null)[][]): void {
    for (let i = 0; i < t.length; i++) {
      const parts = x.map((c, ch) => `${this.labels[ch] ?? `ch${ch + 1}`} ${fmtValue(c[i] ?? NaN)}`);
      this.add(t[i], parts.join('  '));
    }
  }

  private add(t: number, text: string): void {
    this.count++;
    this.value.textContent = text;
    const li = el('li');
    li.append(el('span', 'marker-t', t.toFixed(3)), el('span', 'marker-text', text));
    this.log.prepend(li);
    while (this.log.childElementCount > MAX_LOG) this.log.lastElementChild?.remove();
  }
}
