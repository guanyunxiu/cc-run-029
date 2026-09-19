/// <reference types="vitest" />
import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
  },
  build: { target: 'es2020' },
});
