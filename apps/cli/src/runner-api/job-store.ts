import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunRequest, RunStatus } from './contract.js';

export interface StoredRun {
  cancelRequested: boolean;
  createdAt: string;
  idempotencyKeyHash: string;
  namespace: string;
  request: RunRequest;
  requestHash: string;
  runId: string;
  status: RunStatus;
  updatedAt: string;
}

export class JobStore {
  readonly rootDir: string;

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

  private runPath(runId: string): string {
    return join(this.runsDir, `${runId}.json`);
  }

  private indexPath(keyHash: string): string {
    return join(this.indexDir, `${keyHash}.json`);
  }

  static canonicalRequestHash(request: RunRequest): string {
    const canonical = JSON.stringify(request, Object.keys(request).sort());
    return createHash('sha256').update(canonical).digest('hex');
  }

  static keyHash(namespace: string, idempotencyKey: string): string {
    return createHash('sha256').update(`${namespace}\n${idempotencyKey}`).digest('hex');
  }

  saveRun(run: StoredRun): void {
    const target = this.runPath(run.runId);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(run, null, 2), 'utf-8');
    renameSync(tmp, target);
    this.writeIndex(run);
  }

  private writeIndex(run: StoredRun): void {
    const target = this.indexPath(run.idempotencyKeyHash);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify({ keyHash: run.idempotencyKeyHash, runId: run.runId }), 'utf-8');
    renameSync(tmp, target);
  }

  getRun(runId: string): StoredRun | undefined {
    const p = this.runPath(runId);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, 'utf-8')) as StoredRun;
  }

  findByKeyHash(keyHash: string): StoredRun | undefined {
    const ip = this.indexPath(keyHash);
    if (existsSync(ip)) {
      const idx = JSON.parse(readFileSync(ip, 'utf-8')) as { runId: string };
      return this.getRun(idx.runId);
    }
    // Rebuild from authoritative records (crash recovery)
    return this.rebuildFind(keyHash);
  }

  private rebuildFind(keyHash: string): StoredRun | undefined {
    for (const run of this.allRuns()) {
      if (run.idempotencyKeyHash === keyHash) {
        this.writeIndex(run);
        return run;
      }
    }
    return undefined;
  }

  allRuns(): StoredRun[] {
    const runs: StoredRun[] = [];
    for (const f of readdirSync(this.runsDir)) {
      if (f.endsWith('.json') && !f.endsWith('.tmp')) {
        try {
          runs.push(JSON.parse(readFileSync(join(this.runsDir, f), 'utf-8')) as StoredRun);
        } catch {
          // skip corrupt
        }
      }
    }
    return runs;
  }

  rebuildIndex(): void {
    for (const run of this.allRuns()) {
      this.writeIndex(run);
    }
  }

  acquireRootLock(ownerId: string): boolean {
    const lockPath = join(this.rootDir, '.owner.lock');
    if (existsSync(lockPath)) return false;
    writeFileSync(lockPath, ownerId, 'utf-8');
    return true;
  }

  releaseRootLock(): void {
    rmSync(join(this.rootDir, '.owner.lock'), { force: true });
  }

  hasRootLock(): boolean {
    return existsSync(join(this.rootDir, '.owner.lock'));
  }
}

export function generateRunId(): string {
  return randomUUID();
}
