import { z } from 'zod';

// Schema for THIS repo's producer format (native-export.ts emits snake_case)
const nativeAssertionSchema = z
  .object({
    ancestor_titles: z.array(z.string()),
    credential_configuration_id: z.string().optional(),
    error_message: z.string().optional(),
    file: z.string(),
    full_title: z.string(),
    native_status: z.enum(['FAIL', 'NOT_REACHED', 'PASS']),
    phase: z.string(),
    raw: z.string().optional(),
    requirement_id: z.string().optional(),
    vitest_status: z.string().optional()
  })
  .strict();

export const nativeExportSchema = z
  .object({
    assertions: z.array(nativeAssertionSchema),
    closedAt: z.string().nullish(),
    phase: z.string(),
    run_id: z.string(),
    session_id: z.string(),
    startedAt: z.string(),
    status: z.string()
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

  // Validate run ID matches
  if (data.run_id !== options.expectedRunId) {
    throw new NativeExportValidationError(
      'RUN_ID_MISMATCH',
      `Native export run_id '${data.run_id}' does not match expected '${options.expectedRunId}'`
    );
  }

  // Map to wire assertions (already snake_case from producer)
  const assertions: AdaptedAssertion[] = data.assertions.map((a, index) => ({
    ancestor_titles: a.ancestor_titles,
    assertion_id: `assertion-${index}`,
    credential_configuration_id: a.credential_configuration_id,
    error_message: a.error_message,
    file: a.file,
    full_title: a.full_title,
    native_status: a.native_status,
    phase: a.phase,
    raw: a.raw ?? JSON.stringify(a),
    requirement_id: a.requirement_id,
    vitest_status: a.vitest_status
  }));

  return { assertions, sessionId: data.session_id, status: data.status };
}
