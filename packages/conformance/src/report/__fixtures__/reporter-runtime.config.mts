import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

import { ConformanceReporter } from '../reporter.js';

// Runs the protocol-free reporter fixture with the REAL ConformanceReporter.
// The fixture lives outside the package and matrix include patterns.
const packageRoot = resolve(import.meta.dirname, '../../..');

export default defineConfig(() => ({
  root: packageRoot,
  cacheDir: resolve(packageRoot, '../../node_modules/.vite/packages/conformance-reporter-fixture'),
  resolve: {
    alias: {
      '@itw-conformance-tool/database': resolve(packageRoot, '../../packages/database/src/index.ts')
    }
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/report/__fixtures__/reporter-runtime.fixture.ts'],
    pool: 'forks',
    forks: { execArgv: ['--experimental-sqlite'] },
    reporters: [new ConformanceReporter('presentation')],
    watch: false
  }
}));
