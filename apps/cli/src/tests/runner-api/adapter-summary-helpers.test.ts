import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ArtifactStore } from '../../runner-api/artifacts.js';
import { JobManager, type ExecuteFn } from '../../runner-api/job-manager.js';
import { JobStore } from '../../runner-api/job-store.js';
import { createRunnerServer } from '../../runner-api/server.js';
import { summarizeResult } from '../../runner-api/summarize.js';
import { stubCatalogue, TEST_ENGINE } from './helpers/operator-fixture.js';

import type { RunRequest, RunnerResult } from '../../runner-api/contract.js';

const TOKEN = 'composition-token';

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

function makeProducerExport(overrides: Record<string, unknown> = {}) {
  return {
    assertions: [
      {
        ancestor_titles: [],
        file: 'test.ts',
        full_title: 'WP_082: failing assertion',
        native_status: 'FAIL',
        phase: 'presentation',
        requirement_id: 'WP_082',
        vitest_status: 'failed'
      }
    ],
    closedAt: '2026-01-01T00:00:02Z',
    phase: 'presentation',
    run_id: 'run-1',
    session_id: 'session-1',
    startedAt: '2026-01-01T00:00:00Z',
    status: 'FAILED',
    ...overrides
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wct-compose-'));
  process.env.CREDIMI_RUNNER_TOKEN = TOKEN;
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
  Reflect.deleteProperty(process.env, 'CREDIMI_RUNNER_TOKEN');
});

describe('Helper-level adapter/summarizer checks (NOT production composition; see production-composition.test.ts)', () => {
  it('failed assertion stays fail through full chain', async () => {
    const resultsDir = join(dir, 'results');
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, 'native-results.json'), JSON.stringify(makeProducerExport()));

    const summary = summarizeResult(
      { started_at: '2026-01-01T00:00:00Z', status: 'completed' },
      {
        assertions: [
          {
            ancestor_titles: [],
            assertion_id: 'a1',
            file: 'test.ts',
            full_title: 'WP_082: failing',
            native_status: 'FAIL',
            phase: 'presentation'
          }
        ],
        coverage_mode: 'interoperability',
        native_suite_status: 'FAILED',
        scenario_outcomes: [],
        sessions: []
      }
    );
    expect(summary.result).toBe('fail');
    expect(summary.native_failed_assertion_count).toBe(1);
  });

  it('INCONCLUSIVE stays inconclusive', () => {
    const summary = summarizeResult(
      { started_at: '2026-01-01T00:00:00Z', status: 'completed' },
      {
        assertions: [
          {
            ancestor_titles: [],
            assertion_id: 'a1',
            file: 'test.ts',
            full_title: 'WP_082: t',
            native_status: 'FAIL',
            phase: 'presentation'
          }
        ],
        coverage_mode: 'interoperability',
        native_suite_status: 'INCONCLUSIVE',
        scenario_outcomes: [{ scenario_id: 'WP_RP_HAPPY', verdict: 'INCONCLUSIVE' }],
        sessions: []
      }
    );
    expect(summary.result).toBe('inconclusive');
  });

  it('zero assertions = not_tested', () => {
    const summary = summarizeResult(
      { started_at: '2026-01-01T00:00:00Z', status: 'completed' },
      {
        assertions: [],
        coverage_mode: 'interoperability',
        native_suite_status: 'PASSED',
        scenario_outcomes: [],
        sessions: []
      }
    );
    expect(summary.result).toBe('not_tested');
  });

  it('stale export rejected', async () => {
    const { validateAndAdaptNativeExport } = await import('../../runner-api/native-result-adapter.js');
    try {
      validateAndAdaptNativeExport(makeProducerExport({ run_id: 'OLD' }), {
        expectedPhase: 'presentation',
        expectedRunId: 'NEW'
      });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('RUN_ID_MISMATCH');
    }
  });
});
