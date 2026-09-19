import { defineConfig } from 'vitest/config';
// Integration files start local servers, SQLite stores and CLI child processes.
// Bound concurrency so host I/O pressure does not starve their protocol deadlines.
export default defineConfig({ test: { include: ['packages/*/src/**/*.test.ts', 'apps/studio/src/**/*.test.ts', 'scripts/**/*.test.mjs'], maxWorkers: 4, testTimeout: 30_000, hookTimeout: 30_000 } });
