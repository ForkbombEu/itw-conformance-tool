import { mkdtempSync, rmSync } from 'node:fs';
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

const TOKEN = 'test-token-12345';

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

function makeFakeExecute(): ExecuteFn {
  return async () => ({
    privateArtifacts: [],
    result: {
      artifacts: [],
      category: 'presentation',
      contract_version: '1.0',
      engine: { fork_repository: 'x', id: 'pagopa-itwct', revision: 'x', upstream_repository: 'x', version: 'x' },
      execution: { started_at: '2026-01-01T00:00:00Z', status: 'completed' },
      limitations: [],
      native: {
        assertions: [],
        coverage_mode: 'interoperability',
        native_suite_status: 'PASSED',
        scenario_outcomes: [],
        sessions: []
      },
      profile_id: 'test',
      run_id: 'run-1',
      selection: { ids: ['WP_RP_HAPPY'] },
      summary: { assertion_count: 0, native_failed_assertion_count: 0, result: 'not_tested' },
      target: { actor_name: 'test', actor_type: 'wallet' }
    } satisfies RunnerResult
  });
}

let dir: string;
let app: ReturnType<typeof createRunnerServer>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wct-srv-'));
  process.env.CREDIMI_RUNNER_TOKEN = TOKEN;
  const store = new JobStore(dir);
  const artifacts = new ArtifactStore(dir);
  const jobManager = new JobManager({ execute: makeFakeExecute(), store });
  app = createRunnerServer({ artifacts, catalogue: stubCatalogue(), engine: TEST_ENGINE, jobManager });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { force: true, recursive: true });
  Reflect.deleteProperty(process.env, 'CREDIMI_RUNNER_TOKEN');
});

function auth(extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...extra };
}

describe('GET /healthz', () => {
  it('returns 200 without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });
});

describe('auth', () => {
  it('rejects missing token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/capabilities' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects wrong token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/capabilities',
      headers: { authorization: 'Bearer wrong' }
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /v1/runs', () => {
  it('requires Idempotency-Key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth(),
      payload: makeRequest()
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates new run with 202', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth({ 'idempotency-key': 'key-1' }),
      payload: makeRequest()
    });
    expect(res.statusCode).toBe(202);
  });

  it('replays with 200', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth({ 'idempotency-key': 'key-1' }),
      payload: makeRequest()
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth({ 'idempotency-key': 'key-1' }),
      payload: makeRequest()
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects malformed body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth({ 'idempotency-key': 'key-1' }),
      payload: 'not json'
    });
    expect([400, 500]).toContain(res.statusCode);
  });
});

describe('GET /v1/runs/:runId', () => {
  it('returns 404 for unknown', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/runs/nonexistent', headers: auth() });
    expect(res.statusCode).toBe(404);
  });
});

describe('artifacts', () => {
  it('returns 400 for traversal', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/run-1/artifacts/${encodeURIComponent('../evil')}`,
      headers: auth()
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for unknown', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/runs/run-1/artifacts/nonexistent', headers: auth() });
    expect(res.statusCode).toBe(404);
  });
});
