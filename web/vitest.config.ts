/**
 * Vitest config. Inherits the path alias + react plugin from vite.config.ts
 * so test imports look identical to runtime imports.
 *
 * `jsdom` so the Notification/localStorage/Element APIs used in our libs are
 * present without per-test polyfills. `globals: true` lets us use `it`,
 * `expect`, `vi` without importing them.
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      globals: true,
      environment: 'happy-dom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      coverage: {
        reporter: ['text', 'html'],
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx'],
      },
    },
  }),
);
