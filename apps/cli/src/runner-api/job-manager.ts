import { acknowledgeInteraction, AutomationChannelError, listPendingInteractions } from '@itw-conformance-tool/utils';

import { idempotencyConflict, isTerminalStatus, notFound, resultNotReady, runBusy, RunnerError } from './contract.js';
import { generateRunId, JobStore, type StoredRun } from './job-store.js';

import type { PendingInteraction, RunRequest, RunSnapshot, RunnerResult, RunStatus } from './contract.js';
import type { AckOutcome } from '@itw-conformance-tool/utils';

function channelErrorToRunnerError(error: unknown, interactionId: string): RunnerError {
  if (!(error instanceof AutomationChannelError)) throw error;
  switch (error.code) {
    case 'INTERACTION_NOT_FOUND':
      return new RunnerError('NOT_FOUND', 404, `Interaction '${interactionId}' not found`);
    case 'INTERACTION_EXPIRED':
      return new RunnerError('INTERACTION_EXPIRED', 409, error.message);
    case 'INTERACTION_CLOSED':
      return new RunnerError('INTERACTION_CLOSED', 409, error.message);
    case 'ACK_CONFLICT':
      return new RunnerError('ACK_CONFLICT', 409, error.message);
    default:
      return new RunnerError('INVALID_INTERACTION', 422, error.message);
  }
}

function buildErrorResult(run: StoredRun, error: unknown): RunnerResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    artifacts: [],
    category: run.request.category,
    contract_version: '1.0',
    engine: {
      fork_repository: 'https://github.com/ForkbombEu/itw-conformance-tool',
      id: 'pagopa-itwct',
      revision: 'unknown',
      upstream_repository: 'https://github.com/pagopa/itw-conformance-tool',
      version: 'unknown'
    },
    execution: { error: message, started_at: run.createdAt, status: 'error' },
    limitations: ['Infrastructure error: ' + message],
    native: {
      assertions: [],
      coverage_mode: 'interoperability',
      native_suite_status: 'ERROR',
      scenario_outcomes: [],
      sessions: []
    },
    profile_id: run.request.profile_id,
    run_id: run.runId,
    selection: run.request.selection,
    summary: { assertion_count: 0, native_failed_assertion_count: 0, result: 'not_tested' },
    target: run.request.target
  };
}

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

    // Install deadline timer
    const timeoutMs = run.request.timeout_ms ?? 600_000;
    const deadlineTimer = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      const runRoot = this.store.workDir(run.runId);
      const evidence = await this.execute({
        abortSignal: abortController.signal,
        request: run.request,
        runId: run.runId,
        runRoot
      });

      clearTimeout(deadlineTimer);

      const current = this.store.getRun(run.runId);
      if (current && isTerminalStatus(current.status)) return;
      if (current?.cancelRequested) return;

      this.updateRun(run.runId, (r) => ({ ...r, result: evidence.result, status: 'completed' }));
    } catch (error) {
      clearTimeout(deadlineTimer);

      const current = this.store.getRun(run.runId);
      if (current && isTerminalStatus(current.status)) return;
      if (current?.cancelRequested) return;

      const isTimeout = abortController.signal.aborted;
      const terminalStatus: RunStatus = isTimeout ? 'timed_out' : 'error';
      const errorResult = buildErrorResult(run, error);
      this.updateRun(run.runId, (r) => ({ ...r, result: errorResult, status: terminalStatus }));
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
    if (!run.result) {
      throw new RunnerError('RESULT_UNAVAILABLE', 409, 'Terminal run has no readable result');
    }
    return run.result;
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

  /**
   * Records an external driver ACK in the run's native channel. A failed ACK
   * goes through the same cancellation path as an operator cancel. No ACK is
   * ever a native conformance verdict.
   */
  async acknowledge(runId: string, interactionId: string, ack: AckMessage): Promise<RunSnapshot> {
    const run = this.store.getRun(runId);
    if (!run) throw notFound(runId);
    if (isTerminalStatus(run.status)) {
      throw new RunnerError('RUN_TERMINAL', 409, `Run '${runId}' is already ${run.status}`);
    }

    let outcome: AckOutcome;
    try {
      outcome = acknowledgeInteraction(this.store.workDir(runId), runId, interactionId, {
        driverStatus: ack.driver_status,
        ...(ack.message === undefined ? {} : { message: ack.message })
      });
    } catch (error) {
      throw channelErrorToRunnerError(error, interactionId);
    }

    if (ack.driver_status === 'failed' && outcome === 'accepted') {
      return this.cancel(runId);
    }
    const updated = this.store.getRun(runId);
    return this.toSnapshot(updated ?? run);
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

  /** Reads the live native channel of the run's own workspace; terminal runs have no pending work. */
  private pendingInteractions(run: StoredRun): PendingInteraction[] {
    if (isTerminalStatus(run.status)) return [];
    const { pending } = listPendingInteractions(this.store.workDir(run.runId), run.runId, this.clock());
    return pending.map((interaction) => ({
      correlation_id: interaction.correlationId,
      created_at: interaction.createdAt,
      expires_at: interaction.expiresAt,
      interaction_id: interaction.interactionId,
      kind: interaction.kind,
      scenario_id: interaction.scenarioId,
      uri: interaction.uri
    }));
  }

  private toSnapshot(run: StoredRun): RunSnapshot {
    const pending = this.pendingInteractions(run);
    return {
      cancel_requested: run.cancelRequested,
      contract_version: '1.0',
      created_at: run.createdAt,
      engine: 'pagopa-itwct',
      pending_interactions: pending,
      result_url: `/v1/runs/${run.runId}/result`,
      run_id: run.runId,
      status: run.status === 'running' && pending.length > 0 ? 'waiting_for_interaction' : run.status,
      updated_at: run.updatedAt
    };
  }
}
