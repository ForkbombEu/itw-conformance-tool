import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  vitest_status?: string;
}

export interface NativeExport {
  assertions: NativeAssertion[];
  closedAt: null | string;
  phase: string;
  run_id: string;
  session_id: string;
  startedAt: string;
  status: string;
}

export function buildNativeExport(params: {
  assertions: NativeAssertion[];
  closedAt: null | string;
  phase: string;
  runId: string;
  sessionId: string;
  startedAt: string;
  status: string;
}): NativeExport {
  return {
    assertions: params.assertions,
    closedAt: params.closedAt,
    phase: params.phase,
    run_id: params.runId,
    session_id: params.sessionId,
    startedAt: params.startedAt,
    status: params.status
  };
}

export function writeNativeExport(outputDir: string, data: NativeExport): string {
  mkdirSync(outputDir, { recursive: true });
  const target = join(outputDir, 'native-results.json');
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, target);
  return target;
}
