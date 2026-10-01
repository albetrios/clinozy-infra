import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Mirror clinozy-be's bare-prefix alias approach (no plugin): `@setup/foo.js` → `src/foo.ts`.
const root = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      '@setup': resolve(root, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
