import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ArtifactStore } from '../../runner-api/artifacts.js';
import { JobManager } from '../../runner-api/job-manager.js';
import { JobStore } from '../../runner-api/job-store.js';
import { createRunnerServer } from '../../runner-api/server.js';
import { stubCatalogue, TEST_ENGINE } from './helpers/operator-fixture.js';

import type { RunRequest, RunnerResult } from '../../runner-api/contract.js';
import type { ExecuteFn } from '../../runner-api/job-manager.js';

const TOKEN = 'acceptance-token';

function makeRequest(): RunRequest {
  return {
    category: 'presentation',
    contract_version: '1.0',
    parameters: {},
    profile_id: 'test',
    selection: { ids: ['WP_RP_HAPPY'] },
    target: { actor_name: 'test', actor_type: 'wallet' },
    timeout_ms: 600_000
  };
}

function makeResult(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    artifacts: [],
    category: 'presentation',
    contract_version: '1.0',
    engine: { fork_repository: 'x', id: 'pagopa-itwct', revision: 'x', upstream_repository: 'x', version: 'x' },
    execution: { started_at: '2026-01-01T00:00:00Z', status: 'completed' },
    limitations: [],
    native: {
      assertions: [
        {
          ancestor_titles: [],
          assertion_id: 'a0001',
          file: 't.ts',
          full_title: 'WP_082: test',
          native_status: 'PASS',
          phase: 'presentation',
          requirement_id: 'WP_082'
        }
      ],
      coverage_mode: 'interoperability',
      native_suite_status: 'PASSED',
      scenario_outcomes: [],
      sessions: [{ id: 'session-1', status: 'PASSED' }]
    },
    profile_id: 'test',
    run_id: 'run-1',
    selection: { ids: ['WP_RP_HAPPY'] },
    summary: { assertion_count: 1, native_failed_assertion_count: 0, result: 'pass' },
    target: { actor_name: 'test', actor_type: 'wallet' },
    ...overrides
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wct-accept-'));
  process.env.CREDIMI_RUNNER_TOKEN = TOKEN;
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
  Reflect.deleteProperty(process.env, 'CREDIMI_RUNNER_TOKEN');
});

describe('Acceptance — full API/job/export integration', () => {
  it('start run → export → artifact → replay', async () => {
    let spawnCount = 0;
    const execute: ExecuteFn = async (ctx) => {
      spawnCount++;
      const resultsDir = join(ctx.runRoot, 'results');
      mkdirSync(resultsDir, { recursive: true });
      writeFileSync(
        join(resultsDir, 'native-results.json'),
        JSON.stringify({
          assertions: [
            {
              ancestor_titles: [],
              assertion_id: 'a0002',
              file: 't.ts',
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
      return { privateArtifacts: [], result: makeResult({ run_id: ctx.runId }) };
    };

    const store = new JobStore(dir);
    const artifacts = new ArtifactStore(dir);
    const jobManager = new JobManager({ execute, store });
    const app = createRunnerServer({ artifacts, catalogue: stubCatalogue(), engine: TEST_ENGINE, jobManager });
    await app.ready();

    // Start run
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'idempotency-key': 'acc-1' },
      payload: makeRequest()
    });
    expect(createRes.statusCode).toBe(202);
    const { run_id } = createRes.json();

    // Wait for completion
    await new Promise((r) => setTimeout(r, 100));

    // Get result
    const resultRes = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run_id}/result`,
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(resultRes.statusCode).toBe(200);
    const result = resultRes.json();
    expect(result.native.coverage_mode).toBe('interoperability');
    expect(result.summary.result).toBe('pass');

    // Replay
    const replayRes = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'idempotency-key': 'acc-1' },
      payload: makeRequest()
    });
    expect(replayRes.statusCode).toBe(200);
    expect(replayRes.json().run_id).toBe(run_id);
    expect(spawnCount).toBe(1);

    await app.close();
  });

  it('failed assertion with PASS scenario = fail result', async () => {
    const execute: ExecuteFn = async (ctx) => {
      const resultsDir = join(ctx.runRoot, 'results');
      mkdirSync(resultsDir, { recursive: true });
      writeFileSync(
        join(resultsDir, 'native-results.json'),
        JSON.stringify({
          assertions: [
            {
              ancestor_titles: [],
              assertion_id: 'a0003',
              file: 't.ts',
              full_title: 'WP_082: test',
              native_status: 'FAIL',
              phase: 'presentation',
              requirement_id: 'WP_082'
            }
          ],
          session_id: 'session-1',
          status: 'FAILED'
        })
      );
      return {
        privateArtifacts: [],
        result: makeResult({
          native: {
            assertions: [
              {
                ancestor_titles: [],
                assertion_id: 'a0004',
                file: 't.ts',
                full_title: 'WP_082: test',
                native_status: 'FAIL',
                phase: 'presentation',
                requirement_id: 'WP_082'
              }
            ],
            coverage_mode: 'interoperability',
            native_suite_status: 'FAILED',
            scenario_outcomes: [{ scenario_id: 'WP_RP_HAPPY', verdict: 'PASS' }],
            sessions: [{ id: 'session-1', status: 'FAILED' }]
          },
          summary: { assertion_count: 1, native_failed_assertion_count: 1, result: 'fail' },
          run_id: ctx.runId
        })
      };
    };

    const store = new JobStore(dir);
    const artifacts = new ArtifactStore(dir);
    const jobManager = new JobManager({ execute, store });
    const app = createRunnerServer({ artifacts, catalogue: stubCatalogue(), engine: TEST_ENGINE, jobManager });
    await app.ready();

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'idempotency-key': 'acc-2' },
      payload: makeRequest()
    });
    const { run_id } = createRes.json();
    await new Promise((r) => setTimeout(r, 100));

    const resultRes = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run_id}/result`,
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    const result = resultRes.json();
    expect(result.execution.status).toBe('completed');
    expect(result.summary.result).toBe('fail');

    await app.close();
  });

  it('missing export = error, not pass', async () => {
    const execute: ExecuteFn = async () => ({
      privateArtifacts: [],
      result: makeResult({
        execution: { error: 'missing export', started_at: '2026-01-01T00:00:00Z', status: 'error' },
        native: {
          assertions: [],
          coverage_mode: 'interoperability',
          native_suite_status: 'ERROR',
          scenario_outcomes: [],
          sessions: []
        },
        summary: { assertion_count: 0, native_failed_assertion_count: 0, result: 'not_tested' }
      })
    });

    const store = new JobStore(dir);
    const artifacts = new ArtifactStore(dir);
    const jobManager = new JobManager({ execute, store });
    const app = createRunnerServer({ artifacts, catalogue: stubCatalogue(), engine: TEST_ENGINE, jobManager });
    await app.ready();

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'idempotency-key': 'acc-3' },
      payload: makeRequest()
    });
    const { run_id } = createRes.json();
    await new Promise((r) => setTimeout(r, 100));

    const resultRes = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run_id}/result`,
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    const result = resultRes.json();
    expect(result.summary.result).not.toBe('pass');

    await app.close();
  });

  it('concurrent same-key starts spawn only one', async () => {
    let spawnCount = 0;
    const execute: ExecuteFn = async () => {
      spawnCount++;
      await new Promise((r) => setTimeout(r, 200));
      return { privateArtifacts: [], result: makeResult() };
    };

    const store = new JobStore(dir);
    const artifacts = new ArtifactStore(dir);
    const jobManager = new JobManager({ execute, store });
    const app = createRunnerServer({ artifacts, catalogue: stubCatalogue(), engine: TEST_ENGINE, jobManager });
    await app.ready();

    const results = await Promise.allSettled([
      app.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'idempotency-key': 'acc-conc'
        },
        payload: makeRequest()
      }),
      app.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'idempotency-key': 'acc-conc'
        },
        payload: makeRequest()
      }),
      app.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'idempotency-key': 'acc-conc'
        },
        payload: makeRequest()
      })
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(spawnCount).toBe(1);

    await app.close();
  });

  it('sentinel private file is not exposed by any route', async () => {
    const secretFile = join(dir, 'secret.txt');
    writeFileSync(secretFile, 'SENTINEL_SECRET_VALUE');
    const artifacts = new ArtifactStore(dir);
    const store = new JobStore(dir);
    const jobManager = new JobManager({
      execute: async () => ({ privateArtifacts: [], result: makeResult() }),
      store
    });
    const app = createRunnerServer({ artifacts, catalogue: stubCatalogue(), engine: TEST_ENGINE, jobManager });
    await app.ready();

    // Try to access the secret file through artifact route
    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/run-1/artifacts/${'secret.txt'}`,
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('SENTINEL_SECRET_VALUE');

    await app.close();
  });
});
