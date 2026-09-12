import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary'],
      // The target is every line, with no exclusions. Anything that cannot be
      // reached from a test is restructured until it can, rather than being
      // hidden from the report.
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
