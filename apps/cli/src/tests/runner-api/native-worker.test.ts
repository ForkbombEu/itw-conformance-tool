import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNativeExecutor } from '../../runner-api/native-worker.js';

import type { RunRequest } from '../../runner-api/contract.js';
import type { ProcessAdapter, SpawnOptions, SpawnedProcess } from '../../runner-api/native-worker.js';
import type { Profile } from '../../runner-api/profiles.js';

function makeProfile(): Profile {
  return {
    allowedScenarioIds: ['WP_RP_HAPPY'],
    category: 'presentation',
    configPath: '/abs/config.ini',
    coverageMode: 'interoperability',
    id: 'test-profile'
  };
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

function makeFakeAdapter(exitCode = 0) {
  const spawns: { args: string[]; command: string; options: SpawnOptions }[] = [];
  const adapter: ProcessAdapter = {
    spawn(command, args, opts) {
      spawns.push({ args, command, options: opts });
      const listeners: Record<string, ((...a: unknown[]) => void)[]> = { error: [], exit: [] };
      const handle: SpawnedProcess = {
        kill: () => true,
        on(event, listener) {
          listeners[event]?.push(listener as (...a: unknown[]) => void);
        },
        pid: 12345
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
    const execute = createNativeExecutor({ processAdapter: adapter, profile: makeProfile(), request: makeRequest() });
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
    const execute = createNativeExecutor({ processAdapter: adapter, profile: makeProfile(), request });
    await expect(
      execute({ abortSignal: new AbortController().signal, request, runId: 'run-1', runRoot: dir })
    ).rejects.toThrow(/not allowed/);
    expect(spawns).toHaveLength(0);
  });
});

describe('native-worker — export handling', () => {
  it('nonzero with export = completed with assertions', async () => {
    mkdirSync(join(dir, 'results'), { recursive: true });
    writeFileSync(
      join(dir, 'results', 'native-results.json'),
      JSON.stringify({
        assertions: [
          {
            ancestor_titles: [],
            file: 'test.ts',
            full_title: 'WP_082: test',
            native_status: 'PASS',
            phase: 'presentation',
            requirement_id: 'WP_082'
          }
        ],
        session_id: 'session-1',
        status: 'PASSED'
      })
    );
    const { adapter } = makeFakeAdapter(1);
    const execute = createNativeExecutor({ processAdapter: adapter, profile: makeProfile(), request: makeRequest() });
    const evidence = await execute({
      abortSignal: new AbortController().signal,
      request: makeRequest(),
      runId: 'run-1',
      runRoot: dir
    });
    expect(evidence.result.execution.status).toBe('completed');
    expect(evidence.result.native.assertions).toHaveLength(1);
    expect(evidence.result.native.sessions[0]?.id).toBe('session-1');
  });

  it('missing export = error', async () => {
    const { adapter } = makeFakeAdapter(1);
    const execute = createNativeExecutor({ processAdapter: adapter, profile: makeProfile(), request: makeRequest() });
    const evidence = await execute({
      abortSignal: new AbortController().signal,
      request: makeRequest(),
      runId: 'run-1',
      runRoot: dir
    });
    expect(evidence.result.execution.status).toBe('error');
  });

  it('zero assertions = not_tested', async () => {
    mkdirSync(join(dir, 'results'), { recursive: true });
    writeFileSync(
      join(dir, 'results', 'native-results.json'),
      JSON.stringify({ assertions: [], session_id: 's1', status: 'PASSED' })
    );
    const { adapter } = makeFakeAdapter(0);
    const execute = createNativeExecutor({ processAdapter: adapter, profile: makeProfile(), request: makeRequest() });
    const evidence = await execute({
      abortSignal: new AbortController().signal,
      request: makeRequest(),
      runId: 'run-1',
      runRoot: dir
    });
    expect(evidence.result.summary.result).toBe('not_tested');
  });
});
