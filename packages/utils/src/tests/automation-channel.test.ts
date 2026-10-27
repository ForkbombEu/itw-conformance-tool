import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acknowledgeInteraction,
  AutomationChannelError,
  closeInteraction,
  listPendingInteractions,
  publishInteraction,
  readAck,
  readScenarioOutcomes,
  recordScenarioOutcome,
  type ChannelInteraction
} from '../automation-channel.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'itwct-channel-'));
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

function interaction(overrides: Partial<ChannelInteraction> = {}): ChannelInteraction {
  const now = Date.now();
  return {
    correlationId: 'corr-1',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    interactionId: 'interaction-1',
    kind: 'wallet_deeplink',
    runId: 'run-1',
    scenarioId: 'WP_RP_HAPPY',
    uri: 'openid4vp://authorize?request_uri=https%3A%2F%2Frp.example%2Frequest',
    ...overrides
  };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof AutomationChannelError ? error.code : 'OTHER';
  }
  return undefined;
}

describe('automation channel', () => {
  it('publishes an immutable interaction visible as pending for its own run only', () => {
    publishInteraction(root, interaction());
    expect(listPendingInteractions(root, 'run-1').pending.map((i) => i.interactionId)).toEqual(['interaction-1']);
    expect(listPendingInteractions(root, 'run-2').pending).toEqual([]);
    expect(codeOf(() => publishInteraction(root, interaction()))).toBe('TOO_MANY_PENDING');
  });

  it('rejects a malformed interaction payload and never lists a malformed file', () => {
    expect(codeOf(() => publishInteraction(root, { ...interaction(), uri: '' }))).toBe('INVALID_RECORD');
    mkdirSync(join(root, 'interactions'), { recursive: true });
    writeFileSync(join(root, 'interactions', 'bogus.json'), '{"runId":"run-1"}');
    const view = listPendingInteractions(root, 'run-1');
    expect(view.pending).toEqual([]);
    expect(view.invalid).toBe(1);
  });

  it('expired interactions are not pending and cannot be acknowledged', () => {
    const past = Date.now() - 1_000;
    publishInteraction(
      root,
      interaction({ createdAt: new Date(past - 1_000).toISOString(), expiresAt: new Date(past).toISOString() })
    );
    expect(listPendingInteractions(root, 'run-1').pending).toEqual([]);
    expect(codeOf(() => acknowledgeInteraction(root, 'run-1', 'interaction-1', { driverStatus: 'completed' }))).toBe(
      'INTERACTION_EXPIRED'
    );
  });

  it('wrong run and unknown IDs are NOT_FOUND', () => {
    publishInteraction(root, interaction());
    expect(codeOf(() => acknowledgeInteraction(root, 'run-2', 'interaction-1', { driverStatus: 'completed' }))).toBe(
      'INTERACTION_NOT_FOUND'
    );
    expect(codeOf(() => acknowledgeInteraction(root, 'run-1', '../x', { driverStatus: 'completed' }))).toBe(
      'INTERACTION_NOT_FOUND'
    );
    expect(codeOf(() => acknowledgeInteraction(root, 'run-1', 'missing', { driverStatus: 'completed' }))).toBe(
      'INTERACTION_NOT_FOUND'
    );
  });

  it('duplicate identical ACK is idempotent; a changed ACK conflicts; the native side observes it', () => {
    publishInteraction(root, interaction());
    expect(acknowledgeInteraction(root, 'run-1', 'interaction-1', { driverStatus: 'completed', message: 'ok' })).toBe(
      'accepted'
    );
    expect(acknowledgeInteraction(root, 'run-1', 'interaction-1', { driverStatus: 'completed', message: 'ok' })).toBe(
      'duplicate'
    );
    expect(codeOf(() => acknowledgeInteraction(root, 'run-1', 'interaction-1', { driverStatus: 'failed' }))).toBe(
      'ACK_CONFLICT'
    );
    expect(readAck(root, 'interaction-1')?.driverStatus).toBe('completed');
    // ACK does not remove the pending interaction; only the native close does.
    expect(listPendingInteractions(root, 'run-1').pending).toHaveLength(1);
  });

  it('close wins over a later ACK and a closed interaction is never resurrected', () => {
    publishInteraction(root, interaction());
    closeInteraction(root, 'run-1', 'interaction-1', 'verdict');
    closeInteraction(root, 'run-1', 'interaction-1', 'second close is a no-op');
    expect(listPendingInteractions(root, 'run-1').pending).toEqual([]);
    expect(codeOf(() => acknowledgeInteraction(root, 'run-1', 'interaction-1', { driverStatus: 'failed' }))).toBe(
      'INTERACTION_CLOSED'
    );
    expect(readAck(root, 'interaction-1')).toBeUndefined();
    expect(listPendingInteractions(root, 'run-1').pending).toEqual([]);
  });

  it('concurrent ACK and close never lose either record', async () => {
    for (let i = 0; i < 20; i++) {
      const id = `interaction-race-${i}`;
      publishInteraction(root, interaction({ interactionId: id, runId: `run-race-${i}` }));
      const results = await Promise.allSettled([
        Promise.resolve().then(() => acknowledgeInteraction(root, `run-race-${i}`, id, { driverStatus: 'completed' })),
        Promise.resolve().then(() => closeInteraction(root, `run-race-${i}`, id, 'verdict'))
      ]);
      expect(results[1]?.status).toBe('fulfilled');
      // Close is always durable; pending never comes back.
      expect(listPendingInteractions(root, `run-race-${i}`).pending).toEqual([]);
      if (results[0]?.status === 'fulfilled') expect(readAck(root, id)?.driverStatus).toBe('completed');
    }
    // No temp files remain.
    for (const dir of ['interactions', 'acks', 'closed']) {
      expect(readdirSync(join(root, dir)).some((f) => f.includes('.tmp-'))).toBe(false);
    }
  });

  it('records each scenario outcome once and reads only this run’s valid outcomes', () => {
    const outcome = {
      completedAt: new Date().toISOString(),
      reason: 'The wallet did not request the Request Object.',
      runId: 'run-1',
      scenarioId: 'WP_RP_HAPPY',
      verdict: 'INCONCLUSIVE' as const
    };
    recordScenarioOutcome(root, outcome);
    expect(codeOf(() => recordScenarioOutcome(root, { ...outcome, verdict: 'PASS' }))).toBe('OUTCOME_CONFLICT');
    writeFileSync(join(root, 'outcomes', 'WP_090.json'), '{bad json');
    const view = readScenarioOutcomes(root, 'run-1');
    expect(view.outcomes).toEqual([outcome]);
    expect(view.invalid).toBe(1);
    expect(readScenarioOutcomes(root, 'run-2').outcomes).toEqual([]);
  });
});
