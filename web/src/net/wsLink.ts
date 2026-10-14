// Live link to `lsl-web-viewer` over ws://<page host>/ws (same origin, so Safari connects too).
// Reconnects with backoff (0.5 → 5 s); on reconnect the page re-sends its subscription (main.ts listens
// for the 'open' state). Chrome logs each refused attempt to the console while the tool is down.

import type { Link, LinkState, PageMsg, ServerMsg } from '../protocol';

export class WsLink implements Link {
  readonly mode = 'live' as const;
  state: LinkState = 'connecting';
  private ws: WebSocket | null = null;
  private backoff = 500;
  private msgCbs: ((m: ServerMsg) => void)[] = [];
  private stateCbs: ((s: LinkState) => void)[] = [];

  constructor(readonly url: string) {
    this.connect();
  }

  onMessage(cb: (m: ServerMsg) => void): void { this.msgCbs.push(cb); }
  onState(cb: (s: LinkState) => void): void { this.stateCbs.push(cb); }

  private setState(s: LinkState): void {
    this.state = s;
    for (const cb of this.stateCbs) cb(s);
  }

  private connect(): void {
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.setState('closed');
      return;
    }
    this.ws = ws;
    ws.onopen = () => { this.backoff = 500; this.setState('open'); };
    ws.onmessage = (ev) => {
      let m: ServerMsg;
      try { m = JSON.parse(ev.data as string) as ServerMsg; } catch { return; }
      for (const cb of this.msgCbs) cb(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setState('closed');
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(5000, this.backoff * 2);
    };
  }

  send(m: PageMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }
}
