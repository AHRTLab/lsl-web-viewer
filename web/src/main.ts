// LSL Web Viewer page. Two modes, chosen at load:
//
//   live  served by `lsl-web-viewer` (it injects <meta name="lsl-web-viewer" content="served"> into
//         index.html, lsl_web_viewer/site.py) → WebSocket to ws://<this page's host>/ws.
//         ?ws=ws://host:port/ws overrides the URL explicitly (e.g. while running `npm run dev`).
//   demo  anywhere else (the public GitHub Pages site) → synthetic streams generated in the browser.
//         Demo mode never opens a connection to localhost.

import { DemoLink } from './demo/demoLink';
import { WsLink } from './net/wsLink';
import type { Link, ServerMsg, StreamRow } from './protocol';
import './style.css';
import { el } from './ui/dom';
import { RecordPanel } from './ui/recordPanel';
import { StreamList } from './ui/streamList';
import { StreamPanel } from './views/streamPanel';

const INSTALL_CMD = 'pip install "lsl-web-viewer @ git+https://github.com/AHRTLab/lsl-web-viewer"';

function makeLink(): Link {
  const served = document.querySelector('meta[name="lsl-web-viewer"][content="served"]') !== null;
  const override = new URLSearchParams(location.search).get('ws');
  if (override) return new WsLink(override);
  if (served) return new WsLink(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  return new DemoLink();
}

const link = makeLink();
const app = document.getElementById('app')!;

// ------------------------------------------------------------------ layout
const header = el('header', 'top');
const title = el('div', 'brand');
title.append(el('h1', '', 'LSL Web Viewer'),
  el('span', 'muted', 'live viewer + labeled recorder for Lab Streaming Layer streams'));
const conn = el('span', 'pill', link.mode === 'demo' ? 'demo' : 'connecting…');
conn.id = 'conn';
const info = el('span', 'muted small');
header.append(title, el('div', 'spacer'), info, conn);
app.append(header);

if (link.mode === 'demo') {
  const banner = el('div', 'demo-banner');
  banner.id = 'demo-banner';
  banner.append(el('strong', '', 'Demo data — install lsl-web-viewer to see your own LSL streams: '),
    el('code', '', INSTALL_CMD), el('span', '', ' then run '), el('code', '', 'lsl-web-viewer --open'));
  app.append(banner);
}

const layout = el('div', 'layout');
const side = el('aside', 'sidebar');
const main = el('main', 'panels');
const placeholder = el('div', 'muted empty main-empty', 'Tick a stream on the left to view it.');
main.append(placeholder);
layout.append(side, main);
app.append(layout);

// ------------------------------------------------------------------ state
const panels = new Map<string, StreamPanel>();
let streams: StreamRow[] = [];

const list = new StreamList((uids) => subscribe(uids), link.mode);
const rec = new RecordPanel(link, () => list.selected());
side.append(list.root, rec.root);

function subscribe(uids: string[]): void {
  link.send({ type: 'subscribe', uids });
  const want = new Set(uids);
  for (const [uid, p] of panels) if (!want.has(uid)) { p.dispose(); panels.delete(uid); }
  for (const uid of uids) {
    if (panels.has(uid)) continue;
    const row = streams.find((s) => s.uid === uid);
    if (!row) continue;
    const p = new StreamPanel(row);
    panels.set(uid, p);
  }
  // keep panels in stream-list order
  main.replaceChildren(...(panels.size ? streams.filter((s) => panels.has(s.uid)).map((s) => panels.get(s.uid)!.root) : [placeholder]));
}

link.onState((s) => {
  if (link.mode === 'demo') return;
  conn.textContent = s === 'open' ? 'connected' : s === 'connecting' ? 'connecting…' : 'disconnected — retrying';
  conn.className = `pill ${s}`;
  if (s === 'open') link.send({ type: 'subscribe', uids: list.selected() });  // re-subscribe after reconnects
});

link.onMessage((m: ServerMsg) => {
  switch (m.type) {
    case 'hello':
      info.textContent = link.mode === 'demo' ? 'demo · recordings download as CSV' : `v${m.version}`;
      rec.setFolder(m.data_dir);
      break;
    case 'folder':
      rec.setFolder(m.data_dir);
      break;
    case 'streams':
      streams = m.streams;
      list.update(m.streams);
      break;
    case 'data':
      panels.get(m.uid)?.onData(m.t, m.x);
      break;
    case 'markers':
      panels.get(m.uid)?.onMarkers(m.t, m.values);
      break;
    case 'rec_status':
      rec.setStatus(m);
      break;
    case 'saved':
      rec.addSaved(m.files, link.mode === 'demo');
      break;
    case 'error':
      rec.error(m.message, !!m.no_dialog);
      break;
  }
});

function frame(): void {
  for (const p of panels.values()) p.draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ------------------------------------------------------------------ test / console hook
declare global {
  interface Window { __viewer: unknown }
}
window.__viewer = {
  mode: link.mode,
  link,
  get state() { return link.state; },
  streams: () => streams,
  subscribed: () => [...panels.keys()],
  received: (uid: string) => panels.get(uid)?.received ?? 0,
  panel: (uid: string) => panels.get(uid),
  recStatus: () => rec.status,
  saved: () => rec.saved,
};
