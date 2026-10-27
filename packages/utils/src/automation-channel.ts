import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

/**
 * Canonical file channel between a native automated run (the scenario
 * runner's file engagement driver) and the runner API, rooted at the run's
 * automation directory. It is deliberately free of conformance runtime and
 * service imports.
 *
 * Every record is immutable and published with an exclusive create:
 * - `interactions/<id>.json` — written once by the native side
 * - `acks/<id>.json`         — written once by the API (driver ACK)
 * - `closed/<id>.json`       — written once by the native side (close)
 * - `outcomes/<scenario>.json` — the native scenario verdict, written once
 * Separate markers instead of read-modify-write records means an ACK and a
 * close can never lose each other's update; close always wins for pending.
 */

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
/** The native presentation runner runs one scenario engagement at a time. */
export const MAX_PENDING_INTERACTIONS = 1;
const MAX_URI_LENGTH = 16_384;
const MAX_ACK_MESSAGE_LENGTH = 2_048;

const safeId = z.string().regex(SAFE_ID);

export const channelInteractionSchema = z.strictObject({
  correlationId: z.string().min(1).max(256),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  interactionId: safeId,
  kind: z.enum(['browser_authorization', 'wallet_deeplink', 'wallet_qr']),
  runId: z.string().min(1).max(128),
  scenarioId: safeId,
  uri: z.string().min(1).max(MAX_URI_LENGTH)
});
export type ChannelInteraction = z.infer<typeof channelInteractionSchema>;

export const channelAckSchema = z.strictObject({
  acknowledgedAt: z.string().datetime(),
  driverStatus: z.enum(['completed', 'failed']),
  interactionId: safeId,
  message: z.string().max(MAX_ACK_MESSAGE_LENGTH).optional(),
  runId: z.string().min(1)
});
export type ChannelAck = z.infer<typeof channelAckSchema>;

const channelCloseSchema = z.strictObject({
  closedAt: z.string().datetime(),
  interactionId: safeId,
  reason: z.string().max(256),
  runId: z.string().min(1)
});

export const channelOutcomeSchema = z.strictObject({
  completedAt: z.string().datetime(),
  reason: z.string().max(4_096),
  runId: z.string().min(1),
  scenarioId: safeId,
  verdict: z.enum(['FAIL', 'INCONCLUSIVE', 'PASS'])
});
export type ChannelOutcome = z.infer<typeof channelOutcomeSchema>;

export type ChannelErrorCode =
  | 'ACK_CONFLICT'
  | 'INTERACTION_CLOSED'
  | 'INTERACTION_EXPIRED'
  | 'INTERACTION_NOT_FOUND'
  | 'INVALID_RECORD'
  | 'OUTCOME_CONFLICT'
  | 'TOO_MANY_PENDING';

export class AutomationChannelError extends Error {
  readonly code: ChannelErrorCode;
  constructor(code: ChannelErrorCode, message: string) {
    super(message);
    this.name = 'AutomationChannelError';
    this.code = code;
  }
}

const dirs = (root: string) => ({
  acks: join(root, 'acks'),
  closed: join(root, 'closed'),
  interactions: join(root, 'interactions'),
  outcomes: join(root, 'outcomes')
});

function recordPath(directory: string, id: string): string {
  if (!SAFE_ID.test(id)) throw new AutomationChannelError('INVALID_RECORD', `Invalid channel ID: ${id}`);
  return join(directory, `${id}.json`);
}

/** Exclusive, atomic publish: false when a record already exists at the path. */
function publishOnce(directory: string, path: string, data: unknown): boolean {
  mkdirSync(directory, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
  try {
    linkSync(tmp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    unlinkSync(tmp);
  }
}

function readRecord<T>(path: string, schema: z.ZodType<T>): T | undefined {
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw new AutomationChannelError('INVALID_RECORD', `Unreadable channel record ${path}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AutomationChannelError('INVALID_RECORD', `Malformed channel record ${path}`);
  return parsed.data;
}

function listIds(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .filter((id) => SAFE_ID.test(id));
}

function isClosed(root: string, interactionId: string): boolean {
  return existsSync(recordPath(dirs(root).closed, interactionId));
}

export interface PendingInteractionsView {
  /** Records that exist but failed validation (never exposed as pending). */
  invalid: number;
  pending: ChannelInteraction[];
}

/** Interactions of this run that are neither closed nor expired. */
export function listPendingInteractions(root: string, runId: string, now = new Date()): PendingInteractionsView {
  const { interactions } = dirs(root);
  const pending: ChannelInteraction[] = [];
  let invalid = 0;
  for (const id of listIds(interactions)) {
    let interaction: ChannelInteraction | undefined;
    try {
      interaction = readRecord(recordPath(interactions, id), channelInteractionSchema);
    } catch {
      invalid++;
      continue;
    }
    if (!interaction || interaction.interactionId !== id || interaction.runId !== runId) continue;
    if (isClosed(root, id)) continue;
    if (Date.parse(interaction.expiresAt) <= now.getTime()) continue;
    pending.push(interaction);
  }
  pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { invalid, pending };
}

/** Native side: publish one immutable interaction for the API to expose. */
export function publishInteraction(root: string, interaction: ChannelInteraction, now = new Date()): void {
  const parsed = channelInteractionSchema.safeParse(interaction);
  if (!parsed.success) throw new AutomationChannelError('INVALID_RECORD', 'Malformed interaction payload');
  if (listPendingInteractions(root, interaction.runId, now).pending.length >= MAX_PENDING_INTERACTIONS) {
    throw new AutomationChannelError('TOO_MANY_PENDING', 'Another interaction is still pending for this run');
  }
  const { interactions } = dirs(root);
  if (!publishOnce(interactions, recordPath(interactions, interaction.interactionId), parsed.data)) {
    throw new AutomationChannelError('INVALID_RECORD', `Interaction ${interaction.interactionId} already exists`);
  }
}

/** Native side: close an interaction (idempotent; first close wins). */
export function closeInteraction(root: string, runId: string, interactionId: string, reason: string): void {
  const { closed } = dirs(root);
  const record = channelCloseSchema.parse({
    closedAt: new Date().toISOString(),
    interactionId,
    reason: reason.slice(0, 256),
    runId
  });
  publishOnce(closed, recordPath(closed, interactionId), record);
}

export type AckOutcome = 'accepted' | 'duplicate';

/**
 * API side: record a driver ACK. Same ACK twice is idempotent; a different
 * ACK conflicts; an unknown, other-run, expired or closed interaction is
 * rejected and can never be resurrected by an ACK.
 */
export function acknowledgeInteraction(
  root: string,
  runId: string,
  interactionId: string,
  ack: { driverStatus: ChannelAck['driverStatus']; message?: string },
  now = new Date()
): AckOutcome {
  const paths = dirs(root);
  if (!SAFE_ID.test(interactionId)) {
    throw new AutomationChannelError('INTERACTION_NOT_FOUND', `Interaction '${interactionId}' not found`);
  }
  // A malformed interaction record throws INVALID_RECORD.
  const interaction = readRecord(recordPath(paths.interactions, interactionId), channelInteractionSchema);
  if (!interaction || interaction.runId !== runId) {
    throw new AutomationChannelError('INTERACTION_NOT_FOUND', `Interaction '${interactionId}' not found`);
  }

  const record: ChannelAck = {
    acknowledgedAt: now.toISOString(),
    driverStatus: ack.driverStatus,
    interactionId,
    ...(ack.message === undefined ? {} : { message: ack.message.slice(0, MAX_ACK_MESSAGE_LENGTH) }),
    runId
  };
  const existing = readAck(root, interactionId);
  if (existing) {
    if (existing.driverStatus === record.driverStatus && existing.message === record.message) return 'duplicate';
    throw new AutomationChannelError(
      'ACK_CONFLICT',
      `Interaction '${interactionId}' was already acknowledged differently`
    );
  }

  if (isClosed(root, interactionId)) {
    throw new AutomationChannelError('INTERACTION_CLOSED', `Interaction '${interactionId}' is closed`);
  }
  if (Date.parse(interaction.expiresAt) <= now.getTime()) {
    throw new AutomationChannelError('INTERACTION_EXPIRED', `Interaction '${interactionId}' has expired`);
  }

  if (!publishOnce(paths.acks, recordPath(paths.acks, interactionId), record)) {
    // Lost a concurrent race: apply the same idempotency rules to the winner.
    const winner = readAck(root, interactionId);
    if (winner && winner.driverStatus === record.driverStatus && winner.message === record.message) return 'duplicate';
    throw new AutomationChannelError(
      'ACK_CONFLICT',
      `Interaction '${interactionId}' was already acknowledged differently`
    );
  }
  // A close that won the race makes this ACK stale: closed interactions
  // never come back, whatever the ACK says.
  if (isClosed(root, interactionId)) {
    throw new AutomationChannelError('INTERACTION_CLOSED', `Interaction '${interactionId}' closed before the ACK`);
  }
  return 'accepted';
}

/** Native side: observe the API's ACK for an interaction, if any. */
export function readAck(root: string, interactionId: string): ChannelAck | undefined {
  return readRecord(recordPath(dirs(root).acks, interactionId), channelAckSchema);
}

/** Native side: persist the scenario verdict exactly once. */
export function recordScenarioOutcome(root: string, outcome: ChannelOutcome): void {
  const parsed = channelOutcomeSchema.safeParse(outcome);
  if (!parsed.success) throw new AutomationChannelError('INVALID_RECORD', 'Malformed scenario outcome');
  const { outcomes } = dirs(root);
  if (!publishOnce(outcomes, recordPath(outcomes, outcome.scenarioId), parsed.data)) {
    throw new AutomationChannelError('OUTCOME_CONFLICT', `Scenario ${outcome.scenarioId} already has a verdict`);
  }
}

export interface ScenarioOutcomesView {
  invalid: number;
  outcomes: ChannelOutcome[];
}

/** API side: the validated native scenario verdicts of this run. */
export function readScenarioOutcomes(root: string, runId: string): ScenarioOutcomesView {
  const { outcomes: directory } = dirs(root);
  const outcomes: ChannelOutcome[] = [];
  let invalid = 0;
  for (const id of listIds(directory)) {
    try {
      const outcome = readRecord(recordPath(directory, id), channelOutcomeSchema);
      if (outcome && outcome.scenarioId === id && outcome.runId === runId) outcomes.push(outcome);
      else invalid++;
    } catch {
      invalid++;
    }
  }
  return { invalid, outcomes };
}
