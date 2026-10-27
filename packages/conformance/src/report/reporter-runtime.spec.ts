import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { ConfigIniTemplate } from '@itw-conformance-tool/config';
import { afterAll, describe, expect, it } from 'vitest';

import { NATIVE_EXPORT_FILENAME, type NativeExport } from './native-export.js';

const require = createRequire(import.meta.url);
const vitestBin = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const packageRoot = resolve(import.meta.dirname, '../..');
const fixtureConfig = resolve(import.meta.dirname, '__fixtures__/reporter-runtime.config.mts');
const workRoot = mkdtempSync(join(tmpdir(), 'itwct-reporter-runtime-'));

afterAll(() => {
  rmSync(workRoot, { force: true, recursive: true });
});

interface FixtureRun {
  exitCode: null | number;
  exportBytes?: Buffer;
  native?: NativeExport;
  output: string;
  resultsDir: string;
}

/** Runs a REAL Vitest child with the real ConformanceReporter and an isolated config/database. */
function runFixture(options: { mode: string; runId?: string; withResultsDir?: boolean }): FixtureRun {
  const dir = mkdtempSync(join(workRoot, `${options.mode}-`));
  const dataDir = join(dir, 'data');
  const resultsDir = join(dir, 'results');
  mkdirSync(dataDir, { recursive: true });
  const configPath = join(dir, 'config.ini');
  writeFileSync(configPath, ConfigIniTemplate, 'utf-8');

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['VITEST', 'VITEST_POOL_ID', 'VITEST_WORKER_ID', 'ITWCT_AUTOMATION_DIR']) delete env[key];
  env.ITWCT_CONFIG_PATH = configPath;
  env.ITWCT_DATA_DIR = dataDir;
  env.ITWCT_REPORTER_FIXTURE_MODE = options.mode;
  delete env.ITWCT_RUN_ID;
  delete env.ITWCT_RESULTS_DIR;
  if (options.runId) env.ITWCT_RUN_ID = options.runId;
  if (options.withResultsDir !== false) env.ITWCT_RESULTS_DIR = resultsDir;

  const child = spawnSync(process.execPath, [vitestBin, 'run', '--config', fixtureConfig], {
    cwd: packageRoot,
    encoding: 'utf-8',
    env,
    timeout: 60_000
  });

  const exportPath = join(resultsDir, NATIVE_EXPORT_FILENAME);
  const run: FixtureRun = { exitCode: child.status, output: `${child.stdout}\n${child.stderr}`, resultsDir };
  if (existsSync(exportPath)) {
    run.exportBytes = readFileSync(exportPath);
    run.native = JSON.parse(run.exportBytes.toString('utf-8')) as NativeExport;
  }
  return run;
}

describe('ConformanceReporter runtime (real Vitest child)', () => {
  const mixed = runFixture({ mode: 'mixed', runId: 'run-reporter-mixed' });

  it('a deliberate failure yields a nonzero child exit and an actual native export', () => {
    expect(mixed.exitCode, mixed.output).not.toBe(0);
    expect(mixed.native, mixed.output).toBeDefined();
    expect(mixed.native?.run_id).toBe('run-reporter-mixed');
    expect(mixed.native?.phase).toBe('presentation');
    expect(mixed.native?.status).toBe('FAILED');
    expect(mixed.native?.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(mixed.native?.closedAt).toBeTypeOf('string');
    expect(Date.parse(mixed.native?.startedAt ?? '')).toBeLessThanOrEqual(Date.parse(mixed.native?.closedAt ?? ''));
  });

  it('captures bracketed/unbracketed IDs, ancestors, file, errors and the generic check', () => {
    const assertions = mixed.native?.assertions ?? [];
    expect(assertions).toHaveLength(3);

    const [bracketed, duplicate, generic] = assertions;
    expect(bracketed?.requirement_id).toBe('WP_082');
    expect(bracketed?.native_status).toBe('PASS');
    expect(bracketed?.ancestor_titles).toEqual(['Fixture presentation phase', 'Scenario group']);
    expect(bracketed?.full_title).toBe(
      'Fixture presentation phase > Scenario group > [WP_082]: bracketed requirement passes'
    );
    expect(bracketed?.file).toBe('src/report/__fixtures__/reporter-runtime.fixture.ts');
    expect(bracketed?.scenario_id).toBe('WP_RP_HAPPY');

    // Duplicate normative ID stays a separate occurrence with its own test ID.
    expect(duplicate?.requirement_id).toBe('WP_082');
    expect(duplicate?.native_status).toBe('FAIL');
    expect(duplicate?.vitest_status).toBe('failed');
    expect(duplicate?.error_message).toContain('deliberate fixture failure');
    expect(duplicate?.test_id).not.toBe(bracketed?.test_id);

    // Generic check: no fabricated requirement ID and no scenario association.
    expect(generic?.requirement_id).toBeUndefined();
    expect(generic?.scenario_id).toBeUndefined();
    expect(generic?.native_status).toBe('PASS');
    expect(generic?.ancestor_titles).toEqual(['Fixture presentation phase']);
  });

  it('a hook error produces a nonpass export with the error recorded', () => {
    const run = runFixture({ mode: 'hook-error', runId: 'run-reporter-hook' });
    expect(run.exitCode, run.output).not.toBe(0);
    expect(run.native, run.output).toBeDefined();
    expect(run.native?.status).not.toBe('PASSED');
    expect(run.native?.assertions.every((assertion) => assertion.native_status !== 'PASS')).toBe(true);
    expect(JSON.stringify(run.native)).toContain('deliberate beforeAll failure');
  });

  it('zero collected assertions produce an INCOMPLETE export, never PASSED', () => {
    const run = runFixture({ mode: 'empty', runId: 'run-reporter-empty' });
    expect(run.exitCode, run.output).not.toBe(0);
    expect(run.native, run.output).toBeDefined();
    expect(run.native?.assertions).toEqual([]);
    expect(run.native?.status).toBe('INCOMPLETE');
    expect(run.native?.errors?.length ?? 0).toBeGreaterThan(0);
  });

  it('without an export context the human path writes no native export', () => {
    const run = runFixture({ mode: 'mixed', withResultsDir: false });
    expect(run.exitCode, run.output).not.toBe(0);
    expect(run.native).toBeUndefined();
  });

  it('an incomplete export context (run ID without results dir) fails visibly', () => {
    const run = runFixture({ mode: 'mixed', runId: 'run-reporter-partial', withResultsDir: false });
    expect(run.exitCode).not.toBe(0);
    expect(run.output).toContain('ITWCT_RUN_ID and ITWCT_RESULTS_DIR must be set together');
    expect(run.native).toBeUndefined();
  });
});
