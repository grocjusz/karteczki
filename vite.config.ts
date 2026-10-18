import { defineConfig } from 'vitest/config';

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome110', chunkSizeWarningLimit: 800 },
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts'] },
});
