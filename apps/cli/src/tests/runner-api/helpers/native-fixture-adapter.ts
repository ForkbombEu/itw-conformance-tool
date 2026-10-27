import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import type { ProcessAdapter, SpawnOptions } from '../../../runner-api/native-worker.js';

export const repoRoot = resolve(import.meta.dirname, '../../../../../..');
const conformanceRoot = join(repoRoot, 'packages/conformance');
const vitestBin = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');

export interface RecordedLaunch {
  args: string[];
  command: string;
  options: SpawnOptions;
}

/**
 * Low-level subprocess seam for runner tests: records the production launch
 * (command/argv/env/cwd) and runs a REAL Vitest child with the real
 * ConformanceReporter on a protocol-free/controlled fixture instead of the
 * full CLI + local services. The worker's env passes through unchanged.
 */
export function nativeFixtureAdapter(
  fixtureConfig: string,
  extraEnv: Record<string, string> = {}
): { adapter: ProcessAdapter; launches: RecordedLaunch[] } {
  const launches: RecordedLaunch[] = [];
  return {
    adapter: {
      spawn(command, args, options) {
        launches.push({ args, command, options });
        const env: NodeJS.ProcessEnv = { ...options.env, ...extraEnv };
        for (const key of ['VITEST', 'VITEST_POOL_ID', 'VITEST_WORKER_ID']) delete env[key];
        return spawn(process.execPath, [vitestBin, 'run', '--config', join(conformanceRoot, fixtureConfig)], {
          ...options,
          cwd: conformanceRoot,
          env
        });
      }
    },
    launches
  };
}

export const CHANNEL_FIXTURE_CONFIG = 'src/runner/__fixtures__/channel-session.config.mts';
export const REPORTER_FIXTURE_CONFIG = 'src/report/__fixtures__/reporter-runtime.config.mts';
