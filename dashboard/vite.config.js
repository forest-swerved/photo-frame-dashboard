import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// The wall tablet runs Android WebView 106 — keep JS output within Chromium 106.
// CSS targets chrome61 on purpose: the tablet's WebView rejects 4/8-digit hex colours (#0000,
// #ffffffbf) even though Chrome 106 should support them, and a newer target lets the minifier
// rewrite transparent/rgba() into that form. Verified on-device with CSS.supports().
export default defineConfig({
  build: {
    target: 'chrome106',
    cssTarget: 'chrome61',
    rolldownOptions: {
      input: {
        demo: fileURLToPath(new URL('./index.html', import.meta.url)),
        family: fileURLToPath(new URL('./family.html', import.meta.url)),
      },
    },
  },
  server: { host: true },
});
