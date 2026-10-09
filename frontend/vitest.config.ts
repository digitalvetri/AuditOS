import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/** Unit tests for pure helpers (lib/, validators). No DOM, no MSW. */
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
