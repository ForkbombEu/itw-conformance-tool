import { z } from 'zod';

import { nativeAssertionSchema as wireAssertionSchema } from './contract.js';

import type { RunnerResult } from './contract.js';

// ---------------------------------------------------------------------------
// Producer format: what THIS repo's ConformanceReporter writes through
// packages/conformance/src/report/native-export.ts. It is engine-specific and
// validated here before anything is adapted into RunnerResult wire data.
// ---------------------------------------------------------------------------

const producerAssertionSchema = z.strictObject({
  ancestor_titles: z.array(z.string()),
  credential_configuration_id: z.string().optional(),
  error_message: z.string().optional(),
  file: z.string().min(1),
  full_title: z.string().min(1),
  native_status: z.enum(['FAIL', 'NOT_REACHED', 'PASS']),
  phase: z.string().min(1),
  raw: z.string().optional(),
  requirement_id: z.string().min(1).optional(),
  scenario_id: z.string().min(1).optional(),
  test_id: z.string().min(1).optional(),
  vitest_status: z.string().optional()
});

export const nativeExportSchema = z.strictObject({
  assertions: z.array(producerAssertionSchema),
  closedAt: z.string().datetime(),
  errors: z.array(z.string()).optional(),
  phase: z.string().min(1),
  run_id: z.string().min(1),
  session_id: z.string().min(1),
  startedAt: z.string().datetime(),
  status: z.enum(['FAILED', 'INCOMPLETE', 'PASSED'])
});

export type NativeExportRaw = z.infer<typeof nativeExportSchema>;
export type WireAssertion = RunnerResult['native']['assertions'][number];

export interface AdaptedNativeExport {
  /** Per assertion_id: the protocol-observed scenario it belongs to, or null for a generic check. */
  assertionScenarios: Map<string, null | string>;
  assertions: WireAssertion[];
  closedAt: string;
  errors: string[];
  sessionId: string;
  startedAt: string;
  status: NativeExportRaw['status'];
}

export class NativeExportValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'NativeExportValidationError';
    this.code = code;
  }
}

export interface AdaptNativeExportOptions {
  expectedPhase: string;
  expectedRunId: string;
  /** Exports that started before this instant are stale evidence from an earlier execution. */
  notBefore?: Date;
}

/** Tolerance for clock granularity between the worker and the native child. */
const STALE_SKEW_MS = 1_000;

/**
 * Validates raw native data against the PRODUCER format, checks it belongs to
 * this execution, and converts it to the documented wire assertions. Throws
 * NativeExportValidationError for malformed, mismatched or stale evidence; a
 * legitimate failed native suite is returned as data.
 */
export function validateAndAdaptNativeExport(raw: unknown, options: AdaptNativeExportOptions): AdaptedNativeExport {
  const parsed = nativeExportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new NativeExportValidationError(
      'INVALID_NATIVE_EXPORT',
      `Native export does not match producer format: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
    );
  }

  const data = parsed.data;

  if (data.run_id !== options.expectedRunId) {
    throw new NativeExportValidationError(
      'RUN_ID_MISMATCH',
      `Native export run_id '${data.run_id}' does not match expected '${options.expectedRunId}'`
    );
  }

  if (data.phase !== options.expectedPhase || data.assertions.some((a) => a.phase !== options.expectedPhase)) {
    throw new NativeExportValidationError(
      'PHASE_MISMATCH',
      `Native export phase does not match the selected '${options.expectedPhase}' category`
    );
  }

  if (options.notBefore && Date.parse(data.startedAt) < options.notBefore.getTime() - STALE_SKEW_MS) {
    throw new NativeExportValidationError(
      'STALE_NATIVE_EXPORT',
      `Native export started at ${data.startedAt}, before this execution started`
    );
  }

  if (Date.parse(data.closedAt) < Date.parse(data.startedAt)) {
    throw new NativeExportValidationError('INVALID_NATIVE_EXPORT', 'Native export closedAt precedes startedAt');
  }

  const assertionScenarios = new Map<string, null | string>();
  const assertions = data.assertions.map((assertion, index): WireAssertion => {
    // Stable within the run and unique per occurrence, even when a normative
    // requirement ID repeats.
    const assertionId = `a${String(index + 1).padStart(4, '0')}`;
    assertionScenarios.set(assertionId, assertion.scenario_id ?? null);
    return wireAssertionSchema.parse({
      ancestor_titles: assertion.ancestor_titles,
      assertion_id: assertionId,
      ...(assertion.credential_configuration_id
        ? { credential_configuration_id: assertion.credential_configuration_id }
        : {}),
      ...(assertion.error_message ? { error_message: assertion.error_message } : {}),
      file: assertion.file,
      full_title: assertion.full_title,
      native_status: assertion.native_status,
      phase: assertion.phase,
      raw: JSON.stringify(assertion),
      ...(assertion.requirement_id ? { requirement_id: assertion.requirement_id } : {}),
      ...(assertion.vitest_status ? { vitest_status: assertion.vitest_status } : {})
    });
  });

  return {
    assertionScenarios,
    assertions,
    closedAt: data.closedAt,
    errors: data.errors ?? [],
    sessionId: data.session_id,
    startedAt: data.startedAt,
    status: data.status
  };
}
