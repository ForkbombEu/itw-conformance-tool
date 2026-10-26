import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { ScenarioOutcome } from '../verdict/outcome.js';
import type { EngagementDriver, EngagementInteraction } from './engagement-driver.js';

export interface FileInteractionRecord {
  interaction: EngagementInteraction;
  lifecycle: 'acknowledged' | 'closed' | 'pending';
  outcome?: ScenarioOutcome;
}

export interface FileEngagementDriverOptions {
  automationDir: string;
  runId: string;
}

const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function safeInteractionId(interactionId: string): string {
  if (!SAFE_ID_RE.test(interactionId)) {
    throw new Error(`Invalid interaction ID: ${interactionId}`);
  }
  return interactionId;
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, data, 'utf-8');
  renameSync(tmp, filePath);
}

export function createFileEngagementDriver(options: FileEngagementDriverOptions): EngagementDriver {
  const interactionsDir = join(options.automationDir, 'interactions');
  const outcomesDir = join(options.automationDir, 'outcomes');

  return {
    async publish(interaction: EngagementInteraction): Promise<void> {
      const safeId = safeInteractionId(interaction.interactionId);
      mkdirSync(interactionsDir, { recursive: true });
      const record: FileInteractionRecord = {
        interaction,
        lifecycle: 'pending'
      };
      atomicWrite(join(interactionsDir, `${safeId}.json`), JSON.stringify(record, null, 2));
    },

    async close(interactionId: string): Promise<void> {
      const safeId = safeInteractionId(interactionId);
      const filePath = join(interactionsDir, `${safeId}.json`);
      if (!existsSync(filePath)) return;

      const raw = readFileSync(filePath, 'utf-8');
      const record = JSON.parse(raw) as FileInteractionRecord;
      record.lifecycle = 'closed';
      atomicWrite(filePath, JSON.stringify(record, null, 2));
    },

    async recordOutcome(outcome: ScenarioOutcome): Promise<void> {
      mkdirSync(outcomesDir, { recursive: true });
      const safeId = safeInteractionId(outcome.testCaseId);
      atomicWrite(join(outcomesDir, `${safeId}.json`), JSON.stringify(outcome, null, 2));
    }
  };
}

// ---------------------------------------------------------------------------
// API-side reader (no conformance runtime imports)
// ---------------------------------------------------------------------------

export function readPendingInteraction(automationDir: string, _runId: string): FileInteractionRecord | undefined {
  const interactionsDir = join(automationDir, 'interactions');
  if (!existsSync(interactionsDir)) return undefined;

  const files = readdirSync(interactionsDir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const raw = readFileSync(join(interactionsDir, file), 'utf-8');
    try {
      const record = JSON.parse(raw) as FileInteractionRecord;
      if (record.lifecycle === 'pending') {
        return record;
      }
    } catch {
      // Skip corrupt files
    }
  }
  return undefined;
}

export function writeAck(
  automationDir: string,
  interactionId: string,
  ack: { driver_status: 'completed' | 'failed'; message?: string }
): void {
  const safeId = safeInteractionId(interactionId);
  const filePath = join(automationDir, 'interactions', `${safeId}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`Interaction ${interactionId} not found`);
  }

  const raw = readFileSync(filePath, 'utf-8');
  const record = JSON.parse(raw) as FileInteractionRecord & { ack?: typeof ack };

  // Close wins over late ACK
  if (record.lifecycle === 'closed') {
    return;
  }

  // Duplicate identical ACK is idempotent
  if (record.ack && JSON.stringify(record.ack) === JSON.stringify(ack)) {
    return;
  }

  // Changed ACK conflicts
  if (record.ack && JSON.stringify(record.ack) !== JSON.stringify(ack)) {
    throw new Error(`ACK conflict for interaction ${interactionId}`);
  }

  record.lifecycle = 'acknowledged';
  record.ack = ack;
  atomicWrite(filePath, JSON.stringify(record, null, 2));
}
