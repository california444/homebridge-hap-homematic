// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // One HTML report in coverage/ (the lcov reporter would add a second
      // copy under coverage/lcov-report/ plus lcov.info, which nothing reads).
      reporter: ['text', 'html'],
      include: ['src/**/*.ts', 'homebridge-ui/server/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/**/types.ts', 'src/**/*.d.ts'],
      thresholds: {
        // Lines / statements / functions are the load-bearing coverage signals
        // for "is this code actually exercised?". We hold those at 95.
        // Branches are deliberately lower: the codebase has a number of
        // defensive guards (e.g. `if (!this.ccu) return;` after type-narrowing
        // would otherwise allow the field to be undefined) that are
        // statically unreachable but must remain for type safety, plus
        // initial-pull `.then(...)` chains in many accessories whose body
        // is the same as the corresponding push-event listener — the
        // listener test exercises the apply* function but the v8 coverage
        // provider counts the `.then` body's branches separately.
        // Re-set after the XML-RPC-only cleanup (Phase 2, 2026-11-11):
        // branches at 90 (measured 91.1 %).
        lines: 95,
        statements: 95,
        functions: 95,
        branches: 90,
      },
    },
    pool: 'forks',
    testTimeout: 10000,
  },
});
