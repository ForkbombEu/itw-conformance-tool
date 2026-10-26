import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface InteractionRecord {
  ack?: { driver_status: 'completed' | 'failed'; message?: string };
  interaction: {
    correlationId: string;
    expiresAt: string;
    interactionId: string;
    kind: string;
    scenarioId: string;
    uri: string;
  };
  lifecycle: 'acknowledged' | 'closed' | 'pending';
}

const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function safeId(id: string): string {
  if (!SAFE_ID_RE.test(id)) {
    throw new Error(`Invalid interaction ID: ${id}`);
  }
  return id;
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, data, 'utf-8');
  renameSync(tmp, filePath);
}

export function readPendingInteraction(automationDir: string): InteractionRecord | undefined {
  const dir = join(automationDir, 'interactions');
  if (!existsSync(dir)) return undefined;

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const record = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as InteractionRecord;
      if (record.lifecycle === 'pending') return record;
    } catch {
      // skip corrupt
    }
  }
  return undefined;
}

export function writeAck(
  automationDir: string,
  interactionId: string,
  ack: { driver_status: 'completed' | 'failed'; message?: string }
): void {
  const safe = safeId(interactionId);
  const filePath = join(automationDir, 'interactions', `${safe}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`Interaction ${interactionId} not found`);
  }

  const record = JSON.parse(readFileSync(filePath, 'utf-8')) as InteractionRecord;

  if (record.lifecycle === 'closed') return;
  if (record.ack && JSON.stringify(record.ack) === JSON.stringify(ack)) return;
  if (record.ack) throw new Error(`ACK conflict for interaction ${interactionId}`);

  record.lifecycle = 'acknowledged';
  record.ack = ack;
  atomicWrite(filePath, JSON.stringify(record, null, 2));
}

export function writeInteraction(automationDir: string, record: InteractionRecord): void {
  const safe = safeId(record.interaction.interactionId);
  const dir = join(automationDir, 'interactions');
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, `${safe}.json`), JSON.stringify(record, null, 2));
}
