// Live mode end to end: the real Python tool + real LSL outlets → the page it serves → a timed take on disk.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const PYTHON = process.env.PYTHON || join(REPO, '.venv/bin/python');

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });
}

function start(args: string[]): ChildProcess {
  const p = spawn(PYTHON, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout?.on('data', () => {});
  p.stderr?.on('data', (d) => { if (process.env.DEBUG_E2E) process.stderr.write(d); });
  return p;
}

async function waitHttp(url: string, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} did not come up`);
}

test.describe('served by lsl-web-viewer', () => {
  let tool: ChildProcess, outlets: ChildProcess, port: number, dataDir: string;
  const prefix = `E2E${Math.random().toString(36).slice(2, 7)}`;

  test.beforeAll(async () => {
    port = await freePort();
    dataDir = mkdtempSync(join(tmpdir(), 'lsl-web-viewer-e2e-'));
    outlets = start(['-m', 'lsl_web_viewer.fake', '--prefix', prefix, '--seconds', '120']);
    tool = start(['-m', 'lsl_web_viewer', '--port', String(port), '--host', '127.0.0.1', '--data-dir', dataDir]);
    await waitHttp(`http://127.0.0.1:${port}/`);
  });

  test.afterAll(() => {
    tool?.kill('SIGINT');
    outlets?.kill('SIGINT');
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('discover, subscribe, view, record a timed take', async ({ page, errors }) => {
    void errors;
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => (window as any).__viewer?.state === 'open');
    expect(await page.evaluate(() => (window as any).__viewer.mode)).toBe('live');
    await expect(page.locator('#demo-banner')).toHaveCount(0);

    // streams appear in the table (discovery runs once a second)
    for (const s of ['EMG', 'IMU', 'Markers']) {
      await expect(page.getByRole('checkbox', { name: `subscribe to ${prefix}${s}` })).toBeVisible({ timeout: 20_000 });
    }
    const uid = (name: string) => page.evaluate((n) => (window as any).__viewer.streams().find((s: any) => s.name === n).uid, name);
    const [emg, imu, mk] = [await uid(`${prefix}EMG`), await uid(`${prefix}IMU`), await uid(`${prefix}Markers`)];
    const row = await page.evaluate((u) => (window as any).__viewer.streams().find((s: any) => s.uid === u), emg);
    expect(row).toMatchObject({ type: 'EMG', channels: 8, srate: 200, channel_labels: ['emg1', 'emg2', 'emg3', 'emg4', 'emg5', 'emg6', 'emg7', 'emg8'] });

    for (const s of ['EMG', 'IMU', 'Markers']) await page.getByRole('checkbox', { name: `subscribe to ${prefix}${s}` }).check();
    await page.waitForFunction((u) => (window as any).__viewer.received(u) > 300, emg, { timeout: 20_000 });
    await page.waitForFunction((u) => (window as any).__viewer.received(u) > 50, imu, { timeout: 20_000 });
    await page.waitForFunction((u) => (window as any).__viewer.received(u) >= 1, mk, { timeout: 20_000 });
    await page.waitForFunction((u) => (window as any).__viewer.panel(u).imu.frames > 2, imu, { timeout: 20_000 });
    await expect(page.locator(`.stream-panel[data-uid="${emg}"] canvas.rms`)).toBeVisible();
    await expect(page.locator(`.stream-panel[data-uid="${mk}"] .marker-log li`).first()).toContainText('cue:');

    // typing "r" into a field must not start a recording (shortcut is ignored while typing)
    await page.fill('#rec-team', 'e2e team');
    await page.fill('#rec-label', '');
    await page.locator('#rec-label').pressSequentially('grip r');
    expect(await page.evaluate(() => (window as any).__viewer.recStatus().state)).toBe('idle');

    await page.check('#rec-timed');
    await page.fill('#rec-duration', '1.5');
    await page.fill('#rec-countdown', '1');
    await page.fill('#rec-repeat', '1');
    await page.click('#rec-btn');
    await expect(page.locator('#rec-status')).toHaveAttribute('data-state', 'countdown');
    await expect(page.locator('#rec-status')).toHaveAttribute('data-state', 'recording', { timeout: 5_000 });
    await page.waitForFunction(() => (window as any).__viewer.saved().length === 3, null, { timeout: 20_000 });
    await expect(page.locator('#rec-status')).toHaveAttribute('data-state', 'done');
    await expect(page.locator('#saved-files li')).toHaveCount(3);
    await expect(page.locator('.chips .chip', { hasText: 'grip r' })).toBeVisible();
    await page.screenshot({ path: 'test-results/live.png', fullPage: true });

    const files: string[] = await page.evaluate(() => (window as any).__viewer.saved());
    for (const f of files) {
      expect(f.startsWith(join(dataDir, 'e2e_team'))).toBe(true);
      expect(existsSync(f)).toBe(true);
    }
    const emgFile = files.find((f) => f.endsWith(`_${prefix}EMG.csv`))!;
    expect(emgFile).toMatch(/grip_r_\d{8}_\d{6}_E2E\w+EMG\.csv$/);
    const text = readFileSync(emgFile, 'utf8');
    expect(text).toContain('# team: e2e_team\n# label: grip_r\n');
    expect(text).toContain('# channels: emg1,emg2,emg3,emg4,emg5,emg6,emg7,emg8\n');
    const samples = Number(/# samples: (\d+)/.exec(text)![1]);
    expect(samples).toBeGreaterThan(300 * 0.9);   // 1.5 s × 200 Hz
    expect(samples).toBeLessThan(300 * 1.1);
  });
});
