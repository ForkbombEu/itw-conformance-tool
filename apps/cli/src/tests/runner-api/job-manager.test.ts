import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobManager } from '../../runner-api/job-manager.js';
import { JobStore } from '../../runner-api/job-store.js';

import type { RunRequest, RunnerResult } from '../../runner-api/contract.js';
import type { ExecuteFn } from '../../runner-api/job-manager.js';

function makeRequest(): RunRequest {
  return {
    category: 'presentation',
    contract_version: '1.0',
    parameters: {},
    profile_id: 'test',
    selection: { ids: ['WP_RP_HAPPY'] },
    target: { actor_name: 'x', actor_type: 'wallet' },
    timeout_ms: 600_000
  };
}

function makeResult(): RunnerResult {
  return {
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
    target: { actor_name: 'x', actor_type: 'wallet' }
  };
}

function makeFakeExecute(): ExecuteFn {
  return vi.fn().mockResolvedValue({
    privateArtifacts: [],
    result: makeResult()
  }) as unknown as ExecuteFn;
}

function makeSlowExecute(delayMs: number): ExecuteFn {
  return vi.fn().mockImplementation(
    (ctx: { abortSignal: AbortSignal }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ privateArtifacts: [], result: makeResult() }), delayMs);
        ctx.abortSignal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      })
  ) as unknown as ExecuteFn;
}

let dir: string;
let store: JobStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wct-mgr-'));
  store = new JobStore(dir);
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe('JobManager — submit lifecycle', () => {
  it('submits and completes', async () => {
    const execute = makeFakeExecute();
    const mgr = new JobManager({ execute, store });
    const { replayed, snapshot } = await mgr.submit(makeRequest(), 'key-1');
    expect(replayed).toBe(false);
    expect(snapshot.run_id).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    await mgr.shutdown();
  });

  it('duplicate starts execute once', async () => {
    const execute = makeFakeExecute();
    const mgr = new JobManager({ execute, store });
    const [a, b] = await Promise.all([mgr.submit(makeRequest(), 'key-1'), mgr.submit(makeRequest(), 'key-1')]);
    const replayedCount = [a, b].filter((r) => r.replayed).length;
    expect(replayedCount).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    await mgr.shutdown();
  });

  it('same key + different body → conflict', async () => {
    const execute = makeFakeExecute();
    const mgr = new JobManager({ execute, store });
    await mgr.submit(makeRequest(), 'key-1');
    const different = { ...makeRequest(), profile_id: 'other' };
    await expect(mgr.submit(different, 'key-1')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await mgr.shutdown();
  });

  it('different key while busy → RUNNER_BUSY', async () => {
    const execute = makeSlowExecute(100);
    const mgr = new JobManager({ execute, store });
    await mgr.submit(makeRequest(), 'key-1');
    await expect(mgr.submit(makeRequest(), 'key-2')).rejects.toMatchObject({ code: 'RUNNER_BUSY' });
    await mgr.shutdown();
  });

  it('replay while busy works', async () => {
    const execute = makeSlowExecute(100);
    const mgr = new JobManager({ execute, store });
    const first = await mgr.submit(makeRequest(), 'key-1');
    const second = await mgr.submit(makeRequest(), 'key-1');
    expect(second.replayed).toBe(true);
    expect(second.snapshot.run_id).toBe(first.snapshot.run_id);
    await mgr.shutdown();
  });
});

describe('JobManager — cancel', () => {
  it('cancel-before-execute settles to cancelled', async () => {
    const execute = makeSlowExecute(10_000);
    const mgr = new JobManager({ execute, store });
    const { snapshot } = await mgr.submit(makeRequest(), 'key-1');
    const cancelled = await mgr.cancel(snapshot.run_id);
    expect(cancelled.status).toBe('cancelled');
    await mgr.shutdown();
  });

  it('cancel is idempotent', async () => {
    const execute = makeSlowExecute(10_000);
    const mgr = new JobManager({ execute, store });
    const { snapshot } = await mgr.submit(makeRequest(), 'key-1');
    await mgr.cancel(snapshot.run_id);
    const again = await mgr.cancel(snapshot.run_id);
    expect(again.status).toBe('cancelled');
    await mgr.shutdown();
  });

  it('cancelByKey before run throws NOT_FOUND', async () => {
    const execute = makeFakeExecute();
    const mgr = new JobManager({ execute, store });
    await expect(mgr.cancelByKey('nonexistent')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(execute).not.toHaveBeenCalled();
    await mgr.shutdown();
  });

  it('cancelByKey cancels existing run', async () => {
    const execute = makeSlowExecute(10_000);
    const mgr = new JobManager({ execute, store });
    await mgr.submit(makeRequest(), 'my-key');
    await new Promise((r) => setTimeout(r, 10));
    const cancelled = await mgr.cancelByKey('my-key');
    expect(cancelled.status).toBe('cancelled');
    await mgr.shutdown();
  });
});

describe('JobManager — persistence', () => {
  it('run survives restart and replays', async () => {
    const execute = makeFakeExecute();
    const mgr1 = new JobManager({ execute, store });
    const { snapshot } = await mgr1.submit(makeRequest(), 'persist-key');
    await new Promise((r) => setTimeout(r, 50));
    await mgr1.shutdown();

    const execute2 = makeFakeExecute();
    const mgr2 = new JobManager({ execute: execute2, store });
    const replay = await mgr2.submit(makeRequest(), 'persist-key');
    expect(replay.replayed).toBe(true);
    expect(replay.snapshot.run_id).toBe(snapshot.run_id);
    expect(execute2).not.toHaveBeenCalled();
    await mgr2.shutdown();
  });

  it('idempotency recovery: crash between record and index', async () => {
    const execute = makeFakeExecute();
    const mgr1 = new JobManager({ execute, store });
    await mgr1.submit(makeRequest(), 'crash-key');
    await new Promise((r) => setTimeout(r, 50));
    await mgr1.shutdown();

    // Simulate crash: delete index
    const { rmSync } = await import('node:fs');
    const keyHash = JobStore.keyHash('default', 'crash-key');
    rmSync(join(dir, 'index', `${keyHash}.json`), { force: true });

    const execute2 = makeFakeExecute();
    const mgr2 = new JobManager({ execute: execute2, store });
    const replay = await mgr2.submit(makeRequest(), 'crash-key');
    expect(replay.replayed).toBe(true);
    expect(execute2).not.toHaveBeenCalled();
    await mgr2.shutdown();
  });
});

describe('JobManager — root lock', () => {
  it('second store is denied while the first owns the lock; manager shutdown never releases it', async () => {
    const mgr1 = new JobManager({ execute: makeFakeExecute(), store });
    expect(store.acquireRootLock()).toBe(true);

    // A second owner cannot acquire the lock while the first holds it
    expect(new JobStore(dir).acquireRootLock()).toBe(false);

    // Lock ownership belongs to the server composition, not the manager.
    await mgr1.shutdown();
    expect(store.hasRootLock()).toBe(true);
    expect(store.releaseRootLock()).toBe(true);
    expect(store.hasRootLock()).toBe(false);
  });
});
