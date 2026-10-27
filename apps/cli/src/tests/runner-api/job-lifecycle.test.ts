import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { publishInteraction } from '@itw-conformance-tool/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runnerResultSchema } from '../../runner-api/contract.js';
import { JobManager } from '../../runner-api/job-manager.js';
import { JobStore } from '../../runner-api/job-store.js';

import type { PublicationFailure } from '../../runner-api/artifacts.js';
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

function manager(execute: ExecuteFn, extra: { abortGraceMs?: number } = {}, store = new JobStore(dir)): JobManager {
  const m = new JobManager({ execute, store, ...extra });
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

  it('cancel/deadline recompute keeps an independent FAIL next to an INCONCLUSIVE scenario as fail (review finding 1)', async () => {
    // Adapted assertions carry the producer JSON in `raw`: a generic check has
    // no scenario_id, a scenario matcher names its scenario.
    const generic = { ...assertion('a1', 'FAIL'), raw: JSON.stringify({ full_title: 'generic cleanup' }) };
    const matcher = {
      ...assertion('a2', 'FAIL'),
      raw: JSON.stringify({ full_title: 'matcher', scenario_id: 'WP_RP_HAPPY' })
    };
    for (const [key, cancel] of [
      ['k10-cancel', true],
      ['k10-deadline', false]
    ] as const) {
      const m = manager(async (ctx) => {
        await untilAborted(ctx);
        const e = evidence(ctx, [generic, matcher]);
        e.result.native.scenario_outcomes = [{ scenario_id: 'WP_RP_HAPPY', verdict: 'INCONCLUSIVE' }];
        return e;
      });
      const { snapshot } = await m.submit(request(cancel ? 60_000 : 1_000), key);
      if (cancel) await m.cancel(snapshot.run_id);
      await terminal(m, snapshot.run_id);
      const result = await expectAgreement(m, snapshot.run_id, cancel ? 'cancelled' : 'timed_out');
      expect(result.summary.result, key).toBe('fail');
      expect(result.summary.native_failed_assertion_count).toBe(2);
      await m.shutdown();
    }
  });
});

// UNIT (R17): typed executor/publisher test doubles. The double reports a
// declared artifact that failed its initial publication through the typed
// internal input, WITHOUT pre-downgrading the summary, so the manager's own
// aggregation is what is proven here. Not native integration proof.
const MISSING: PublicationFailure = {
  artifactId: 'native-results',
  filename: 'native-results.json',
  reason: 'missing'
};

function unpublished(e: ExecutionEvidence, failures: PublicationFailure[] = [MISSING]): ExecutionEvidence {
  return { ...e, publicationFailures: failures };
}

describe('JobManager evidence completeness (R17, UNIT)', () => {
  it('completed native PASS + failed publication → inconclusive; native verdicts unchanged', async () => {
    const m = manager(async (ctx) => unpublished(evidence(ctx, [assertion('a1', 'PASS')])));
    const { snapshot } = await m.submit(request(), 'r17-1');
    await terminal(m, snapshot.run_id);
    const result = await expectAgreement(m, snapshot.run_id, 'completed');
    expect(result.summary.result).toBe('inconclusive');
    expect(result.native.assertions.map((a) => a.native_status)).toEqual(['PASS']);
    expect(result.native.native_suite_status).toBe('PASSED');
    expect(result.artifacts).toEqual([]);
    expect(result.limitations.join(' ')).toContain('could not be published');
  });

  it('no publication failure + only a benign limitation keeps a real pass', async () => {
    const m = manager(async (ctx) => {
      const e = evidence(ctx, [assertion('a1', 'PASS')], {}, [ARTIFACT]);
      e.result.limitations = ['engine.revision is unknown: no trusted build/source revision was supplied.'];
      return { ...e, publicationFailures: [] };
    });
    const { snapshot } = await m.submit(request(), 'r17-2');
    await terminal(m, snapshot.run_id);
    const result = await expectAgreement(m, snapshot.run_id, 'completed');
    expect(result.summary.result).toBe('pass');
  });

  it('an unknown worker status recomputes but never restores pass over a failed publication', async () => {
    const m = manager(async (ctx) => unpublished(evidence(ctx, [assertion('a1', 'PASS')], { status: 'weird' })));
    const { snapshot } = await m.submit(request(), 'r17-3');
    await terminal(m, snapshot.run_id);
    const result = await expectAgreement(m, snapshot.run_id, 'error');
    expect(result.summary.result).not.toBe('pass');
    expect(result.limitations.join(' ')).toContain('could not be published');
  });

  it('cancel/deadline with partial PASS assertions stays partial, keeps the published artifact and the limitation', async () => {
    for (const [key, cancel] of [
      ['r17-cancel', true],
      ['r17-deadline', false]
    ] as const) {
      const m = manager(async (ctx) => {
        await untilAborted(ctx);
        return unpublished(evidence(ctx, [assertion('a1', 'PASS')], {}, [ARTIFACT]), [
          { artifactId: 'session-log', filename: 'session.log', reason: 'unreadable' }
        ]);
      });
      const { snapshot } = await m.submit(request(cancel ? 60_000 : 1_000), key);
      if (cancel) await m.cancel(snapshot.run_id);
      await terminal(m, snapshot.run_id);
      const result = await expectAgreement(m, snapshot.run_id, cancel ? 'cancelled' : 'timed_out');
      expect(result.summary.result, key).toBe('partial');
      expect(result.artifacts).toEqual([ARTIFACT]);
      expect(result.limitations.join(' ')).toContain('could not be published');
      await m.shutdown();
    }
  });

  it('a native FAIL with a failed publication stays fail', async () => {
    const m = manager(async (ctx) =>
      unpublished(evidence(ctx, [assertion('a1', 'PASS'), assertion('a2', 'FAIL')], { exit_code: 1 }))
    );
    const { snapshot } = await m.submit(request(), 'r17-5');
    await terminal(m, snapshot.run_id);
    expect((await expectAgreement(m, snapshot.run_id, 'completed')).summary.result).toBe('fail');
  });

  it('the nonpass decision survives a manager restart (recovery) and same-key replay', async () => {
    const m = manager(async (ctx) => unpublished(evidence(ctx, [assertion('a1', 'PASS')])));
    const { snapshot } = await m.submit(request(), 'r17-6');
    await terminal(m, snapshot.run_id);
    const before = await m.getResult(snapshot.run_id);
    await m.shutdown();

    const store = new JobStore(dir);
    expect(store.acquireRootLock()).toBe(true);
    try {
      const reopened = manager(async (ctx) => evidence(ctx, [assertion('a1', 'PASS')]), {}, store);
      expect(reopened.recoverInterruptedRuns().recovered).toEqual([]);
      const replay = await reopened.submit(request(), 'r17-6');
      expect(replay.replayed).toBe(true);
      expect(replay.snapshot.run_id).toBe(snapshot.run_id);
      const after = await reopened.getResult(snapshot.run_id);
      expect(after).toEqual(before);
      expect(after.summary.result).toBe('inconclusive');
    } finally {
      store.releaseRootLock();
    }
  });
});
