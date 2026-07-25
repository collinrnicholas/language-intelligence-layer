import { crx } from '@crxjs/vite-plugin';
import { resolve } from 'path';
import { defineConfig } from 'vite';
import baseManifest from './manifest.json' assert { type: 'json' };

// Stamp a build timestamp into version_name on EVERY build, so the loaded build
// is identifiable in chrome://extensions and the popup footer — no more "did the
// reload actually take?". Numeric `version` stays the release semver (bump it by
// hand for store releases); version_name carries the channel label + build time.
const buildStamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
const manifest = {
  ...baseManifest,
  version_name: `${baseManifest.version_name} · build ${buildStamp} UTC`,
};

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        offscreen: resolve(__dirname, 'offscreen/index.html'),
      },
    },
  },
});
