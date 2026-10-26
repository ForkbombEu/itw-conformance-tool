import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export const runStatusSchema = z.enum([
  'cancelled',
  'completed',
  'error',
  'queued',
  'running',
  'timed_out',
  'waiting_for_interaction'
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const terminalRunStatuses: readonly RunStatus[] = ['cancelled', 'completed', 'error', 'timed_out'];

export function isTerminalStatus(status: RunStatus): boolean {
  return terminalRunStatuses.includes(status);
}

// ---------------------------------------------------------------------------
// RunRequest
// ---------------------------------------------------------------------------

const selectionSchema = z.strictObject({
  ids: z
    .array(z.string().min(1))
    .min(1)
    .max(32)
    .refine((arr) => new Set(arr).size === arr.length, 'IDs must be unique')
});

const targetSchema = z.strictObject({
  actor_name: z.string().min(1),
  actor_type: z.enum(['issuer', 'relying_party', 'verifier', 'wallet']),
  actor_version: z.string().optional(),
  issuer_identifier: z.string().url().optional(),
  rp_identifier: z.string().url().optional()
});

const runParametersSchema = z.strictObject({}).optional();

export const runRequestSchema = z.strictObject({
  category: z.enum(['issuance', 'presentation']),
  contract_version: z.literal('1.0'),
  parameters: runParametersSchema.default({}),
  profile_id: z.string().min(1),
  selection: selectionSchema,
  target: targetSchema,
  timeout_ms: z.number().int().min(1_000).max(900_000).default(600_000)
});

export type RunRequest = z.infer<typeof runRequestSchema>;

// ---------------------------------------------------------------------------
// Engine capability check (separate from shape validation)
// ---------------------------------------------------------------------------

export const NEW_ENGINE_ID = 'pagopa-itwct';
export const LEGACY_ENGINE_ID = 'pagopa-wct';

export interface CapabilityResult {
  ok: boolean;
  reason?: string;
}

export function checkNewEngineCapability(request: RunRequest): CapabilityResult {
  if (request.category !== 'presentation') {
    return { ok: false, reason: 'New engine supports only presentation category' };
  }
  if (request.selection.ids.length !== 1 || request.selection.ids[0] !== 'WP_RP_HAPPY') {
    return { ok: false, reason: "New engine supports exactly ['WP_RP_HAPPY']" };
  }
  if (request.parameters && Object.keys(request.parameters).length > 0) {
    return { ok: false, reason: 'New engine parameters must be an empty object' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// RunSnapshot
// ---------------------------------------------------------------------------

const pendingInteractionSchema = z.strictObject({
  correlation_id: z.string().optional(),
  created_at: z.string(),
  expires_at: z.string(),
  interaction_id: z.string(),
  kind: z.enum(['browser_authorization', 'wallet_deeplink', 'wallet_qr']),
  scenario_id: z.string(),
  uri: z.string()
});
export type PendingInteraction = z.infer<typeof pendingInteractionSchema>;

export const runSnapshotSchema = z.strictObject({
  cancel_requested: z.boolean(),
  contract_version: z.literal('1.0'),
  created_at: z.string(),
  engine: z.string(),
  pending_interactions: z.array(pendingInteractionSchema),
  result_url: z.string(),
  run_id: z.string(),
  status: runStatusSchema,
  updated_at: z.string()
});
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;

// ---------------------------------------------------------------------------
// RunnerResult
// ---------------------------------------------------------------------------

const engineSchema = z.strictObject({
  fork_repository: z.string(),
  id: z.string(),
  revision: z.string(),
  upstream_repository: z.string(),
  version: z.string()
});

const executionSchema = z.strictObject({
  error: z.string().optional(),
  exit_code: z.number().int().optional(),
  finished_at: z.string().optional(),
  started_at: z.string(),
  status: z.string()
});

const nativeSessionSchema = z.strictObject({
  id: z.string(),
  status: z.string()
});

const nativeAssertionSchema = z.strictObject({
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
});

const scenarioOutcomeSchema = z.strictObject({
  scenario_id: z.string(),
  verdict: z.enum(['FAIL', 'INCONCLUSIVE', 'PASS'])
});

const nativeSchema = z.strictObject({
  assertions: z.array(nativeAssertionSchema),
  coverage_mode: z.enum(['interoperability', 'it_wallet_profile']),
  native_suite_status: z.string(),
  scenario_outcomes: z.array(scenarioOutcomeSchema),
  sessions: z.array(nativeSessionSchema)
});

const summarySchema = z.strictObject({
  assertion_count: z.number().int().min(0),
  native_failed_assertion_count: z.number().int().min(0),
  result: z.enum(['fail', 'inconclusive', 'not_tested', 'partial', 'pass'])
});

const artifactManifestEntrySchema = z.strictObject({
  artifact_id: z.string(),
  download_url: z.string(),
  filename: z.string(),
  mime_type: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size_bytes: z.number().int().min(0)
});

export const runnerResultSchema = z.strictObject({
  artifacts: z.array(artifactManifestEntrySchema),
  category: z.string(),
  contract_version: z.literal('1.0'),
  engine: engineSchema,
  execution: executionSchema,
  limitations: z.array(z.string()),
  native: nativeSchema,
  profile_id: z.string(),
  run_id: z.string(),
  selection: selectionSchema,
  summary: summarySchema,
  target: targetSchema
});

export type RunnerResult = z.infer<typeof runnerResultSchema>;

// ---------------------------------------------------------------------------
// RunnerError
// ---------------------------------------------------------------------------

export class RunnerError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function invalidRequest(detail: string): RunnerError {
  return new RunnerError('INVALID_REQUEST', 400, detail);
}

export function idempotencyConflict(): RunnerError {
  return new RunnerError('IDEMPOTENCY_CONFLICT', 409, 'Same key with different request body');
}

export function runBusy(): RunnerError {
  return new RunnerError('RUNNER_BUSY', 409, 'Runner is busy');
}

export function notFound(id: string): RunnerError {
  return new RunnerError('NOT_FOUND', 404, `'${id}' not found`);
}

export function resultNotReady(): RunnerError {
  return new RunnerError('RESULT_NOT_READY', 409, 'Run has not reached a terminal state');
}
