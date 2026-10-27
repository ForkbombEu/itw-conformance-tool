import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readScenarioOutcomes } from '@itw-conformance-tool/utils';

import { removeNativeChildMarker, writeNativeChildMarker } from './native-child-marker.js';
import {
  provisionInitializedAssets,
  resolveCliEntry,
  resolveEngineIdentity,
  resolveRepositoryRoot
} from './native-launch.js';
import { validateAndAdaptNativeExport, type AdaptedNativeExport } from './native-result-adapter.js';
import { assertSelectionAllowed } from './profiles.js';
import { summarizeWithLimitations } from './summarize.js';

import type { PrivateArtifact } from './artifacts.js';
import type { RunRequest, RunnerResult } from './contract.js';
import type { LoadedProfile } from './profiles.js';
import type { Readable } from 'node:stream';

export interface SpawnedProcess {
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'exit', listener: (code: null | number) => void): void;
  readonly pid?: number | undefined;
  stderr: null | Readable;
  stdout: null | Readable;
}

export interface SpawnOptions {
  cwd: string;
  detached: boolean;
  env: NodeJS.ProcessEnv;
  shell: boolean;
  stdio: 'pipe';
}

/** The low-level subprocess boundary; the default launches a real OS process. */
export interface ProcessAdapter {
  spawn(command: string, args: string[], options: SpawnOptions): SpawnedProcess;
}

export const defaultProcessAdapter: ProcessAdapter = {
  spawn(command, args, options) {
    return spawn(command, args, options);
  }
};

export interface NativeExecutorOptions {
  /** Grace period between SIGTERM and SIGKILL of the native process group. */
  killGraceMs?: number;
  processAdapter?: ProcessAdapter;
  profile: LoadedProfile;
}

export interface NativeExecuteContext {
  abortSignal: AbortSignal;
  request: RunRequest;
  runId: string;
  runRoot: string;
}

export interface NativeEvidence {
  privateArtifacts: PrivateArtifact[];
  result: RunnerResult;
}

/** Stable run-scoped ID of the raw native export artifact. */
export const NATIVE_EXPORT_ARTIFACT_ID = 'native-results';

/** File name the native ConformanceReporter publishes into ITWCT_RESULTS_DIR. */
export const NATIVE_EXPORT_FILENAME = 'native-results.json';
/** Bounded private diagnostics captured from the native child's stdout/stderr. */
export const NATIVE_DIAGNOSTICS_FILENAME = 'native-child.log';
export const MAX_DIAGNOSTIC_BYTES = 2 * 1024 * 1024;

const DEFAULT_KILL_GRACE_MS = 15_000;

/** Environment the runner owns for the native child; inherited values are discarded. */
const OWNED_ENV_KEYS = [
  'CREDIMI_RUNNER_TOKEN',
  'ITWCT_AUTOMATION_DIR',
  'ITWCT_CONFIG_PATH',
  'ITWCT_CONFORMANCE_TEST_CATEGORY',
  'ITWCT_CONFORMANCE_VERBOSE',
  'ITWCT_DATA_DIR',
  'ITWCT_PRESENTATION_SCENARIO_IDS',
  'ITWCT_REPOSITORY_ROOT',
  'ITWCT_RESULTS_DIR',
  'ITWCT_RUN_ID',
  'ITWCT_SERVICE_CONTROL_ENDPOINT'
];

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group may already be gone.
  }
}

/** Waits until every process in the native group (CLI, services, Vitest) has exited. */
async function awaitGroupExit(pid: number, graceMs: number): Promise<void> {
  const deadline = Date.now() + graceMs;
  while (processGroupAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (processGroupAlive(pid)) {
    signalGroup(pid, 'SIGKILL');
    const killDeadline = Date.now() + 5_000;
    while (processGroupAlive(pid) && Date.now() < killDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/** Drains both pipes so the child can never block on a full pipe; keeps a bounded private log. */
function captureDiagnostics(child: SpawnedProcess, logPath: string): () => Promise<{ truncated: boolean }> {
  const log = createWriteStream(logPath, { flags: 'a', mode: 0o600 });
  let written = 0;
  let truncated = false;
  const onData = (chunk: Buffer | string): void => {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    const room = MAX_DIAGNOSTIC_BYTES - written;
    if (room <= 0) {
      truncated = true;
      return;
    }
    const slice = buffer.length > room ? buffer.subarray(0, room) : buffer;
    if (slice.length < buffer.length) truncated = true;
    written += slice.length;
    log.write(slice);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  return () =>
    new Promise((resolve) => {
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      log.end(() => resolve({ truncated }));
    });
}

export function createNativeExecutor(
  options: NativeExecutorOptions
): (ctx: NativeExecuteContext) => Promise<NativeEvidence> {
  const adapter = options.processAdapter ?? defaultProcessAdapter;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return async (ctx) => {
    const { abortSignal, request, runId, runRoot } = ctx;
    const { profile } = options;

    if (request.profile_id !== profile.id || request.category !== profile.category) {
      throw new Error(`Request does not match profile '${profile.id}'`);
    }
    assertSelectionAllowed(profile, request.selection.ids);
    if (abortSignal.aborted) throw new Error('Run was aborted before the native child was spawned');

    const resultsDir = join(runRoot, 'results');
    const dataDir = join(runRoot, 'data');
    const diagnosticsDir = join(runRoot, 'diagnostics');
    mkdirSync(resultsDir, { recursive: true });
    mkdirSync(diagnosticsDir, { recursive: true });
    provisionInitializedAssets(profile.initializedAssetsDir, dataDir);

    const cliEntry = resolveCliEntry();
    const repositoryRoot = resolveRepositoryRoot();

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of OWNED_ENV_KEYS) delete env[key];
    Object.assign(env, {
      ITWCT_AUTOMATION_DIR: runRoot,
      ITWCT_CONFIG_PATH: profile.configPath,
      ITWCT_DATA_DIR: dataDir,
      ITWCT_PRESENTATION_SCENARIO_IDS: request.selection.ids.join(','),
      ITWCT_REPOSITORY_ROOT: repositoryRoot,
      ITWCT_RESULTS_DIR: resultsDir,
      ITWCT_RUN_ID: runId
    });

    const startedAt = new Date().toISOString();
    const identity = resolveEngineIdentity();

    const child = adapter.spawn(process.execPath, [cliEntry, 'test', 'presentation', '--verbose'], {
      cwd: runRoot,
      detached: process.platform !== 'win32',
      env,
      shell: false,
      stdio: 'pipe'
    });
    const finishDiagnostics = captureDiagnostics(child, join(diagnosticsDir, NATIVE_DIAGNOSTICS_FILENAME));
    const exited = new Promise<null | number>((resolve, reject) => {
      child.on('exit', (code) => resolve(code));
      child.on('error', (err) => reject(err));
    });
    exited.catch(() => undefined);
    const ownsGroup = Boolean(child.pid) && process.platform !== 'win32';

    // Lets restart recovery detect a native process group that outlived a
    // crashed runner. If the marker cannot be written, the child must not be
    // left running untracked: terminate and await its whole group first.
    try {
      if (child.pid) writeNativeChildMarker(runRoot, child.pid, startedAt);
    } catch (error) {
      if (child.pid) signalGroup(child.pid, 'SIGTERM');
      await Promise.race([exited.catch(() => null), new Promise((resolve) => setTimeout(resolve, killGraceMs))]);
      if (ownsGroup && child.pid) await awaitGroupExit(child.pid, killGraceMs);
      await finishDiagnostics();
      throw error;
    }

    let onAbort: (() => void) | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let exitCode: null | number;
    try {
      onAbort = () => {
        if (!child.pid) return;
        signalGroup(child.pid, 'SIGTERM');
        escalation = setTimeout(() => {
          if (child.pid) signalGroup(child.pid, 'SIGKILL');
        }, killGraceMs);
      };
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
      exitCode = await exited;
    } finally {
      if (onAbort) abortSignal.removeEventListener('abort', onAbort);
      clearTimeout(escalation);
      // Services/Vitest share the child's process group; none may outlive the run.
      if (ownsGroup && child.pid) {
        await awaitGroupExit(child.pid, killGraceMs);
        // Remove the marker only once the whole group is confirmed gone.
        if (!processGroupAlive(child.pid)) removeNativeChildMarker(runRoot);
      }
    }
    const { truncated } = await finishDiagnostics();

    const finishedAt = new Date().toISOString();
    const baseLimitations = [
      ...identity.limitations,
      ...(truncated ? [`Native child diagnostics were truncated at ${MAX_DIAGNOSTIC_BYTES} bytes.`] : [])
    ];

    const errorResult = (reason: string): RunnerResult =>
      buildErrorResult({ exitCode, finishedAt, identity, profile, reason, request, runId, startedAt }, baseLimitations);

    // Read the native export the REAL reporter wrote, validate it against the
    // producer format and adapt it; never trust or cast unvalidated JSON.
    const exportPath = join(resultsDir, NATIVE_EXPORT_FILENAME);
    if (!existsSync(exportPath)) {
      return { privateArtifacts: [], result: errorResult('Native export is missing') };
    }

    let adapted: AdaptedNativeExport;
    try {
      adapted = validateAndAdaptNativeExport(JSON.parse(readFileSync(exportPath, 'utf-8')), {
        expectedPhase: profile.category,
        expectedRunId: runId,
        notBefore: new Date(startedAt)
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Keep the raw bytes as evidence even though they were rejected.
      return {
        privateArtifacts: [nativeExportArtifact(exportPath)],
        result: errorResult(`Native export rejected: ${reason}`)
      };
    }

    const outcomes = readSelectedScenarioOutcomes(runRoot, runId, request.selection.ids);

    const native: RunnerResult['native'] = {
      assertions: adapted.assertions,
      coverage_mode: profile.coverageMode,
      native_suite_status: adapted.status,
      scenario_outcomes: outcomes.scenarioOutcomes,
      sessions: [{ id: adapted.sessionId, status: adapted.status }]
    };

    // A readable native suite result was collected: failed assertions are
    // normal conformance data, not an execution error.
    const execution: RunnerResult['execution'] = {
      ...(exitCode === null ? {} : { exit_code: exitCode }),
      finished_at: finishedAt,
      started_at: startedAt,
      status: 'completed'
    };

    const { limitations, summary } = summarizeWithLimitations(execution, native, {
      assertionScenarios: adapted.assertionScenarios
    });

    return {
      // Published (hashed, persisted) by the composition's artifact store.
      privateArtifacts: [nativeExportArtifact(exportPath)],
      result: {
        artifacts: [],
        category: profile.category,
        contract_version: '1.0',
        engine: identity.engine,
        execution,
        limitations: [
          ...limitations,
          ...adapted.errors.map((message) => `Native error outside test bodies: ${message}`),
          ...outcomes.limitations,
          ...baseLimitations
        ],
        native,
        profile_id: profile.id,
        run_id: runId,
        selection: request.selection,
        summary,
        target: request.target
      }
    };
  };
}

function nativeExportArtifact(path: string): PrivateArtifact {
  return {
    artifactId: NATIVE_EXPORT_ARTIFACT_ID,
    filename: NATIVE_EXPORT_FILENAME,
    mimeType: 'application/json',
    path
  };
}

/** Native scenario verdicts the file engagement driver persisted for the selected scenarios. */
function readSelectedScenarioOutcomes(
  runRoot: string,
  runId: string,
  selectedIds: readonly string[]
): { limitations: string[]; scenarioOutcomes: RunnerResult['native']['scenario_outcomes'] } {
  const { invalid, outcomes } = readScenarioOutcomes(runRoot, runId);
  const limitations: string[] = [];
  if (invalid > 0) limitations.push(`${invalid} native scenario outcome record(s) were malformed and ignored.`);
  const unselected = outcomes.filter((outcome) => !selectedIds.includes(outcome.scenarioId));
  if (unselected.length > 0) {
    limitations.push(
      `Ignored native outcomes for unselected scenarios: ${unselected.map((o) => o.scenarioId).join(', ')}.`
    );
  }
  const scenarioOutcomes = outcomes
    .filter((outcome) => selectedIds.includes(outcome.scenarioId))
    .map((outcome) => ({ scenario_id: outcome.scenarioId, verdict: outcome.verdict }));
  const missing = selectedIds.filter((id) => !scenarioOutcomes.some((outcome) => outcome.scenario_id === id));
  if (missing.length > 0) limitations.push(`No native scenario verdict was recorded for: ${missing.join(', ')}.`);
  return { limitations, scenarioOutcomes };
}

interface ErrorResultInput {
  exitCode: null | number;
  finishedAt: string;
  identity: ReturnType<typeof resolveEngineIdentity>;
  profile: LoadedProfile;
  reason: string;
  request: RunRequest;
  runId: string;
  startedAt: string;
}

function buildErrorResult(input: ErrorResultInput, limitations: string[]): RunnerResult {
  const { exitCode, finishedAt, identity, profile, reason, request, runId, startedAt } = input;
  return {
    artifacts: [],
    category: profile.category,
    contract_version: '1.0',
    engine: identity.engine,
    execution: {
      error: reason,
      ...(exitCode === null ? {} : { exit_code: exitCode }),
      finished_at: finishedAt,
      started_at: startedAt,
      status: 'error'
    },
    limitations: [reason, ...limitations],
    native: {
      assertions: [],
      coverage_mode: profile.coverageMode,
      native_suite_status: 'ERROR',
      scenario_outcomes: [],
      sessions: []
    },
    profile_id: profile.id,
    run_id: runId,
    selection: request.selection,
    summary: {
      assertion_count: 0,
      native_failed_assertion_count: 0,
      result: 'not_tested'
    },
    target: request.target
  };
}
