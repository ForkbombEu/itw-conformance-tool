import { acknowledgeInteraction, AutomationChannelError, listPendingInteractions } from '@itw-conformance-tool/utils';

import {
  idempotencyConflict,
  isTerminalStatus,
  notFound,
  resultNotReady,
  runBusy,
  RunnerError,
  runnerResultSchema
} from './contract.js';
import { generateRunId, JobStore, type StoredRun } from './job-store.js';
import {
  isRecordedNativeGroupAlive,
  processGroupExists,
  quarantineNativeChildMarker,
  readNativeChildMarker,
  removeNativeChildMarker,
  type NativeChildMarker
} from './native-child-marker.js';
import { applyEvidenceCompleteness, summarizeWithLimitations } from './summarize.js';

import type { PrivateArtifact, PublicationFailure } from './artifacts.js';
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

const MAX_ERROR_LENGTH = 2_000;

/** Why a live run's abort signal fired; set before aborting, never inferred. */
export type AbortReason = 'cancel' | 'deadline' | 'shutdown';

const LIFECYCLE_BY_REASON: Record<AbortReason, RunStatus> = {
  cancel: 'cancelled',
  deadline: 'timed_out',
  shutdown: 'cancelled'
};

const REASON_LIMITATION: Record<AbortReason, string> = {
  cancel: 'Run was cancelled before the native suite finished; only partial evidence is available.',
  deadline: 'Run reached its deadline before the native suite finished; only partial evidence is available.',
  shutdown: 'Run was interrupted by a runner shutdown; only partial evidence is available.'
};

/**
 * The publication boundary: every terminal result must parse with the wire
 * schema. An invalid one is replaced by an honest error envelope that keeps
 * the lifecycle status and names the schema violations.
 */
function publishable(run: StoredRun, result: RunnerResult, finishedAt: string): RunnerResult {
  const parsed = runnerResultSchema.safeParse(result);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  const status = result.execution.status as RunStatus;
  const envelope = buildErrorResult(run, `Worker result failed wire validation: ${issues}`, status, finishedAt);
  return { ...envelope, execution: { ...envelope.execution, status } };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
}

/** Bounded honest envelope when no worker evidence exists (throw, pre-spawn abort, unowned cancel). */
function buildErrorResult(run: StoredRun, reason: string, status: RunStatus, finishedAt: string): RunnerResult {
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
    execution: { error: reason, finished_at: finishedAt, started_at: run.createdAt, status },
    limitations: [reason, 'engine identity unavailable: no worker evidence was produced.'],
    native: {
      assertions: [],
      coverage_mode: 'interoperability',
      native_suite_status: status === 'error' ? 'ERROR' : status.toUpperCase(),
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

/**
 * Forces the lifecycle status onto worker evidence while keeping its raw
 * assertions/artifacts, and recomputes the summary conservatively when the
 * lifecycle differs from what the worker reported. Evidence completeness (a
 * declared artifact that failed initial publication) is a separate input
 * applied last, so no recomputation can turn that decision back into pass.
 */
function withLifecycle(
  result: RunnerResult,
  status: RunStatus,
  finishedAt: string,
  extraLimitations: string[],
  publicationFailures: readonly PublicationFailure[] = []
): RunnerResult {
  const execution = { ...result.execution, finished_at: result.execution.finished_at ?? finishedAt, status };
  const unchanged = result.execution.status === status && extraLimitations.length === 0;
  if (unchanged && publicationFailures.length === 0) return { ...result, execution };
  const recomputed = unchanged
    ? { limitations: [], summary: result.summary }
    : summarizeWithLimitations(execution, result.native);
  const completeness = applyEvidenceCompleteness(recomputed.summary, publicationFailures);
  return {
    ...result,
    execution,
    limitations: [
      ...new Set([...result.limitations, ...extraLimitations, ...recomputed.limitations, ...completeness.limitations])
    ],
    summary: completeness.summary
  };
}

export interface ExecutionEvidence {
  /** Raw evidence files at private paths; the composition publishes them as artifacts. */
  privateArtifacts: PrivateArtifact[];
  /**
   * Declared artifacts whose initial publication failed (typed internal
   * aggregation input, never serialized). Absent means none are known.
   */
  publicationFailures?: readonly PublicationFailure[];
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
  /** How long cancel/shutdown wait for the worker's cleanup before finalizing anyway. */
  abortGraceMs?: number;
  clock?: () => Date;
  execute: ExecuteFn;
  newId?: () => string;
  store: JobStore;
}

interface LiveRun {
  abortController: AbortController;
  abortReason?: AbortReason;
  /** Settles after the worker returned and the run was finalized; the slot stays busy until then. */
  done: Promise<void>;
  runId: string;
}

const TERMINAL_EXECUTION_STATUSES: readonly RunStatus[] = ['cancelled', 'completed', 'error', 'timed_out'];

export class JobManager {
  private readonly abortGraceMs: number;
  private readonly clock: () => Date;
  private readonly execute: ExecuteFn;
  private live: LiveRun | undefined;
  private readonly newId: () => string;
  private shutdownPromise: Promise<void> | undefined;
  private readonly store: JobStore;

  constructor(deps: JobManagerDeps) {
    this.abortGraceMs = deps.abortGraceMs ?? 60_000;
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

    if (this.shutdownPromise) {
      throw new RunnerError('RUNNER_SHUTTING_DOWN', 503, 'Runner is shutting down');
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

    const live: LiveRun = { abortController: new AbortController(), done: Promise.resolve(), runId };
    this.live = live;
    live.done = this.runExecution(run, live)
      .catch(() => undefined)
      .finally(() => {
        if (this.live === live) this.live = undefined;
      });

    return { replayed: false, snapshot: this.toSnapshot(run) };
  }

  private abortLive(live: LiveRun, reason: AbortReason): void {
    live.abortReason ??= reason;
    live.abortController.abort(live.abortReason);
  }

  private async runExecution(run: StoredRun, live: LiveRun): Promise<void> {
    this.updateRun(run.runId, (r) => ({ ...r, status: 'running' }));

    // One owned deadline timer, cleared on every completion path.
    const timeoutMs = run.request.timeout_ms ?? 600_000;
    const deadlineTimer = setTimeout(() => this.abortLive(live, 'deadline'), timeoutMs);

    let evidence: ExecutionEvidence | undefined;
    let failure: unknown;
    try {
      evidence = await this.execute({
        abortSignal: live.abortController.signal,
        request: run.request,
        runId: run.runId,
        runRoot: this.store.workDir(run.runId)
      });
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(deadlineTimer);
    }

    try {
      this.finalize(run.runId, live.abortReason, evidence, failure);
    } catch {
      // Persistence failed: the record keeps its last durable state; restart
      // recovery turns a stranded running record into a terminal one.
    }
  }

  /**
   * Persists the terminal result and status in one record write, so a
   * terminal snapshot is never published without a readable result. A run that
   * is already terminal (e.g. finalized after the abort grace) is never
   * overwritten by a late worker result.
   */
  private finalize(
    runId: string,
    reason: AbortReason | undefined,
    evidence?: ExecutionEvidence,
    failure?: unknown
  ): void {
    const current = this.store.getRun(runId);
    if (!current || isTerminalStatus(current.status)) return;
    const finishedAt = this.clock().toISOString();

    let status: RunStatus;
    let result: RunnerResult;
    if (reason) {
      status = LIFECYCLE_BY_REASON[reason];
      result = evidence
        ? withLifecycle(evidence.result, status, finishedAt, [REASON_LIMITATION[reason]], evidence.publicationFailures)
        : buildErrorResult(
            current,
            failure === undefined ? REASON_LIMITATION[reason] : `${REASON_LIMITATION[reason]} ${errorMessage(failure)}`,
            status,
            finishedAt
          );
    } else if (evidence) {
      const reported = evidence.result.execution.status as RunStatus;
      status = TERMINAL_EXECUTION_STATUSES.includes(reported) ? reported : 'error';
      result = withLifecycle(
        evidence.result,
        status,
        finishedAt,
        status === reported ? [] : [`Unknown worker execution status '${reported}' treated as error.`],
        evidence.publicationFailures
      );
    } else {
      status = 'error';
      result = buildErrorResult(current, `Infrastructure error: ${errorMessage(failure)}`, status, finishedAt);
    }

    this.store.saveRun({ ...current, result: publishable(current, result, finishedAt), status, updatedAt: finishedAt });
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
    const parsed = runnerResultSchema.safeParse(run.result);
    if (!parsed.success) {
      throw new RunnerError('RESULT_INVALID', 500, 'Stored result does not satisfy the v1.0 wire schema');
    }
    return parsed.data;
  }

  /** Idempotent cancellation; returns once the run has a readable terminal result. */
  async cancel(runId: string): Promise<RunSnapshot> {
    const run = this.store.getRun(runId);
    if (!run) throw notFound(runId);
    if (isTerminalStatus(run.status)) return this.toSnapshot(run);

    this.updateRun(runId, (r) => ({ ...r, cancelRequested: true }));

    const live = this.live?.runId === runId ? this.live : undefined;
    if (live) {
      this.abortLive(live, 'cancel');
      await this.awaitCleanup(live);
    }
    // No live executor owns it, or cleanup exceeded the grace: finalize with
    // whatever is known. A late worker result can no longer overwrite it.
    this.finalize(runId, 'cancel');

    const final = this.store.getRun(runId);
    if (!final) throw notFound(runId);
    return this.toSnapshot(final);
  }

  private async awaitCleanup(live: LiveRun): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      live.done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.abortGraceMs);
      })
    ]);
    clearTimeout(timer);
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

  /**
   * After exclusive ownership of the state root is established, turns every
   * persisted queued/running/waiting record that no live executor owns into a
   * truthful terminal `error` with a readable envelope. Refuses (throws) when a
   * previous native process group of such a run is still alive, rather than
   * launching new work on top of it.
   */
  recoverInterruptedRuns(
    isNativeGroupAlive: (marker: NativeChildMarker) => boolean = isRecordedNativeGroupAlive,
    isCorruptMarkerPidAlive: (pid: number) => boolean = processGroupExists
  ): {
    diagnostics: string[];
    recovered: string[];
  } {
    if (!this.store.ownsRootLock()) {
      throw new Error('Recovery requires exclusive ownership of the state root');
    }
    const runs = this.store.allRuns().filter((run) => this.live?.runId !== run.runId);
    const stranded = runs.filter((run) => !isTerminalStatus(run.status));
    const diagnostics: string[] = [];
    const markerNotes = new Map<string, string>();
    // Every remaining marker is probed, whatever the run status: a cancel or
    // shutdown can finalize a run after the abort grace while its detached
    // native group is still alive. A marker is removed only once its group is
    // confirmed gone, so a refused start is re-checked on the next one.
    for (const run of runs) {
      const workDir = this.store.workDir(run.runId);
      const read = readNativeChildMarker(workDir);
      if (read.kind === 'absent') continue;
      if (read.kind === 'corrupt') {
        if (read.pid !== undefined && isCorruptMarkerPidAlive(read.pid)) {
          throw new Error(
            `Run ${run.runId}: its native child marker is corrupt but names process group ${read.pid}, which is still alive; stop it before restarting the runner`
          );
        }
        const quarantinedTo = quarantineNativeChildMarker(read.path);
        const note = `Run ${run.runId}: native child marker was unreadable and was quarantined; its recorded process is not running.`;
        diagnostics.push(`${note} (${quarantinedTo})`);
        markerNotes.set(run.runId, note);
        continue;
      }
      if (isNativeGroupAlive(read.marker)) {
        throw new Error(
          `Run ${run.runId}: its previous native process group ${read.marker.pid} is still alive; stop it before restarting the runner`
        );
      }
      removeNativeChildMarker(workDir);
    }
    const finishedAt = this.clock().toISOString();
    for (const run of stranded) {
      const reason = `Run interrupted: the runner restarted while the run was ${run.status}.`;
      const extra = markerNotes.get(run.runId);
      // A stored stranded result carries no typed publication input, but the
      // forced `error` status can never recompute to pass.
      const result = run.result
        ? withLifecycle(run.result, 'error', finishedAt, extra ? [reason, extra] : [reason])
        : buildErrorResult(run, extra ? `${reason} ${extra}` : reason, 'error', finishedAt);
      this.store.saveRun({
        ...run,
        result: publishable(run, result, finishedAt),
        status: 'error',
        updatedAt: finishedAt
      });
    }
    return { diagnostics, recovered: stranded.map((run) => run.runId) };
  }

  /** Idempotent graceful shutdown: blocks submissions, finalizes and awaits the live run. */
  shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      const live = this.live;
      if (live) {
        this.abortLive(live, 'shutdown');
        await this.awaitCleanup(live);
        this.finalize(live.runId, 'shutdown');
      }
    })();
    return this.shutdownPromise;
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
