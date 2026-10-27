import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { publishInteraction } from '@itw-conformance-tool/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runnerResultSchema } from '../../runner-api/contract.js';
import { JobManager } from '../../runner-api/job-manager.js';
import { JobStore } from '../../runner-api/job-store.js';

import type { RunnerResult, RunRequest, RunSnapshot } from '../../runner-api/contract.js';
import type { ExecuteContext, ExecuteFn, ExecutionEvidence } from '../../runner-api/job-manager.js';

// JobManager unit tests: injected typed executors are the right seam here.

type Assertion = RunnerResult['native']['assertions'][number];

function request(timeoutMs = 60_000): RunRequest {
  return {
    category: 'presentation',
    contract_version: '1.0',
    parameters: {},
    profile_id: 'test',
    selection: { ids: ['WP_RP_HAPPY'] },
    target: { actor_name: 'wallet', actor_type: 'wallet' },
    timeout_ms: timeoutMs
  };
}

function assertion(id: string, status: Assertion['native_status']): Assertion {
  return {
    ancestor_titles: ['Suite'],
    assertion_id: id,
    file: 'presentation.test.ts',
    full_title: `Suite > [WP_082]: ${id}`,
    native_status: status,
    phase: 'presentation',
    requirement_id: 'WP_082'
  };
}

const ARTIFACT = {
  artifact_id: 'native-results',
  download_url: '/v1/runs/x/artifacts/native-results',
  filename: 'native-results.json',
  mime_type: 'application/json',
  sha256: 'a'.repeat(64),
  size_bytes: 42
};

function evidence(
  ctx: ExecuteContext,
  assertions: Assertion[],
  execution: Partial<RunnerResult['execution']> = {},
  artifacts: RunnerResult['artifacts'] = []
): ExecutionEvidence {
  const failed = assertions.filter((a) => a.native_status === 'FAIL').length;
  return {
    privateArtifacts: [],
    result: {
      artifacts,
      category: 'presentation',
      contract_version: '1.0',
      engine: { fork_repository: 'x', id: 'pagopa-itwct', revision: 'unknown', upstream_repository: 'x', version: 'x' },
      execution: {
        finished_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        status: 'completed',
        ...execution
      },
      limitations: [],
      native: {
        assertions,
        coverage_mode: 'interoperability',
        native_suite_status: failed > 0 ? 'FAILED' : 'PASSED',
        scenario_outcomes: [],
        sessions: []
      },
      profile_id: 'test',
      run_id: ctx.runId,
      selection: { ids: ['WP_RP_HAPPY'] },
      summary: {
        assertion_count: assertions.length,
        native_failed_assertion_count: failed,
        result: failed > 0 ? 'fail' : assertions.length > 0 ? 'pass' : 'not_tested'
      },
      target: { actor_name: 'wallet', actor_type: 'wallet' }
    }
  };
}

/** Resolves once aborted (like the native worker after process cleanup). */
function untilAborted(ctx: ExecuteContext): Promise<void> {
  return new Promise((resolve) => {
    if (ctx.abortSignal.aborted) resolve();
    else ctx.abortSignal.addEventListener('abort', () => resolve(), { once: true });
  });
}

let dir: string;
let managers: JobManager[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itwct-lifecycle-'));
  managers = [];
});

afterEach(async () => {
  await Promise.all(managers.map((m) => m.shutdown().catch(() => undefined)));
  rmSync(dir, { force: true, recursive: true });
});

function manager(execute: ExecuteFn, extra: { abortGraceMs?: number } = {}): JobManager {
  const m = new JobManager({ execute, store: new JobStore(dir), ...extra });
  managers.push(m);
  return m;
}

async function terminal(m: JobManager, runId: string): Promise<RunSnapshot> {
  for (let i = 0; i < 200; i++) {
    const snapshot = await m.getSnapshot(runId);
    if (['cancelled', 'completed', 'error', 'timed_out'].includes(snapshot.status)) return snapshot;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('not terminal');
}

/** Snapshot AND result agree, and the result is a valid wire envelope. */
async function expectAgreement(m: JobManager, runId: string, status: RunSnapshot['status']): Promise<RunnerResult> {
  const snapshot = await m.getSnapshot(runId);
  expect(snapshot.status).toBe(status);
  const result = await m.getResult(runId);
  expect(result.execution.status).toBe(status);
  expect(result.execution.finished_at).toBeTypeOf('string');
  const parsed = runnerResultSchema.safeParse(result);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  return result;
}

describe('JobManager lifecycle truth', () => {
  it('a readable failed suite with nonzero test exit stays completed + fail', async () => {
    const m = manager(async (ctx) =>
      evidence(ctx, [assertion('a1', 'PASS'), assertion('a2', 'FAIL')], { exit_code: 1 })
    );
    const { snapshot } = await m.submit(request(), 'k1');
    await terminal(m, snapshot.run_id);
    const result = await expectAgreement(m, snapshot.run_id, 'completed');
    expect(result.summary.result).toBe('fail');
    expect(result.execution.exit_code).toBe(1);
  });

  it('worker returning execution.status=error yields error in snapshot and result', async () => {
    const m = manager(async (ctx) => evidence(ctx, [], { error: 'native export is missing', status: 'error' }));
    const { snapshot } = await m.submit(request(), 'k2');
    await terminal(m, snapshot.run_id);
    await expectAgreement(m, snapshot.run_id, 'error');
  });

  it('deadline then worker rejects → timed_out in both', async () => {
    const m = manager(async (ctx) => {
      await untilAborted(ctx);
      throw new Error('native child terminated');
    });
    const { snapshot } = await m.submit(request(1_000), 'k3');
    await terminal(m, snapshot.run_id);
    const result = await expectAgreement(m, snapshot.run_id, 'timed_out');
    expect(result.summary.result).toBe('not_tested');
  });

  it('deadline then worker resolves with previous PASS assertions → timed_out, partial, evidence kept', async () => {
    const m = manager(async (ctx) => {
      await untilAborted(ctx);
      return evidence(ctx, [assertion('a1', 'PASS')], { exit_code: 143 }, [ARTIFACT]);
    });
    const { snapshot } = await m.submit(request(1_000), 'k4');
    await terminal(m, snapshot.run_id);
    const result = await expectAgreement(m, snapshot.run_id, 'timed_out');
    expect(result.native.assertions).toHaveLength(1);
    expect(result.artifacts).toEqual([ARTIFACT]);
    expect(result.summary.result).toBe('partial');
  });

  it('cancel with zero assertions returns a readable cancelled envelope (no RESULT_UNAVAILABLE)', async () => {
    const m = manager(async (ctx) => {
      await untilAborted(ctx);
      throw new Error('aborted');
    });
    const { snapshot } = await m.submit(request(), 'k5');
    const cancelled = await m.cancel(snapshot.run_id);
    expect(cancelled.status).toBe('cancelled');
    const result = await expectAgreement(m, snapshot.run_id, 'cancelled');
    expect(result.summary.result).toBe('not_tested');
    // Idempotent cancel.
    expect((await m.cancel(snapshot.run_id)).status).toBe('cancelled');
  });

  it('cancel retains partial assertions/artifacts and reports partial, not pass', async () => {
    const m = manager(async (ctx) => {
      await untilAborted(ctx);
      return evidence(ctx, [assertion('a1', 'PASS')], {}, [ARTIFACT]);
    });
    const { snapshot } = await m.submit(request(), 'k6');
    await m.cancel(snapshot.run_id);
    const result = await expectAgreement(m, snapshot.run_id, 'cancelled');
    expect(result.native.assertions.map((a) => a.assertion_id)).toEqual(['a1']);
    expect(result.artifacts).toEqual([ARTIFACT]);
    expect(result.summary.result).toBe('partial');
  });

  it('shutdown blocks new submissions and finalizes the running job readably', async () => {
    const m = manager(async (ctx) => {
      await untilAborted(ctx);
      return evidence(ctx, [assertion('a1', 'PASS')]);
    });
    const { snapshot } = await m.submit(request(), 'k7');
    const shutdown = m.shutdown();
    await expect(m.submit(request(), 'k7-after')).rejects.toMatchObject({ code: 'RUNNER_SHUTTING_DOWN' });
    await shutdown;
    await m.shutdown(); // idempotent
    const result = await expectAgreement(m, snapshot.run_id, 'cancelled');
    expect(result.limitations.join(' ')).toContain('shutdown');
  });

  it('failed ACK routes through cancellation: cancelled in both, readable result', async () => {
    const m = manager(async (ctx) => {
      publishInteraction(ctx.runRoot, {
        correlationId: 'c1',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        interactionId: 'interaction-1',
        kind: 'wallet_deeplink',
        runId: ctx.runId,
        scenarioId: 'WP_RP_HAPPY',
        uri: 'openid4vp://authorize?request_uri=x'
      });
      await untilAborted(ctx);
      return evidence(ctx, []);
    });
    const { snapshot } = await m.submit(request(), 'k8');
    for (let i = 0; i < 100 && (await m.getSnapshot(snapshot.run_id)).pending_interactions.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const acked = await m.acknowledge(snapshot.run_id, 'interaction-1', { driver_status: 'failed', message: 'x' });
    expect(acked.status).toBe('cancelled');
    const result = await expectAgreement(m, snapshot.run_id, 'cancelled');
    expect(result.summary.result).not.toBe('pass');
  });

  it('a late worker result never overwrites the terminal outcome and keeps the slot until it returns', async () => {
    let release: () => void = () => undefined;
    const released = new Promise<void>((r) => {
      release = r;
    });
    const m = manager(
      async (ctx) => {
        await released; // ignores abort for a while (slow cleanup)
        return evidence(ctx, [assertion('a1', 'PASS')]);
      },
      { abortGraceMs: 200 }
    );
    const { snapshot } = await m.submit(request(), 'k9');
    const cancelled = await m.cancel(snapshot.run_id);
    expect(cancelled.status).toBe('cancelled');
    await expectAgreement(m, snapshot.run_id, 'cancelled');
    await expect(m.submit(request(), 'k9-next')).rejects.toMatchObject({ code: 'RUNNER_BUSY' });
    release();
    for (let i = 0; i < 100; i++) {
      try {
        await m.submit(request(), 'k9-next');
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    const result = await expectAgreement(m, snapshot.run_id, 'cancelled');
    expect(result.summary.result).not.toBe('pass');
  });
});
