import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Inline (empty) PostCSS config stops Vite walking up to the frontend's
  // postcss.config.js, whose tailwindcss plugin is not a server dependency.
  css: { postcss: {} },
  test: {
    include: ['src/**/*.test.ts'],
    globalSetup: ['src/modules/books/__tests__/setup.global.ts'],
    setupFiles: ['src/modules/books/__tests__/setup.env.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
