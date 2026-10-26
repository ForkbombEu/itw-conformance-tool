import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readPendingInteraction,
  writeAck,
  writeInteraction,
  type InteractionRecord
} from '../../runner-api/interactions.js';

function makeRecord(overrides: Partial<InteractionRecord> = {}): InteractionRecord {
  return {
    interaction: {
      correlationId: 'corr-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      interactionId: 'int-1',
      kind: 'wallet_deeplink',
      scenarioId: 'WP_RP_HAPPY',
      uri: 'openid4vp://authorize?request_uri=https://rp.example/request'
    },
    lifecycle: 'pending',
    ...overrides
  };
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'wct-interactions-'));
});

afterEach(() => {
  rmSync(tempDir, { force: true, recursive: true });
});

describe('interactions — writeInteraction', () => {
  it('writes interaction to file', () => {
    writeInteraction(tempDir, makeRecord());
    const raw = readFileSync(join(tempDir, 'interactions', 'int-1.json'), 'utf-8');
    const record = JSON.parse(raw);
    expect(record.lifecycle).toBe('pending');
    expect(record.interaction.interactionId).toBe('int-1');
  });

  it('rejects unsafe IDs', () => {
    expect(() =>
      writeInteraction(
        tempDir,
        makeRecord({
          interaction: { ...makeRecord().interaction, interactionId: '../evil' }
        })
      )
    ).toThrow(/Invalid interaction ID/);
  });
});

describe('interactions — readPendingInteraction', () => {
  it('returns pending interaction', () => {
    writeInteraction(tempDir, makeRecord());
    expect(readPendingInteraction(tempDir)?.interaction.interactionId).toBe('int-1');
  });

  it('returns undefined when closed', () => {
    writeInteraction(tempDir, makeRecord({ lifecycle: 'closed' }));
    expect(readPendingInteraction(tempDir)).toBeUndefined();
  });

  it('skips corrupt files', () => {
    mkdirSync(join(tempDir, 'interactions'), { recursive: true });
    writeFileSync(join(tempDir, 'interactions', 'bad.json'), 'not json');
    expect(readPendingInteraction(tempDir)).toBeUndefined();
  });
});

describe('interactions — writeAck', () => {
  it('writes ACK', () => {
    writeInteraction(tempDir, makeRecord());
    writeAck(tempDir, 'int-1', { driver_status: 'completed' });
    const record = JSON.parse(readFileSync(join(tempDir, 'interactions', 'int-1.json'), 'utf-8'));
    expect(record.lifecycle).toBe('acknowledged');
    expect(record.ack.driver_status).toBe('completed');
  });

  it('identical ACK is idempotent', () => {
    writeInteraction(tempDir, makeRecord());
    writeAck(tempDir, 'int-1', { driver_status: 'completed' });
    expect(() => writeAck(tempDir, 'int-1', { driver_status: 'completed' })).not.toThrow();
  });

  it('conflicting ACK throws', () => {
    writeInteraction(tempDir, makeRecord());
    writeAck(tempDir, 'int-1', { driver_status: 'completed' });
    expect(() => writeAck(tempDir, 'int-1', { driver_status: 'failed' })).toThrow(/ACK conflict/);
  });

  it('close wins over late ACK', () => {
    writeInteraction(tempDir, makeRecord({ lifecycle: 'closed' }));
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
