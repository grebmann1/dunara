import { defineConfig } from 'vitest/config';
// Integration files start local servers, SQLite stores and CLI child processes.
// Compile template utility tests with the host config; Expo is installed only in generated apps.
// Bound concurrency so host I/O pressure does not starve their protocol deadlines.
export default defineConfig({ tsconfig: 'tsconfig.tests.json', test: { include: ['packages/*/src/**/*.test.ts', 'apps/studio/src/**/*.test.ts', 'scripts/**/*.test.mjs'], maxWorkers: 4, testTimeout: 30_000, hookTimeout: 30_000 } });
