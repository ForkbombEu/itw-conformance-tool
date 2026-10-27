import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { RunnerError, runRequestSchema, runStatusSchema } from './contract.js';

import type { RunRequest, RunnerResult, RunStatus } from './contract.js';

/** Current request hash algorithm: recursive key sort (nested keys and array order significant). */
export const REQUEST_HASH_VERSION = 2;

const storedRunSchema = z.strictObject({
  cancelRequested: z.boolean(),
  createdAt: z.string(),
  idempotencyKeyHash: z.string().regex(/^[a-f0-9]{64}$/),
  namespace: z.string(),
  request: runRequestSchema,
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  requestHashVersion: z.literal(REQUEST_HASH_VERSION).optional(),
  // Shape-checked here; the full wire schema is enforced when results are
  // finalized for publication (N14), so older evidence remains readable.
  result: z
    .custom<RunnerResult>(
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { run_id?: unknown }).run_id === 'string' &&
        typeof (value as { execution?: { status?: unknown } }).execution?.status === 'string'
    )
    .optional(),
  runId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  status: runStatusSchema,
  updatedAt: z.string()
});

export interface StoredRun {
  cancelRequested: boolean;
  createdAt: string;
  idempotencyKeyHash: string;
  namespace: string;
  request: RunRequest;
  requestHash: string;
  requestHashVersion?: typeof REQUEST_HASH_VERSION;
  result?: RunnerResult;
  runId: string;
  status: RunStatus;
  updatedAt: string;
}

export interface QuarantinedRecord {
  file: string;
  /** Key hash recovered from the corrupt record, if any (never raw content). */
  keyHash?: string;
  reason: string;
}

interface IndexEntry {
  keyHash: string;
  quarantined?: boolean;
  runId: string;
}

interface LockFile {
  createdAt: string;
  host: string;
  pid: number;
  token: string;
}

export function corruptRecord(runId: string): RunnerError {
  return new RunnerError(
    'RUN_RECORD_CORRUPT',
    500,
    `Run record '${runId}' is corrupt and was quarantined; its idempotency key cannot start new work`
  );
}

export class JobStore {
  readonly rootDir: string;
  private ownerToken: string | undefined;
  private readonly quarantine: QuarantinedRecord[] = [];

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    mkdirSync(this.runsDir, { recursive: true });
    mkdirSync(this.indexDir, { recursive: true });
  }

  private get runsDir(): string {
    return join(this.rootDir, 'runs');
  }

  private get indexDir(): string {
    return join(this.rootDir, 'index');
  }

  private get quarantineDir(): string {
    return join(this.rootDir, 'quarantine');
  }

  private get lockPath(): string {
    return join(this.rootDir, '.owner.lock');
  }

  private runPath(runId: string): string {
    return join(this.runsDir, `${runId}.json`);
  }

  private indexPath(keyHash: string): string {
    return join(this.indexDir, `${keyHash}.json`);
  }

  static canonicalRequestHash(request: RunRequest): string {
    const canonical = JSON.stringify(sortKeysDeep(request));
    return createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * The previous, lossy algorithm (a top-level replacer array that drops every
   * nested key). Used only to recognise records written before the migration.
   */
  static legacyRequestHash(request: RunRequest): string {
    const canonical = JSON.stringify(request, Object.keys(request).sort());
    return createHash('sha256').update(canonical).digest('hex');
  }

  static keyHash(namespace: string, idempotencyKey: string): string {
    return createHash('sha256').update(`${namespace}\n${idempotencyKey}`).digest('hex');
  }

  saveRun(run: StoredRun): void {
    const target = this.runPath(run.runId);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...run, requestHashVersion: REQUEST_HASH_VERSION }, null, 2), 'utf-8');
    renameSync(tmp, target);
    this.writeIndex({ keyHash: run.idempotencyKeyHash, runId: run.runId });
  }

  private writeIndex(entry: IndexEntry): void {
    const target = this.indexPath(entry.keyHash);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry), 'utf-8');
    renameSync(tmp, target);
  }

  /** Reads and validates one authoritative record; corrupt records raise RUN_RECORD_CORRUPT. */
  getRun(runId: string): StoredRun | undefined {
    const p = this.runPath(runId);
    if (!existsSync(p)) {
      if (this.quarantine.some((q) => q.file === `${runId}.json`)) throw corruptRecord(runId);
      return undefined;
    }
    const parsed = storedRunSchema.safeParse(safeJson(readFileSync(p, 'utf-8')));
    if (!parsed.success) throw corruptRecord(runId);
    return parsed.data;
  }

  findByKeyHash(keyHash: string): StoredRun | undefined {
    const ip = this.indexPath(keyHash);
    if (existsSync(ip)) {
      const idx = safeJson(readFileSync(ip, 'utf-8')) as Partial<IndexEntry> | undefined;
      if (!idx?.runId) throw corruptRecord(keyHash.slice(0, 12));
      if (idx.quarantined) throw corruptRecord(idx.runId);
      const run = this.getRun(idx.runId);
      if (!run) throw corruptRecord(idx.runId);
      return run;
    }
    // Index entry lost (crash between record and index write): rebuild it
    // from the authoritative records, honouring quarantined tombstones.
    const quarantined = this.quarantine.find((q) => q.keyHash === keyHash);
    if (quarantined) throw corruptRecord(quarantined.file.slice(0, -'.json'.length));
    const run = this.allRuns().find((candidate) => candidate.idempotencyKeyHash === keyHash);
    if (run) this.writeIndex({ keyHash, runId: run.runId });
    return run;
  }

  allRuns(): StoredRun[] {
    const runs: StoredRun[] = [];
    for (const f of readdirSync(this.runsDir)) {
      if (!f.endsWith('.json')) continue;
      const parsed = storedRunSchema.safeParse(safeJson(readFileSync(join(this.runsDir, f), 'utf-8')));
      if (parsed.success) runs.push(parsed.data);
    }
    return runs;
  }

  quarantinedRecords(): QuarantinedRecord[] {
    return [...this.quarantine];
  }

  /**
   * Validates every authoritative record, migrates legacy request hashes using
   * the stored request, quarantines corrupt records (keeping a tombstone index
   * entry so their key can never start new work) and rebuilds the index.
   */
  rebuildIndex(): void {
    for (const file of readdirSync(this.runsDir)) {
      if (!file.endsWith('.json')) continue;
      const path = join(this.runsDir, file);
      const raw = safeJson(readFileSync(path, 'utf-8'));
      const parsed = storedRunSchema.safeParse(raw);
      if (!parsed.success || `${parsed.data.runId}.json` !== file) {
        this.quarantineRecord(file, raw, parsed.success ? 'record/file run ID mismatch' : 'schema validation failed');
        continue;
      }
      const run = parsed.data;
      if (run.requestHashVersion !== REQUEST_HASH_VERSION) {
        const current = JobStore.canonicalRequestHash(run.request);
        if (run.requestHash !== current && run.requestHash !== JobStore.legacyRequestHash(run.request)) {
          this.quarantineRecord(file, raw, 'request hash matches neither the current nor the legacy algorithm');
          continue;
        }
        // Recompute from the authoritative stored request; run ID, target,
        // result and idempotency namespace/key are preserved unchanged.
        this.saveRun({ ...run, requestHash: current, requestHashVersion: REQUEST_HASH_VERSION });
        continue;
      }
      this.writeIndex({ keyHash: run.idempotencyKeyHash, runId: run.runId });
    }
    // Index entries that point at quarantined runs stay as tombstones.
    for (const file of readdirSync(this.indexDir)) {
      if (!file.endsWith('.json')) continue;
      const entry = safeJson(readFileSync(join(this.indexDir, file), 'utf-8')) as Partial<IndexEntry> | undefined;
      const runId = entry?.runId;
      if (runId && this.quarantine.some((q) => q.file === `${runId}.json`) && !entry.quarantined) {
        this.writeIndex({ keyHash: file.slice(0, -'.json'.length), quarantined: true, runId });
      }
    }
  }

  private quarantineRecord(file: string, raw: unknown, reason: string): void {
    mkdirSync(this.quarantineDir, { recursive: true });
    renameSync(join(this.runsDir, file), join(this.quarantineDir, file));
    const keyHash =
      raw && typeof raw === 'object' && typeof (raw as { idempotencyKeyHash?: unknown }).idempotencyKeyHash === 'string'
        ? (raw as { idempotencyKeyHash: string }).idempotencyKeyHash
        : undefined;
    const runId = file.slice(0, -'.json'.length);
    if (keyHash && /^[a-f0-9]{64}$/.test(keyHash)) this.writeIndex({ keyHash, quarantined: true, runId });
    this.quarantine.push({ file, ...(keyHash ? { keyHash } : {}), reason });
  }

  /**
   * Takes exclusive ownership of the state root with an unpredictable token.
   * An existing lock is never removed automatically: if its holder is gone,
   * the operator must delete it after checking (see lockHolder()).
   */
  acquireRootLock(): boolean {
    if (this.ownerToken) return true;
    const token = randomUUID();
    const lock: LockFile = { createdAt: new Date().toISOString(), host: hostname(), pid: process.pid, token };
    try {
      const fd = openSync(this.lockPath, 'wx', 0o600);
      try {
        writeSync(fd, JSON.stringify(lock));
      } finally {
        closeSync(fd);
      }
    } catch {
      return false;
    }
    this.ownerToken = token;
    return true;
  }

  /** Describes the current lock holder (no secrets) for a clear startup error. */
  lockHolder(): string {
    const lock = safeJson(existsSync(this.lockPath) ? readFileSync(this.lockPath, 'utf-8') : '') as
      Partial<LockFile> | undefined;
    return lock?.pid ? `pid ${lock.pid} on ${lock.host ?? 'unknown host'} since ${lock.createdAt ?? '?'}` : 'unknown';
  }

  ownsRootLock(): boolean {
    if (!this.ownerToken || !existsSync(this.lockPath)) return false;
    const lock = safeJson(readFileSync(this.lockPath, 'utf-8')) as Partial<LockFile> | undefined;
    return lock?.token === this.ownerToken;
  }

  /** Releases the lock only if this store owns it; safe to call repeatedly. */
  releaseRootLock(): boolean {
    if (!this.ownsRootLock()) {
      this.ownerToken = undefined;
      return false;
    }
    rmSync(this.lockPath, { force: true });
    this.ownerToken = undefined;
    return true;
  }

  hasRootLock(): boolean {
    return existsSync(this.lockPath);
  }

  workDir(runId: string): string {
    return join(this.rootDir, 'work', runId);
  }
}

export function generateRunId(): string {
  return randomUUID();
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sortKeysDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (obj !== null && typeof obj === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}
