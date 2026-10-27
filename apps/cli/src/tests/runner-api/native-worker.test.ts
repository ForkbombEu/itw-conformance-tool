import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { nativeAssertionSchema } from '../../runner-api/contract.js';
import { createNativeExecutor } from '../../runner-api/native-worker.js';
import { createOperatorFixture, loadedProfile, type OperatorFixture } from './helpers/operator-fixture.js';

import type { RunnerResult, RunRequest } from '../../runner-api/contract.js';
import type { ProcessAdapter, SpawnOptions, SpawnedProcess } from '../../runner-api/native-worker.js';
import type { LoadedProfile } from '../../runner-api/profiles.js';

let fixture: OperatorFixture;
const fixtureRoot = mkdtempSync(join(tmpdir(), 'wct-nw-operator-'));

beforeAll(async () => {
  fixture = await createOperatorFixture(fixtureRoot);
});

afterAll(() => {
  rmSync(fixtureRoot, { force: true, recursive: true });
});

function makeProfile(): LoadedProfile {
  return loadedProfile(fixture, { id: 'test-profile' });
}

function makeRequest(): RunRequest {
  return {
    category: 'presentation',
    contract_version: '1.0',
    parameters: {},
    profile_id: 'test-profile',
    selection: { ids: ['WP_RP_HAPPY'] },
    target: { actor_name: 'test', actor_type: 'wallet' },
    timeout_ms: 600_000
  };
}

/** Records spawn arguments and exits without running anything (no real pid). */
function makeFakeAdapter(exitCode = 0) {
  const spawns: { args: string[]; command: string; options: SpawnOptions }[] = [];
  const adapter: ProcessAdapter = {
    spawn(command, args, opts) {
      spawns.push({ args, command, options: opts });
      const listeners: Record<string, ((...a: unknown[]) => void)[]> = { error: [], exit: [] };
      const handle: SpawnedProcess = {
        kill: () => true,
        on(event: string, listener: (...a: never[]) => void) {
          listeners[event]?.push(listener as (...a: unknown[]) => void);
        },
        pid: undefined,
        stderr: null,
        stdout: null
      };
      setTimeout(() => {
        for (const fn of listeners.exit ?? []) fn(exitCode);
      }, 10);
      return handle;
    }
  };
  return { adapter, spawns };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wct-nw-'));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe('native-worker — args/env/cwd', () => {
  it('spawns with correct env and cwd', async () => {
    const { adapter, spawns } = makeFakeAdapter();
    const execute = createNativeExecutor({ processAdapter: adapter, profile: makeProfile() });
    await execute({ abortSignal: new AbortController().signal, request: makeRequest(), runId: 'run-1', runRoot: dir });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.options.cwd).toBe(dir);
    expect(spawns[0]?.options.shell).toBe(false);
    expect(spawns[0]?.options.detached).toBe(true);
    const env = spawns[0]?.options.env ?? {};
    expect(env.ITWCT_RUN_ID).toBe('run-1');
    expect(env.ITWCT_PRESENTATION_SCENARIO_IDS).toBe('WP_RP_HAPPY');
  });
});

describe('native-worker — selection rejection', () => {
  it('rejects unpermitted selection before spawn', async () => {
    const { adapter, spawns } = makeFakeAdapter();
    const request = { ...makeRequest(), selection: { ids: ['EVIL'] } };
    const execute = createNativeExecutor({ processAdapter: adapter, profile: makeProfile() });
    await expect(
      execute({ abortSignal: new AbortController().signal, request, runId: 'run-1', runRoot: dir })
    ).rejects.toThrow(/not allowed/);
    expect(spawns).toHaveLength(0);
  });
});

/** Writes a producer-format export as an earlier/other execution would have left it. */
function writeProducerExport(root: string, overrides: Record<string, unknown> = {}): void {
  mkdirSync(join(root, 'results'), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(root, 'results', 'native-results.json'),
    JSON.stringify({
      assertions: [
        {
          ancestor_titles: ['Suite'],
          file: 'test.ts',
          full_title: 'Suite > [WP_082]: test',
          native_status: 'PASS',
          phase: 'presentation',
          requirement_id: 'WP_082'
        }
      ],
      closedAt: now,
      phase: 'presentation',
      run_id: 'run-1',
      session_id: 'session-1',
      startedAt: now,
      status: 'PASSED',
      ...overrides
    })
  );
}

async function executeWith(exportOverrides: Record<string, unknown> | undefined, exitCode = 0) {
  const { adapter } = makeFakeAdapter(exitCode);
  if (exportOverrides) writeProducerExport(dir, exportOverrides);
  const execute = createNativeExecutor({ processAdapter: adapter, profile: makeProfile() });
  return execute({ abortSignal: new AbortController().signal, request: makeRequest(), runId: 'run-1', runRoot: dir });
}

describe('native-worker — export validation through the actual worker', () => {
  it('missing export = error, never pass', async () => {
    const evidence = await executeWith(undefined, 1);
    expect(evidence.result.execution.status).toBe('error');
    expect(evidence.result.summary.result).toBe('not_tested');
  });

  it('valid producer export is adapted with assertion_id and raw', async () => {
    const evidence = await executeWith({});
    expect(evidence.result.execution.status).toBe('completed');
    expect(evidence.result.native.assertions[0]?.assertion_id).toBe('a0001');
    expect(JSON.parse(evidence.result.native.assertions[0]?.raw ?? '{}').requirement_id).toBe('WP_082');
    expect(evidence.result.summary.result).toBe('pass');
  });

  it('export from another run (OLD-RUN) is rejected, not accepted into this run', async () => {
    const evidence = await executeWith({ run_id: 'OLD-RUN' });
    expect(evidence.result.execution.status).toBe('error');
    expect(evidence.result.execution.error).toContain("run_id 'OLD-RUN' does not match expected 'run-1'");
    expect(evidence.result.native.assertions).toEqual([]);
    expect(evidence.result.summary.result).not.toBe('pass');
  });

  it('invalid camelCase nativeStatus FAIL is rejected and never becomes pass', async () => {
    const evidence = await executeWith({
      assertions: [
        { ancestorTitles: [], file: 'test.ts', fullTitle: 'WP_082: test', nativeStatus: 'FAIL', phase: 'presentation' }
      ]
    });
    expect(evidence.result.execution.status).toBe('error');
    expect(evidence.result.summary.result).not.toBe('pass');
    expect(evidence.result.limitations.join(' ')).toContain('producer format');
  });

  it('unknown native status is rejected', async () => {
    const evidence = await executeWith({ status: 'MAYBE' });
    expect(evidence.result.execution.status).toBe('error');
  });

  it('stale export that started before this execution is rejected', async () => {
    const stale = new Date(Date.now() - 60_000).toISOString();
    const evidence = await executeWith({ closedAt: stale, startedAt: stale });
    expect(evidence.result.execution.status).toBe('error');
    expect(evidence.result.execution.error).toContain('before this execution started');
  });

  it('wrong phase (issuance export for a presentation run) is rejected', async () => {
    const evidence = await executeWith({ phase: 'issuance' });
    expect(evidence.result.execution.status).toBe('error');
  });

  it('zero assertions = not_tested', async () => {
    const evidence = await executeWith({ assertions: [], status: 'INCOMPLETE' });
    expect(evidence.result.execution.status).toBe('completed');
    expect(evidence.result.summary.result).toBe('not_tested');
  });
});

// ---------------------------------------------------------------------------
// Real native reporter: the low-level process boundary runs a REAL Vitest
// child with the real ConformanceReporter (protocol-free fixture) instead of
// the CLI. The worker's env (run ID, results dir, data dir, config path) is
// passed through unchanged, and the worker reads the bytes the reporter wrote.
// ---------------------------------------------------------------------------

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const conformanceRoot = join(repoRoot, 'packages/conformance');
const reporterFixtureConfig = join(conformanceRoot, 'src/report/__fixtures__/reporter-runtime.config.mts');
const vitestBin = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');

function realReporterAdapter(mode: string): { adapter: ProcessAdapter; envSeen: NodeJS.ProcessEnv[] } {
  const envSeen: NodeJS.ProcessEnv[] = [];
  const adapter: ProcessAdapter = {
    spawn(_command, _args, options) {
      envSeen.push(options.env);
      const env: NodeJS.ProcessEnv = { ...options.env, ITWCT_REPORTER_FIXTURE_MODE: mode };
      for (const key of ['VITEST', 'VITEST_POOL_ID', 'VITEST_WORKER_ID']) delete env[key];
      return spawn(process.execPath, [vitestBin, 'run', '--config', reporterFixtureConfig], {
        ...options,
        cwd: conformanceRoot,
        env
      });
    }
  };
  return { adapter, envSeen };
}

describe('native-worker — real ConformanceReporter child', () => {
  it('a deliberate native FAIL flows through the actual adapter as completed + fail', async () => {
    const profile = makeProfile();
    const configPath = profile.configPath;
    const { adapter, envSeen } = realReporterAdapter('mixed');
    const execute = createNativeExecutor({ processAdapter: adapter, profile });
    const runRoot = join(dir, 'run');
    mkdirSync(runRoot);

    const evidence = await execute({
      abortSignal: new AbortController().signal,
      request: makeRequest(),
      runId: 'run-real-1',
      runRoot
    });

    expect(envSeen[0]?.ITWCT_RUN_ID).toBe('run-real-1');
    expect(envSeen[0]?.ITWCT_CONFIG_PATH).toBe(configPath);
    const result = evidence.result;
    expect(result.execution.status, JSON.stringify(result.limitations)).toBe('completed');
    expect(result.execution.exit_code).not.toBe(0);
    expect(result.summary.result).toBe('fail');
    expect(result.summary.assertion_count).toBe(3);
    expect(result.summary.native_failed_assertion_count).toBe(1);
    expect(result.native.assertions.map((a) => a.assertion_id)).toEqual(['a0001', 'a0002', 'a0003']);
    expect(result.native.assertions.map((a) => a.requirement_id)).toEqual(['WP_082', 'WP_082', undefined]);
    expect(result.native.native_suite_status).toBe('FAILED');
    expect(result.native.sessions[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.engine.revision).toBe('unknown');
    expect(result.limitations.some((l) => l.includes('engine.revision is unknown'))).toBe(true);
    expect(evidence.privateArtifacts[0]).toEqual({
      artifactId: 'native-results',
      filename: 'native-results.json',
      mimeType: 'application/json',
      path: join(runRoot, 'results', 'native-results.json')
    });
    expect(result.artifacts).toEqual([]);
    expect(nativeAssertionsAreWireValid(result)).toBe(true);
  }, 60_000);

  it('a hook error yields a nonpass result through the actual worker', async () => {
    const { adapter } = realReporterAdapter('hook-error');
    const execute = createNativeExecutor({ processAdapter: adapter, profile: makeProfile() });
    const runRoot = join(dir, 'run');
    mkdirSync(runRoot);
    const evidence = await execute({
      abortSignal: new AbortController().signal,
      request: makeRequest(),
      runId: 'run-real-2',
      runRoot
    });
    expect(evidence.result.summary.result).not.toBe('pass');
    expect(evidence.result.limitations.join(' ')).toContain('deliberate beforeAll failure');
  }, 60_000);
});

describe('native-worker — errors outside test bodies never publish pass (review finding 2)', () => {
  for (const [mode, message] of [
    ['afterall-error', 'deliberate afterAll failure'],
    ['unhandled', 'deliberate unhandled rejection']
  ] as const) {
    it(`${mode}: all executed tests PASS, but the result is not pass`, async () => {
      const { adapter } = realReporterAdapter(mode);
      const execute = createNativeExecutor({ processAdapter: adapter, profile: makeProfile() });
      const runRoot = join(dir, 'run');
      mkdirSync(runRoot);
      const evidence = await execute({
        abortSignal: new AbortController().signal,
        request: makeRequest(),
        runId: `run-${mode}`,
        runRoot
      });
      const result = evidence.result;
      expect(result.native.native_suite_status).toBe('INCOMPLETE');
      expect(result.native.assertions.length).toBeGreaterThan(0);
      expect(result.native.assertions.every((a) => a.native_status === 'PASS')).toBe(true);
      expect(result.summary.result).not.toBe('pass');
      expect(result.summary.result).toBe('partial');
      expect(result.limitations.join(' ')).toContain(message);
    }, 60_000);
  }
});

function nativeAssertionsAreWireValid(result: RunnerResult): boolean {
  return result.native.assertions.every((assertion) => nativeAssertionSchema.safeParse(assertion).success);
}
