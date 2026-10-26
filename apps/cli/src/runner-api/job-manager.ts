import { idempotencyConflict, isTerminalStatus, notFound, resultNotReady, runBusy, RunnerError } from './contract.js';
import { generateRunId, JobStore, type StoredRun } from './job-store.js';

import type { RunRequest, RunSnapshot, RunnerResult } from './contract.js';

export interface ExecutionEvidence {
  privateArtifactPaths: string[];
  result: RunnerResult;
}

export interface ExecuteContext {
  abortSignal: AbortSignal;
  request: RunRequest;
  runId: string;
  runRoot: string;
}

export type ExecuteFn = (ctx: ExecuteContext) => Promise<ExecutionEvidence>;

export interface AckMessage {
  driver_status: 'completed' | 'failed';
  message?: string;
}

export interface JobManagerDeps {
  clock?: () => Date;
  execute: ExecuteFn;
  newId?: () => string;
  store: JobStore;
}

interface LiveRun {
  abortController: AbortController;
  cleanupPromise: Promise<void>;
  runId: string;
}

export class JobManager {
  private readonly clock: () => Date;
  private readonly execute: ExecuteFn;
  private live: LiveRun | undefined;
  private readonly newId: () => string;
  private readonly store: JobStore;

  constructor(deps: JobManagerDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.execute = deps.execute;
    this.newId = deps.newId ?? generateRunId;
    this.store = deps.store;
    this.store.rebuildIndex();
  }

  async submit(
    request: RunRequest,
    idempotencyKey: string,
    namespace = 'default'
  ): Promise<{ replayed: boolean; snapshot: RunSnapshot }> {
    const keyHash = JobStore.keyHash(namespace, idempotencyKey);
    const requestHash = JobStore.canonicalRequestHash(request);

    const existing = this.store.findByKeyHash(keyHash);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw idempotencyConflict();
      }
      return { replayed: true, snapshot: this.toSnapshot(existing) };
    }

    if (this.live) {
      throw runBusy();
    }

    const now = this.clock().toISOString();
    const runId = this.newId();
    const run: StoredRun = {
      cancelRequested: false,
      createdAt: now,
      idempotencyKeyHash: keyHash,
      namespace,
      request,
      requestHash,
      runId,
      status: 'queued',
      updatedAt: now
    };

    this.store.saveRun(run);

    const abortController = new AbortController();
    let cleanupResolve: () => void;
    const cleanupPromise = new Promise<void>((resolve) => {
      cleanupResolve = resolve;
    });

    this.live = { abortController, cleanupPromise, runId };

    this.runExecution(run, abortController).finally(() => {
      if (this.live?.runId === runId) {
        this.live = undefined;
      }
      cleanupResolve();
    });

    return { replayed: false, snapshot: this.toSnapshot(run) };
  }

  private async runExecution(run: StoredRun, abortController: AbortController): Promise<void> {
    this.updateRun(run.runId, (r) => ({ ...r, status: 'running' }));

    try {
      await this.execute({
        abortSignal: abortController.signal,
        request: run.request,
        runId: run.runId,
        runRoot: this.store.rootDir
      });

      const current = this.store.getRun(run.runId);
      if (current && isTerminalStatus(current.status)) return;
      if (current?.cancelRequested) return;

      this.updateRun(run.runId, (r) => ({ ...r, status: 'completed' }));
    } catch {
      const current = this.store.getRun(run.runId);
      if (current && isTerminalStatus(current.status)) return;
      if (current?.cancelRequested) return;

      this.updateRun(run.runId, (r) => ({ ...r, status: 'error' }));
    }
  }

  async getSnapshot(runId: string): Promise<RunSnapshot> {
    const run = this.store.getRun(runId);
    if (!run) throw notFound(runId);
    return this.toSnapshot(run);
  }

  async getResult(runId: string): Promise<RunnerResult> {
    const run = this.store.getRun(runId);
    if (!run) throw notFound(runId);
    if (!isTerminalStatus(run.status)) throw resultNotReady();
    throw new RunnerError('RESULT_UNAVAILABLE', 409, 'Result not yet available');
  }

  async cancel(runId: string): Promise<RunSnapshot> {
    const run = this.store.getRun(runId);
    if (!run) throw notFound(runId);
    if (isTerminalStatus(run.status)) return this.toSnapshot(run);

    this.updateRun(run.runId, (r) => ({ ...r, cancelRequested: true }));

    if (this.live?.runId === runId) {
      this.live.abortController.abort();
      await this.live.cleanupPromise.catch(() => undefined);
    }

    const updated = this.store.getRun(runId);
    if (updated && !isTerminalStatus(updated.status)) {
      this.updateRun(runId, (r) => ({ ...r, status: 'cancelled' }));
    }

    const final = this.store.getRun(runId);
    if (!final) throw notFound(runId);
    return this.toSnapshot(final);
  }

  async cancelByKey(idempotencyKey: string, namespace = 'default'): Promise<RunSnapshot> {
    const keyHash = JobStore.keyHash(namespace, idempotencyKey);
    const run = this.store.findByKeyHash(keyHash);
    if (!run) throw notFound(idempotencyKey);
    return this.cancel(run.runId);
  }

  async acknowledge(
    runId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _interactionId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _ack: AckMessage
  ): Promise<RunSnapshot> {
    const run = this.store.getRun(runId);
    if (!run) throw notFound(runId);
    return this.toSnapshot(run);
  }

  async shutdown(): Promise<void> {
    if (this.live) {
      this.live.abortController.abort();
      await this.live.cleanupPromise.catch(() => undefined);
      this.live = undefined;
    }
    this.store.releaseRootLock();
  }

  private updateRun(runId: string, updater: (r: StoredRun) => StoredRun): void {
    const run = this.store.getRun(runId);
    if (!run) return;
    const updated = updater({ ...run, updatedAt: this.clock().toISOString() });
    this.store.saveRun(updated);
  }

  private toSnapshot(run: StoredRun): RunSnapshot {
    return {
      cancel_requested: run.cancelRequested,
      contract_version: '1.0',
      created_at: run.createdAt,
      engine: 'pagopa-itwct',
      pending_interactions: [],
      result_url: `/v1/runs/${run.runId}/result`,
      run_id: run.runId,
      status: run.status,
      updated_at: run.updatedAt
    };
  }
}
