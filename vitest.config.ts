import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
    // The terrain streaming tests wait on real timers, and on Windows a 1 ms
    // timer lasts about 16 ms: under a full parallel run they need more than
    // the default five seconds.
    testTimeout: 20_000,
  },
});
