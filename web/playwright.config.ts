import { defineConfig, devices } from '@playwright/test';

// End-to-end tests in the installed Google Chrome (headless, software GL via ANGLE SwiftShader so the
// three.js IMU view renders without a GPU). Set PW_CHANNEL= (empty) to use Playwright's own Chromium.
//
//   live.spec.ts  starts `python -m lsl_web_viewer` + synthetic LSL outlets itself (PYTHON=… to pick
//                 the interpreter; default ../.venv/bin/python) and drives the page it serves.
//   demo.spec.ts  the public demo build (npm run build:demo), served by `vite preview` on 127.0.0.1:4180.
//
//   npm run e2e    builds both pages, then runs everything
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { viewport: { width: 1280, height: 900 }, acceptDownloads: true },
  projects: [
    {
      name: 'chrome',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        channel: process.env.PW_CHANNEL ?? 'chrome',
        launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
      },
    },
  ],
  webServer: {
    command: 'npm run preview:demo',
    url: 'http://127.0.0.1:4180/lsl-web-viewer/',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
