// Tiny DOM helpers (same pattern as the AHRT Lab sim pages): build elements in code, style in style.css.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls = '', text?: string, attrs: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

export function panel(title: string, id: string): { root: HTMLElement; body: HTMLDivElement } {
  const root = el('section', 'panel');
  root.id = id;
  root.append(el('h2', 'panel-title', title));
  const body = el('div', 'panel-body');
  root.append(body);
  return { root, body };
}

export function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', `btn ${cls}`.trim(), label, { type: 'button' });
  b.addEventListener('click', onClick);
  return b;
}

export function labeled(text: string, input: HTMLElement, cls = 'field'): HTMLLabelElement {
  const l = el('label', cls);
  l.append(el('span', 'field-label', text), input);
  return l;
}

export function numberInput(value: number, min: number, max: number, step: number, id?: string): HTMLInputElement {
  const i = el('input', 'num', undefined, { type: 'number', min: String(min), max: String(max), step: String(step) });
  i.value = String(value);
  if (id) i.id = id;
  return i;
}

/** True when a key event is aimed at something the user types into (shortcuts must not fire). */
export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

/** localStorage that never throws (private windows, blocked storage). */
export const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(`lsl-web-viewer:${key}`);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch { return fallback; }
  },
  set(key: string, value: unknown): void {
    try { localStorage.setItem(`lsl-web-viewer:${key}`, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

export function fmtRate(srate: number): string {
  return srate > 0 ? `${srate % 1 ? srate.toFixed(2) : srate} Hz` : 'irregular';
}

export function fmtValue(v: number): string {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(2);
  return v.toFixed(a < 1 ? 4 : a < 100 ? 2 : 1);
}
