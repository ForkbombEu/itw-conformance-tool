import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileEngagementDriver, readPendingInteraction, writeAck } from './file-engagement-driver.js';

import type { EngagementInteraction } from './engagement-driver.js';

function makeInteraction(overrides: Partial<EngagementInteraction> = {}): EngagementInteraction {
  return {
    correlationId: 'corr-1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    interactionId: 'int-1',
    kind: 'wallet_deeplink',
    scenarioId: 'WP_RP_HAPPY',
    uri: 'openid4vp://authorize?request_uri=https://rp.example/request',
    ...overrides
  };
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'wct-file-drv-'));
});

afterEach(() => {
  rmSync(tempDir, { force: true, recursive: true });
});

describe('file engagement driver — publish', () => {
  it('publishes interaction to file', async () => {
    const driver = createFileEngagementDriver({ automationDir: tempDir, runId: 'run-1' });
    await driver.publish(makeInteraction());

    const filePath = join(tempDir, 'interactions', 'int-1.json');
    expect(existsSync(filePath)).toBe(true);

    const record = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(record.lifecycle).toBe('pending');
    expect(record.interaction.interactionId).toBe('int-1');
  });

  it('preserves original URI exactly', async () => {
    const uri = 'openid4vp://authorize?request_uri=https://rp.example/request%3Ffoo%3Dbar';
    const driver = createFileEngagementDriver({ automationDir: tempDir, runId: 'run-1' });
    await driver.publish(makeInteraction({ uri }));

    const record = JSON.parse(readFileSync(join(tempDir, 'interactions', 'int-1.json'), 'utf-8'));
    expect(record.interaction.uri).toBe(uri);
  });

  it('rejects unsafe interaction IDs', async () => {
    const driver = createFileEngagementDriver({ automationDir: tempDir, runId: 'run-1' });
    await expect(driver.publish(makeInteraction({ interactionId: '../evil' }))).rejects.toThrow(
      /Invalid interaction ID/
    );
  });
});

describe('file engagement driver — close', () => {
  it('closes an interaction', async () => {
    const driver = createFileEngagementDriver({ automationDir: tempDir, runId: 'run-1' });
    await driver.publish(makeInteraction());
    await driver.close('int-1');

    const record = JSON.parse(readFileSync(join(tempDir, 'interactions', 'int-1.json'), 'utf-8'));
    expect(record.lifecycle).toBe('closed');
  });

  it('close is idempotent', async () => {
    const driver = createFileEngagementDriver({ automationDir: tempDir, runId: 'run-1' });
    await driver.publish(makeInteraction());
    await driver.close('int-1');
    await driver.close('int-1');

    const record = JSON.parse(readFileSync(join(tempDir, 'interactions', 'int-1.json'), 'utf-8'));
    expect(record.lifecycle).toBe('closed');
  });
});

describe('file engagement driver — recordOutcome', () => {
  it('writes outcome to outcomes directory', async () => {
    const driver = createFileEngagementDriver({ automationDir: tempDir, runId: 'run-1' });
    await driver.recordOutcome?.({
      evidence: [],
      forbiddenEvidence: [],
      missingEvidence: [],
      reason: 'test',
      testCaseId: 'test-1',
      timings: { completedAt: new Date().toISOString(), durationMs: 100, startedAt: new Date().toISOString() },
      verdict: 'PASS'
    });

    const filePath = join(tempDir, 'outcomes', 'test-1.json');
    expect(existsSync(filePath)).toBe(true);
  });
});

describe('file engagement driver — readPendingInteraction', () => {
  it('returns pending interaction', async () => {
    const driver = createFileEngagementDriver({ automationDir: tempDir, runId: 'run-1' });
    await driver.publish(makeInteraction());

    const record = readPendingInteraction(tempDir, 'run-1');
    expect(record).toBeDefined();
    expect(record?.interaction.interactionId).toBe('int-1');
  });

  it('returns undefined when no pending interactions', async () => {
    const driver = createFileEngagementDriver({ automationDir: tempDir, runId: 'run-1' });
    await driver.publish(makeInteraction());
    await driver.close('int-1');

    expect(readPendingInteraction(tempDir, 'run-1')).toBeUndefined();
  });

  it('skips corrupt JSON files', async () => {
    mkdirSync(join(tempDir, 'interactions'), { recursive: true });
    writeFileSync(join(tempDir, 'interactions', 'corrupt.json'), 'not json');

    expect(readPendingInteraction(tempDir, 'run-1')).toBeUndefined();
  });
});

describe('file engagement driver — writeAck', () => {
  it('writes ACK for pending interaction', async () => {
    const driver = createFileEngagementDriver({ automationDir: tempDir, runId: 'run-1' });
    await driver.publish(makeInteraction());

    writeAck(tempDir, 'int-1', { driver_status: 'completed' });

    const record = JSON.parse(readFileSync(join(tempDir, 'interactions', 'int-1.json'), 'utf-8'));
    expect(record.lifecycle).toBe('acknowledged');
    expect(record.ack.driver_status).toBe('completed');
  });

  it('identical ACK replay is idempotent', async () => {
    const driver = createFileEngagementDriver({ automationDir: tempDir, runId: 'run-1' });
    await driver.publish(makeInteraction());

    writeAck(tempDir, 'int-1', { driver_status: 'completed' });
    expect(() => writeAck(tempDir, 'int-1', { driver_status: 'completed' })).not.toThrow();
  });

  it('conflicting ACK throws', async () => {
    const driver = createFileEngagementDriver({ automationDir: tempDir, runId: 'run-1' });
    await driver.publish(makeInteraction());

    writeAck(tempDir, 'int-1', { driver_status: 'completed' });
    expect(() => writeAck(tempDir, 'int-1', { driver_status: 'failed' })).toThrow(/ACK conflict/);
  });

  it('close wins over late ACK', async () => {
    const driver = createFileEngagementDriver({ automationDir: tempDir, runId: 'run-1' });
    await driver.publish(makeInteraction());
    await driver.close('int-1');

    writeAck(tempDir, 'int-1', { driver_status: 'completed' });
    const record = JSON.parse(readFileSync(join(tempDir, 'interactions', 'int-1.json'), 'utf-8'));
    expect(record.lifecycle).toBe('closed');
  });

  it('throws for unknown interaction', () => {
    expect(() => writeAck(tempDir, 'nonexistent', { driver_status: 'completed' })).toThrow(/not found/);
  });

  it('rejects traversal IDs', () => {
    expect(() => writeAck(tempDir, '../evil', { driver_status: 'completed' })).toThrow(/Invalid interaction ID/);
  });
});

describe('file engagement driver — atomic writes', () => {
  it('readers never see partially written files', async () => {
    const driver = createFileEngagementDriver({ automationDir: tempDir, runId: 'run-1' });
    await driver.publish(makeInteraction());

    // Read immediately after publish — should be complete JSON
    const raw = readFileSync(join(tempDir, 'interactions', 'int-1.json'), 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
