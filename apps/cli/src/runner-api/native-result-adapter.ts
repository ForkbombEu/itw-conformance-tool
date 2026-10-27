import { z } from 'zod';

const nativeAssertionSchema = z
  .object({
    ancestorTitles: z.array(z.string()),
    description: z.string().optional(),
    errorMessage: z.string().nullish(),
    file: z.string(),
    nativeStatus: z.enum(['FAIL', 'NOT_REACHED', 'PASS']),
    phase: z.string(),
    requirementId: z.string().nullish(),
    timestamp: z.string().optional(),
    title: z.string(),
    vitestStatus: z.enum(['failed', 'passed', 'pending', 'skipped']).optional()
  })
  .strict();

export const nativeExportSchema = z
  .object({
    assertions: z.array(nativeAssertionSchema),
    closedAt: z.string().nullish(),
    phase: z.string(),
    runId: z.string(),
    sessionId: z.string(),
    startedAt: z.string(),
    status: z.enum(['FAILED', 'INCOMPLETE', 'OPEN', 'PASSED'])
  })
  .strict();

export type NativeExportRaw = z.infer<typeof nativeExportSchema>;

export interface AdaptedAssertion {
  ancestor_titles: string[];
  assertion_id: string;
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

export class NativeExportValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'NativeExportValidationError';
    this.code = code;
  }
}

export function validateAndAdaptNativeExport(
  raw: unknown,
  options: { expectedRunId: string }
): { assertions: AdaptedAssertion[]; sessionId: string; status: string } {
  const parsed = nativeExportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new NativeExportValidationError(
      'INVALID_NATIVE_EXPORT',
      `Native export does not match producer format: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
    );
  }

  const data = parsed.data;

  if (data.runId !== options.expectedRunId) {
    throw new NativeExportValidationError(
      'RUN_ID_MISMATCH',
      `Native export runId '${data.runId}' does not match expected '${options.expectedRunId}'`
    );
  }

  const assertions: AdaptedAssertion[] = data.assertions.map((a, index) => ({
    ancestor_titles: a.ancestorTitles,
    assertion_id: `assertion-${index}`,
    error_message: a.errorMessage ?? undefined,
    file: a.file,
    full_title: a.title,
    native_status: a.nativeStatus,
    phase: a.phase,
    raw: JSON.stringify(a),
    requirement_id: a.requirementId ?? undefined,
    vitest_status: a.vitestStatus
  }));

  return { assertions, sessionId: data.sessionId, status: data.status };
}
