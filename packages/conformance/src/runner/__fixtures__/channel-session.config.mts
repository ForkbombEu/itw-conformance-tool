import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

import { ConformanceReporter } from '../../report/reporter.js';

// Runs the controlled protocol-observed session fixture with the REAL
// ConformanceReporter, as the native presentation child would.
const packageRoot = resolve(import.meta.dirname, '../../..');

export default defineConfig(() => ({
  root: packageRoot,
  cacheDir: resolve(packageRoot, '../../node_modules/.vite/packages/conformance-channel-fixture'),
  resolve: {
    alias: {
      '@itw-conformance-tool/database': resolve(packageRoot, '../../packages/database/src/index.ts')
    }
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/runner/__fixtures__/channel-session.fixture.ts'],
    pool: 'forks',
    forks: { execArgv: ['--experimental-sqlite'] },
    reporters: [new ConformanceReporter('presentation')],
    watch: false
  }
}));
