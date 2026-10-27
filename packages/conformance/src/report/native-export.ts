import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Producer format of one assertion occurrence (engine-specific, snake_case). */
export interface NativeAssertion {
  ancestor_titles: string[];
  credential_configuration_id?: string;
  error_message?: string;
  file: string;
  full_title: string;
  native_status: 'FAIL' | 'NOT_REACHED' | 'PASS';
  phase: string;
  raw?: string;
  requirement_id?: string;
  /** Protocol-observed scenario the occurrence belongs to; absent for generic checks. */
  scenario_id?: string;
  /** Vitest's deterministic test ID; unique per test within the run. */
  test_id?: string;
  vitest_status?: string;
}

export type NativeExportStatus = 'FAILED' | 'INCOMPLETE' | 'PASSED';

export interface NativeExport {
  assertions: NativeAssertion[];
  closedAt: null | string;
  /** Collection, hook and unhandled errors that happened outside test bodies. */
  errors?: string[];
  phase: string;
  run_id: string;
  session_id: string;
  startedAt: string;
  status: NativeExportStatus;
}

export const NATIVE_EXPORT_FILENAME = 'native-results.json';

export function buildNativeExport(params: {
  assertions: NativeAssertion[];
  closedAt: null | string;
  errors?: string[];
  phase: string;
  runId: string;
  sessionId: string;
  startedAt: string;
  status: NativeExportStatus;
}): NativeExport {
  return {
    assertions: params.assertions,
    closedAt: params.closedAt,
    ...(params.errors && params.errors.length > 0 ? { errors: params.errors } : {}),
    phase: params.phase,
    run_id: params.runId,
    session_id: params.sessionId,
    startedAt: params.startedAt,
    status: params.status
  };
}

/** Publishes the export atomically: readers never observe a partially written file. */
export function writeNativeExport(outputDir: string, data: NativeExport): string {
  mkdirSync(outputDir, { recursive: true });
  const target = join(outputDir, NATIVE_EXPORT_FILENAME);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, target);
  return target;
}
