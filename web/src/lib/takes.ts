// Take sequencing for demo mode, the same state machine as ViewerServer._run_takes (server.py):
//
//   for k in 1..repeat:  countdown (if > 0) → recording (duration, or until stop) → save → rest (if more)
//   stop during countdown: abort, nothing saved;  during recording: save that take, stop;  during rest: stop.

import type { RecState, RecStatus } from '../protocol';

export interface TakePlan {
  label: string;
  team: string;
  uids: string[];
  duration: number | null;   // null = manual
  countdown: number;
  repeat: number;
  rest: number;
}

export interface TakeHooks {
  status(s: RecStatus): void;
  begin(k: number): void;
  /** Close take k and write it; returns the file names. */
  end(k: number): string[];
  saved(files: string[], k: number, of: number): void;
  now?: () => number;                   // seconds (default performance.now)
}

const TICK_SEC = 0.1;

export class TakeSequencer {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private resolveWait: (() => void) | null = null;
  running = false;

  constructor(private hooks: TakeHooks) {}

  private now(): number { return this.hooks.now ? this.hooks.now() : performance.now() / 1000; }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.resolveWait?.();
  }

  private sleep(sec: number): Promise<void> {
    return new Promise((res) => {
      this.resolveWait = res;
      this.timer = setTimeout(res, Math.max(0, sec * 1000));
    });
  }

  /** One phase with status ticks. Resolves false if stopped early. */
  private async phase(state: RecState, seconds: number | null, k: number, plan: TakePlan): Promise<boolean> {
    const t0 = this.now();
    for (;;) {
      const elapsed = this.now() - t0;
      const remaining = seconds === null ? null : Math.max(0, seconds - elapsed);
      this.hooks.status({
        type: 'rec_status', state, label: plan.label || 'data', team: plan.team || 'unknown', take: k, of: plan.repeat,
        remaining, elapsed: Math.round(elapsed * 100) / 100, duration: plan.duration, uids: plan.uids,
      });
      if (this.stopped) return false;
      if (remaining !== null && remaining <= 0) return true;
      await this.sleep(remaining === null ? TICK_SEC : Math.min(TICK_SEC, remaining));
      if (this.stopped) return false;
    }
  }

  async run(plan: TakePlan): Promise<string[]> {
    this.running = true;
    this.stopped = false;
    const all: string[] = [];
    const repeat = plan.duration === null ? 1 : Math.max(1, Math.floor(plan.repeat));
    plan = { ...plan, repeat };
    try {
      for (let k = 1; k <= repeat; k++) {
        if (plan.countdown > 0 && !(await this.phase('countdown', plan.countdown, k, plan))) break;
        this.hooks.begin(k);
        const finished = await this.phase('recording', plan.duration, k, plan);
        const files = this.hooks.end(k);
        all.push(...files);
        this.hooks.saved(files, k, repeat);
        if (!finished) break;
        if (k < repeat && plan.rest > 0 && !(await this.phase('rest', plan.rest, k, plan))) break;
      }
    } finally {
      this.running = false;
      this.hooks.status({ type: 'rec_status', state: 'done', label: plan.label || 'data', team: plan.team || 'unknown',
        take: repeat, of: repeat, files: all.length });
    }
    return all;
  }
}
