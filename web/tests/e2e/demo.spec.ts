// Demo mode (the public site): synthetic streams in the browser, client-side CSV download, and never a
// connection attempt to the user's machine.
import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures';

const DEMO_URL = 'http://127.0.0.1:4180/lsl-web-viewer/';

test('demo build shows the banner and synthetic data without touching localhost', async ({ page, errors }) => {
  void errors;
  const sockets: string[] = [];
  const local: string[] = [];
  page.on('websocket', (ws) => sockets.push(ws.url()));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) && u.port !== '4180') local.push(r.url());
  });

  await page.goto(DEMO_URL);
  await expect(page.locator('#demo-banner')).toContainText('Demo data — install lsl-web-viewer to see your own LSL streams');
  await expect(page.locator('#demo-banner')).toContainText('pip install');
  expect(await page.evaluate(() => (window as any).__viewer.mode)).toBe('demo');

  // all three demo streams are ticked by default and draw data
  await page.waitForFunction(() => (window as any).__viewer.received('demo-emg') > 300, null, { timeout: 20_000 });
  await page.waitForFunction(() => (window as any).__viewer.received('demo-imu') > 50);
  await page.waitForFunction(() => (window as any).__viewer.received('demo-markers') >= 1);
  await page.waitForFunction(() => (window as any).__viewer.panel('demo-imu').imu.frames > 2, null, { timeout: 20_000 });
  await page.screenshot({ path: 'test-results/demo.png', fullPage: true });

  // a timed take downloads one CSV per stream, in the tool's format
  await page.fill('#rec-team', 'demo team');
  await page.fill('#rec-label', 'wave');
  await page.check('#rec-timed');
  await page.fill('#rec-duration', '1');
  await page.fill('#rec-countdown', '0');
  await page.fill('#rec-repeat', '1');
  const downloads: import('@playwright/test').Download[] = [];
  page.on('download', (d) => downloads.push(d));
  await page.keyboard.press('Escape');  // focus out of the field…
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('r');       // …then the R shortcut records
  await page.waitForFunction(() => (window as any).__viewer.saved().length === 3, null, { timeout: 15_000 });
  await expect.poll(() => downloads.length).toBe(3);
  const emg = downloads.find((d) => /^wave_\d{8}_\d{6}_DemoEMG\.csv$/.test(d.suggestedFilename()))!;
  expect(emg).toBeTruthy();
  const text = readFileSync((await emg.path())!, 'utf8');
  expect(text).toMatch(/^# team: demo_team\n# label: wave\n# timestamp: \d{8}_\d{6}\n# sample_rate: 200\.0\n# samples: \d+\n/);
  expect(text).toContain('# stream: DemoEMG\n# lsl_uid: demo-emg\n#\ntimestamp,emg1,emg2,emg3,emg4,emg5,emg6,emg7,emg8\r\n');
  const samples = Number(/# samples: (\d+)/.exec(text)![1]);
  expect(samples).toBeGreaterThanOrEqual(180);
  expect(samples).toBeLessThanOrEqual(220);
  expect(text.trimEnd().split('\r\n').length - 1).toBe(samples);

  await page.waitForTimeout(1500);
  expect(sockets, 'WebSocket attempts').toEqual([]);
  expect(local, 'requests to localhost').toEqual([]);
});
