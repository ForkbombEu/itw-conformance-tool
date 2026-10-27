import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { assertSelectionAllowed } from './profiles.js';
import { summarizeResult } from './summarize.js';

import type { RunRequest, RunnerResult } from './contract.js';
import type { Profile } from './profiles.js';

export interface SpawnedProcess {
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'exit', listener: (code: null | number) => void): void;
  pid: number | undefined;
}

export interface SpawnOptions {
  cwd: string;
  detached: boolean;
  env: NodeJS.ProcessEnv;
  shell: boolean;
  stdio: 'ignore' | 'pipe';
}

export interface ProcessAdapter {
  spawn(command: string, args: string[], options: SpawnOptions): SpawnedProcess;
}

export const defaultProcessAdapter: ProcessAdapter = {
  spawn(command, args, options) {
    return spawn(command, args, options) as unknown as SpawnedProcess;
  }
};

export interface NativeExecutorOptions {
  processAdapter?: ProcessAdapter;
  profile: Profile;
  request: RunRequest;
}

import { createRequire } from 'node:module';

function resolveCliEntry(): string {
  // Resolve the compiled CLI entrypoint from the installed module location
  try {
    const req = createRequire(import.meta.url);
    return req.resolve('itw-conformance-cli/dist/main.js');
  } catch {
    // Fallback: assume running from source
    return process.argv[1] ?? 'node';
  }
}

const ENGINE_INFO = {
  fork_repository: 'https://github.com/ForkbombEu/itw-conformance-tool',
  id: 'pagopa-itwct',
  upstream_repository: 'https://github.com/pagopa/itw-conformance-tool'
};

export function createNativeExecutor(
  options: NativeExecutorOptions
): (ctx: {
  abortSignal: AbortSignal;
  request: RunRequest;
  runId: string;
  runRoot: string;
}) => Promise<{ privateArtifactPaths: string[]; result: RunnerResult }> {
  const adapter = options.processAdapter ?? defaultProcessAdapter;

  return async (ctx) => {
    const { runId, runRoot } = ctx;
    const { profile, request } = options;

    // Validate selection before spawning
    assertSelectionAllowed(profile, request.selection.ids);

    const resultsDir = join(runRoot, 'results');
    const dataDir = join(runRoot, 'data');
    mkdirSync(resultsDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ITWCT_AUTOMATION_DIR: runRoot,
      ITWCT_CONFIG_PATH: profile.configPath,
      ITWCT_DATA_DIR: dataDir,
      ITWCT_PRESENTATION_SCENARIO_IDS: request.selection.ids.join(','),
      ITWCT_RESULTS_DIR: resultsDir,
      ITWCT_RUN_ID: runId
    };

    const startedAt = new Date().toISOString();

    // Resolve compiled CLI entrypoint from installed module location
    const cliEntry = resolveCliEntry();
    const child = adapter.spawn(process.execPath, [cliEntry, 'test', 'presentation', '--verbose'], {
      cwd: runRoot,
      detached: true,
      env,
      shell: false,
      stdio: 'pipe'
    });

    const exitCode = await new Promise<null | number>((resolve, reject) => {
      let settled = false;
      const settle = (code: null | number) => {
        if (!settled) {
          settled = true;
          resolve(code);
        }
      };
      child.on('exit', (code) => settle(code));
      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      ctx.abortSignal.addEventListener('abort', () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            // ignore
          }
          setTimeout(() => {
            if (!settled && child.pid) {
              try {
                process.kill(-child.pid, 'SIGKILL');
              } catch {
                // ignore
              }
            }
          }, 5_000);
        }
      });
    });

    const finishedAt = new Date().toISOString();

    // Read native export
    const exportPath = join(resultsDir, 'native-results.json');
    let nativeExport: {
      assertions: RunnerResult['native']['assertions'];
      session_id: string;
      status: string;
    } | null = null;

    if (existsSync(exportPath)) {
      try {
        nativeExport = JSON.parse(readFileSync(exportPath, 'utf-8'));
      } catch {
        nativeExport = null;
      }
    }

    if (!nativeExport) {
      return {
        privateArtifactPaths: [],
        result: buildErrorResult(runId, request, profile, startedAt, finishedAt, exitCode)
      };
    }

    const native: RunnerResult['native'] = {
      assertions: nativeExport.assertions,
      coverage_mode: profile.coverageMode,
      native_suite_status: nativeExport.status,
      scenario_outcomes: [],
      sessions: [{ id: nativeExport.session_id, status: nativeExport.status }]
    };

    const execution: RunnerResult['execution'] = {
      exit_code: exitCode ?? undefined,
      finished_at: finishedAt,
      started_at: startedAt,
      status: exitCode === 0 ? 'completed' : 'completed'
    };

    // Register native export as artifact
    const artifactId = `${runId}:native-export`;
    const nativeExportPath = join(resultsDir, 'native-results.json');

    return {
      privateArtifactPaths: [nativeExportPath],
      result: {
        artifacts: [
          {
            artifact_id: artifactId,
            download_url: `/v1/runs/${runId}/artifacts/${encodeURIComponent(artifactId)}`,
            filename: 'native-results.json',
            mime_type: 'application/json',
            sha256: '',
            size_bytes: 0
          }
        ],
        category: profile.category,
        contract_version: '1.0',
        engine: { ...ENGINE_INFO, revision: 'unknown', version: '1.0' },
        execution,
        limitations: [],
        native,
        profile_id: profile.id,
        run_id: runId,
        selection: request.selection,
        summary: summarizeResult(execution, native),
        target: request.target
      }
    };
  };
}

function buildErrorResult(
  runId: string,
  request: RunRequest,
  profile: Profile,
  startedAt: string,
  finishedAt: string,
  exitCode: null | number
): RunnerResult {
  return {
    artifacts: [],
    category: profile.category,
    contract_version: '1.0',
    engine: { ...ENGINE_INFO, revision: 'unknown', version: '1.0' },
    execution: {
      error: 'native export missing or corrupt',
      exit_code: exitCode ?? undefined,
      finished_at: finishedAt,
      started_at: startedAt,
      status: 'error'
    },
    limitations: ['Native export was missing or unreadable'],
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
