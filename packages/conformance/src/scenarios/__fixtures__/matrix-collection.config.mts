import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

// Collection-only configuration for the real presentation matrix. It is used
// with `vitest list`, which imports the matrix module and runs describe bodies
// to register tests without executing hooks or test bodies. It deliberately
// omits the ConformanceReporter (which opens the native database).
const packageRoot = resolve(import.meta.dirname, '../../..');

export default defineConfig(() => ({
  root: packageRoot,
  cacheDir: resolve(packageRoot, '../../node_modules/.vite/packages/conformance-collection'),
  resolve: {
    alias: {
      '@itw-conformance-tool/database': resolve(packageRoot, '../../packages/database/src/index.ts')
    }
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/tests/matrix/presentation.test.ts'],
    pool: 'forks',
    forks: { execArgv: ['--experimental-sqlite'] },
    watch: false
  }
}));
