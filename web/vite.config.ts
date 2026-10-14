/// <reference types="vitest" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Two builds of the same page (it picks live vs demo mode at runtime, see src/main.ts):
//
//   npm run build        → ../lsl_web_viewer/static/  base './'   served by the Python tool (committed)
//   npm run build:demo   → dist-demo/                 base '/lsl-web-viewer/' (or $SITE_BASE), the
//                                                     public GitHub Pages demo (scripts/deploy.sh)
export default defineConfig(({ mode }) => {
  const demo = mode === 'demo';
  return {
    base: demo ? (process.env.SITE_BASE ?? '/lsl-web-viewer/') : './',
    build: {
      target: 'es2022',
      outDir: demo ? 'dist-demo' : fileURLToPath(new URL('../lsl_web_viewer/static', import.meta.url)),
      emptyOutDir: true,
      chunkSizeWarningLimit: 800,
    },
    preview: { host: '127.0.0.1', port: 4180, strictPort: true },
    test: { include: ['tests/unit/**/*.test.ts'] },
  };
});
