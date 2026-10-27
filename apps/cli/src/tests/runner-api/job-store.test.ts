import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JobStore, type StoredRun } from '../../runner-api/job-store.js';

import type { RunRequest } from '../../runner-api/contract.js';

const KEY_HASH_1 = JobStore.keyHash('default', 'key-1');
const KEY_HASH_2 = JobStore.keyHash('default', 'key-2');

function makeRequest(): RunRequest {
  return {
    category: 'presentation',
    contract_version: '1.0',
    parameters: {},
    profile_id: 'test',
    selection: { ids: ['WP_RP_HAPPY'] },
    target: { actor_name: 'x', actor_type: 'wallet' },
    timeout_ms: 600_000
  };
}

function makeRun(overrides: Partial<StoredRun> = {}): StoredRun {
  const request = makeRequest();
  return {
    cancelRequested: false,
    createdAt: '2026-01-01T00:00:00Z',
    idempotencyKeyHash: KEY_HASH_1,
    namespace: 'default',
    request,
    requestHash: JobStore.canonicalRequestHash(request),
    runId: 'run-1',
    status: 'queued',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides
  };
}

let dir: string;
let store: JobStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wct-store-'));
  store = new JobStore(dir);
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe('JobStore — persist and retrieve', () => {
  it('saves and reads a run', () => {
    store.saveRun(makeRun());
    expect(store.getRun('run-1')).toBeDefined();
    expect(store.getRun('run-1')?.runId).toBe('run-1');
  });

  it('persists across store instances', () => {
    store.saveRun(makeRun());
    const reopened = new JobStore(dir);
    expect(reopened.getRun('run-1')).toBeDefined();
  });

  it('returns undefined for unknown run', () => {
    expect(store.getRun('nonexistent')).toBeUndefined();
  });
});

describe('JobStore — idempotency index', () => {
  it('finds by key hash', () => {
    store.saveRun(makeRun());
    expect(store.findByKeyHash(KEY_HASH_1)?.runId).toBe('run-1');
  });

  it('rebuilds index from records after crash', () => {
    store.saveRun(makeRun());
    rmSync(join(dir, 'index', `${KEY_HASH_1}.json`), { force: true });
    expect(store.findByKeyHash(KEY_HASH_1)?.runId).toBe('run-1');
    expect(existsSync(join(dir, 'index', `${KEY_HASH_1}.json`))).toBe(true);
  });

  it('rebuildIndex restores all indexes', () => {
    store.saveRun(makeRun());
    store.saveRun(makeRun({ idempotencyKeyHash: KEY_HASH_2, runId: 'run-2' }));
    rmSync(join(dir, 'index'), { force: true, recursive: true });
    mkdirSync(join(dir, 'index'), { recursive: true });
    store.rebuildIndex();
    expect(store.findByKeyHash(KEY_HASH_1)?.runId).toBe('run-1');
    expect(store.findByKeyHash(KEY_HASH_2)?.runId).toBe('run-2');
  });
});

describe('JobStore — canonical hashing', () => {
  it('stable hash for same request', () => {
    const req = makeRequest();
    expect(JobStore.canonicalRequestHash(req)).toBe(JobStore.canonicalRequestHash(req));
  });

  it('different requests produce different hashes', () => {
    const a = makeRequest();
    const b = { ...makeRequest(), profile_id: 'other' };
    expect(JobStore.canonicalRequestHash(a)).not.toBe(JobStore.canonicalRequestHash(b));
  });

  it('key hash incorporates namespace and key', () => {
    expect(JobStore.keyHash('ns1', 'k1')).not.toBe(JobStore.keyHash('ns2', 'k1'));
  });
});

describe('JobStore — root lock', () => {
  it('acquires and releases', () => {
    expect(store.acquireRootLock()).toBe(true);
    expect(store.hasRootLock()).toBe(true);
    expect(store.releaseRootLock()).toBe(true);
    expect(store.hasRootLock()).toBe(false);
  });

  it('denies second acquisition', () => {
    const other = new JobStore(dir);
    expect(store.acquireRootLock()).toBe(true);
    expect(other.acquireRootLock()).toBe(false);
    store.releaseRootLock();
    expect(other.acquireRootLock()).toBe(true);
    other.releaseRootLock();
  });
});

describe('JobStore — atomic writes', () => {
  it('no tmp files remain', () => {
    store.saveRun(makeRun());
    const files = readdirSync(join(dir, 'runs'));
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(files).toContain('run-1.json');
  });
});

function existsSync(p: string): boolean {
  return require('node:fs').existsSync(p);
}
