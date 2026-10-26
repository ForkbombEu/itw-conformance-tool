import { describe, expect, it } from 'vitest';

import type { ScenarioOutcome } from '../verdict/outcome.js';
import type { EngagementDriver, EngagementInteraction } from './engagement-driver.js';

function makeMockDriver(): EngagementDriver & {
  closeCalls: string[];
  publishCalls: EngagementInteraction[];
  recordOutcomeCalls: ScenarioOutcome[];
} {
  const closeCalls: string[] = [];
  const publishCalls: EngagementInteraction[] = [];
  const recordOutcomeCalls: ScenarioOutcome[] = [];

  return {
    closeCalls,
    publishCalls,
    recordOutcomeCalls,
    async close(interactionId: string) {
      closeCalls.push(interactionId);
    },
    async publish(interaction: EngagementInteraction) {
      publishCalls.push(interaction);
    },
    async recordOutcome(outcome: ScenarioOutcome) {
      recordOutcomeCalls.push(outcome);
    }
  };
}

describe('EngagementDriver interface', () => {
  it('has publish and close methods', () => {
    const driver = makeMockDriver();
    expect(typeof driver.publish).toBe('function');
    expect(typeof driver.close).toBe('function');
  });

  it('recordOutcome is optional', () => {
    const driver: EngagementDriver = {
      async close() {
        /* no-op */
      },
      async publish() {
        /* no-op */
      }
    };
    expect(driver.recordOutcome).toBeUndefined();
  });
});

describe('EngagementInteraction shape', () => {
  it('has required fields', () => {
    const interaction: EngagementInteraction = {
      correlationId: 'corr-1',
      expiresAt: new Date().toISOString(),
      interactionId: 'int-1',
      kind: 'wallet_deeplink',
      scenarioId: 'WP_RP_HAPPY',
      uri: 'openid4vp://authorize?request_uri=https://rp.example/request'
    };
    expect(interaction.interactionId).toBe('int-1');
    expect(interaction.kind).toBe('wallet_deeplink');
    expect(interaction.scenarioId).toBe('WP_RP_HAPPY');
    expect(interaction.uri).toBeTruthy();
    expect(interaction.expiresAt).toBeTruthy();
    expect(interaction.correlationId).toBe('corr-1');
  });

  it('supports all interaction kinds', () => {
    const kinds: EngagementInteraction['kind'][] = ['wallet_deeplink', 'wallet_qr', 'browser_authorization'];
    for (const kind of kinds) {
      const interaction: EngagementInteraction = {
        correlationId: 'c',
        expiresAt: 'x',
        interactionId: 'i',
        kind,
        scenarioId: 's',
        uri: 'u'
      };
      expect(interaction.kind).toBe(kind);
    }
  });
});

describe('mock driver behavior', () => {
  it('records publish calls', async () => {
    const driver = makeMockDriver();
    await driver.publish({
      correlationId: 'c',
      expiresAt: 'x',
      interactionId: 'i',
      kind: 'wallet_deeplink',
      scenarioId: 's',
      uri: 'u'
    });
    expect(driver.publishCalls).toHaveLength(1);
    expect(driver.publishCalls[0]?.interactionId).toBe('i');
  });

  it('records close calls', async () => {
    const driver = makeMockDriver();
    await driver.close('int-1');
    expect(driver.closeCalls).toContain('int-1');
  });

  it('records outcome calls', async () => {
    const driver = makeMockDriver();
    const outcome: ScenarioOutcome = {
      evidence: [],
      forbiddenEvidence: [],
      missingEvidence: [],
      reason: 'test',
      testCaseId: 'test-1',
      timings: {
        completedAt: new Date().toISOString(),
        durationMs: 100,
        startedAt: new Date().toISOString()
      },
      verdict: 'PASS'
    };
    await driver.recordOutcome?.(outcome);
    expect(driver.recordOutcomeCalls).toHaveLength(1);
    expect(driver.recordOutcomeCalls[0]?.verdict).toBe('PASS');
  });

  it('publish error propagates to caller', async () => {
    const driver: EngagementDriver = {
      async close() {
        /* no-op */
      },
      async publish() {
        throw new Error('publish failed');
      }
    };
    await expect(
      driver.publish({
        correlationId: 'c',
        expiresAt: 'x',
        interactionId: 'i',
        kind: 'wallet_deeplink',
        scenarioId: 's',
        uri: 'u'
      })
    ).rejects.toThrow('publish failed');
  });
});
