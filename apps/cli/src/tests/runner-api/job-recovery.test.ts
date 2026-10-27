import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serveRunner } from '../../commands/serveRunner.js';
import { runnerResultSchema } from '../../runner-api/contract.js';
import { JobManager } from '../../runner-api/job-manager.js';
import { JobStore, type StoredRun } from '../../runner-api/job-store.js';
import { writeNativeChildMarker } from '../../runner-api/native-child-marker.js';
import { createOperatorFixture, writeProfilesFile } from './helpers/operator-fixture.js';

import type { RunnerResult, RunRequest } from '../../runner-api/contract.js';
import type { ExecuteFn } from '../../runner-api/job-manager.js';

const root = mkdtempSync(join(tmpdir(), 'itwct-recovery-'));
let profilesPath: string;
let counter = 0;

beforeAll(async () => {
  const fixture = await createOperatorFixture(join(root, 'operator'));
  profilesPath = writeProfilesFile(join(root, 'profiles.json'), [
    {
      allowedScenarioIds: ['WP_RP_HAPPY'],
      category: 'presentation',
      configPath: fixture.configPath,
      coverageMode: 'interoperability',
      id: 'test',
      initializedAssetsDir: fixture.assetsDir
    }
  ]);
  process.env.CREDIMI_RUNNER_TOKEN = 'recovery-token';
}, 60_000);

afterAll(() => {
  Reflect.deleteProperty(process.env, 'CREDIMI_RUNNER_TOKEN');
  rmSync(root, { force: true, recursive: true });
});

function freshStateDir(): string {
  const dir = join(root, `state-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function request(actorName = 'wallet-a', ids = ['WP_RP_HAPPY']): RunRequest {
  return {
    category: 'presentation',
    contract_version: '1.0',
    parameters: {},
    profile_id: 'test',
    selection: { ids },
    target: { actor_name: actorName, actor_type: 'wallet', actor_version: '1.0.0' },
    timeout_ms: 600_000
  };
}

/** The PREVIOUS request hash: a top-level replacer array (drops nested keys). */
function legacyHash(req: RunRequest): string {
  return createHash('sha256')
    .update(JSON.stringify(req, Object.keys(req).sort()))
    .digest('hex');
}

function completedResult(runId: string, req: RunRequest): RunnerResult {
  return {
    artifacts: [],
    category: 'presentation',
    contract_version: '1.0',
    engine: {
      fork_repository: 'x',
      id: 'pagopa-itwct',
      revision: 'unknown',
      upstream_repository: 'x',
      version: '0.0.1'
    },
    execution: { finished_at: '2026-10-01T00:00:01.000Z', started_at: '2026-10-01T00:00:00.000Z', status: 'completed' },
    limitations: [],
    native: {
      assertions: [
        {
          ancestor_titles: ['Suite'],
          assertion_id: 'a0001',
          file: 'presentation.test.ts',
          full_title: 'Suite > [WP_082]: x',
          native_status: 'FAIL',
          phase: 'presentation',
          requirement_id: 'WP_082'
        }
      ],
      coverage_mode: 'interoperability',
      native_suite_status: 'FAILED',
      scenario_outcomes: [],
      sessions: [{ id: 'session-old', status: 'FAILED' }]
    },
    profile_id: 'test',
    run_id: runId,
    selection: req.selection,
    summary: { assertion_count: 1, native_failed_assertion_count: 1, result: 'fail' },
    target: req.target
  };
}

/** Seeds a record exactly as the previous code persisted it (old hash, no hash version). */
function seedLegacyRun(
  stateDir: string,
  runId: string,
  key: string,
  req: RunRequest,
  status: StoredRun['status']
): void {
  mkdirSync(join(stateDir, 'runs'), { recursive: true });
  mkdirSync(join(stateDir, 'index'), { recursive: true });
  const keyHash = JobStore.keyHash('default', key);
  const record = {
    cancelRequested: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    idempotencyKeyHash: keyHash,
    namespace: 'default',
    request: req,
    requestHash: legacyHash(req),
    ...(status === 'completed' ? { result: completedResult(runId, req) } : {}),
    runId,
    status,
    updatedAt: '2026-10-01T00:00:01.000Z'
  };
  writeFileSync(join(stateDir, 'runs', `${runId}.json`), JSON.stringify(record, null, 2));
  writeFileSync(join(stateDir, 'index', `${keyHash}.json`), JSON.stringify({ keyHash, runId }));
}

const neverExecute: ExecuteFn = async () => {
  throw new Error('no new work may launch in these tests');
};

describe('root-lock ownership', () => {
  it('a second actual server on the same root fails and its failed start does not delete the first lock', async () => {
    const stateDir = freshStateDir();
    const first = await serveRunner({ host: '127.0.0.1', port: 0, profiles: profilesPath, stateDir });
    const lockBefore = readFileSync(join(stateDir, '.owner.lock'), 'utf-8');
    await expect(serveRunner({ host: '127.0.0.1', port: 0, profiles: profilesPath, stateDir })).rejects.toThrow(
      /locked/
    );
    expect(readFileSync(join(stateDir, '.owner.lock'), 'utf-8')).toBe(lockBefore);
    await first.close();
    expect(existsSync(join(stateDir, '.owner.lock'))).toBe(false);
    const second = await serveRunner({ host: '127.0.0.1', port: 0, profiles: profilesPath, stateDir });
    await second.close();
  });

  it('a store that never acquired the lock cannot remove it; the owner releases exactly once', () => {
    const stateDir = freshStateDir();
    const owner = new JobStore(stateDir);
    const other = new JobStore(stateDir);
    expect(owner.acquireRootLock()).toBe(true);
    expect(other.acquireRootLock()).toBe(false);
    expect(other.releaseRootLock()).toBe(false);
    expect(existsSync(join(stateDir, '.owner.lock'))).toBe(true);
    expect(owner.releaseRootLock()).toBe(true);
    expect(owner.releaseRootLock()).toBe(false);
    expect(existsSync(join(stateDir, '.owner.lock'))).toBe(false);
  });

  it('shutting down a manager does not release a lock its store does not own', async () => {
    const stateDir = freshStateDir();
    const owner = new JobStore(stateDir);
    expect(owner.acquireRootLock()).toBe(true);
    const foreign = new JobManager({ execute: neverExecute, store: new JobStore(stateDir) });
    await foreign.shutdown();
    expect(existsSync(join(stateDir, '.owner.lock'))).toBe(true);
    owner.releaseRootLock();
  });

  it('a startup error after taking the lock releases only the owned lock', async () => {
    const stateDir = freshStateDir();
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await expect(serveRunner({ host: '127.0.0.1', port, profiles: profilesPath, stateDir })).rejects.toThrow();
    expect(existsSync(join(stateDir, '.owner.lock'))).toBe(false);
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });
});

describe('request hash migration', () => {
  it('an identical nested retry of a legacy-hash record replays after migration and keeps its evidence', async () => {
    const stateDir = freshStateDir();
    const req = request();
    seedLegacyRun(stateDir, 'run-legacy-1', 'legacy-key', req, 'completed');
    const m = new JobManager({ execute: neverExecute, store: new JobStore(stateDir) });
    const { replayed, snapshot } = await m.submit(req, 'legacy-key');
    expect(replayed).toBe(true);
    expect(snapshot.run_id).toBe('run-legacy-1');
    const result = await m.getResult('run-legacy-1');
    expect(result.summary.result).toBe('fail');
    expect(runnerResultSchema.safeParse(result).success).toBe(true);
    const migrated = JSON.parse(readFileSync(join(stateDir, 'runs', 'run-legacy-1.json'), 'utf-8')) as StoredRun;
    expect(migrated.requestHash).toBe(JobStore.canonicalRequestHash(req));
    expect(migrated.request).toEqual(req);
  });

  it('a changed nested target with the same key conflicts (the lossy old hash is not trusted)', async () => {
    const stateDir = freshStateDir();
    seedLegacyRun(stateDir, 'run-legacy-2', 'legacy-key', request('wallet-a'), 'completed');
    const m = new JobManager({ execute: neverExecute, store: new JobStore(stateDir) });
    // The old algorithm hashed both requests identically.
    expect(legacyHash(request('wallet-b'))).toBe(legacyHash(request('wallet-a')));
    await expect(m.submit(request('wallet-b'), 'legacy-key')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('array order remains significant', () => {
    expect(JobStore.canonicalRequestHash(request('w', ['A', 'B']))).not.toBe(
      JobStore.canonicalRequestHash(request('w', ['B', 'A']))
    );
  });
});

describe('restart recovery', () => {
  it('a persisted running record becomes a truthful interrupted terminal state after restart', async () => {
    const stateDir = freshStateDir();
    seedLegacyRun(stateDir, 'run-stranded', 'stranded-key', request(), 'running');
    const handle = await serveRunner({ host: '127.0.0.1', port: 0, profiles: profilesPath, stateDir });
    try {
      const headers = { authorization: 'Bearer recovery-token' };
      const snapshot = (await (await fetch(`${handle.url}/v1/runs/run-stranded`, { headers })).json()) as {
        status: string;
      };
      const resultResponse = await fetch(`${handle.url}/v1/runs/run-stranded/result`, { headers });
      expect(snapshot.status).toBe('error');
      expect(resultResponse.status).toBe(200);
      const result = (await resultResponse.json()) as RunnerResult;
      expect(result.execution.status).toBe('error');
      expect(result.execution.error).toContain('interrupted');
      expect(runnerResultSchema.safeParse(result).success).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('refuses to start while a previous native process group is still alive', async () => {
    const stateDir = freshStateDir();
    seedLegacyRun(stateDir, 'run-live-child', 'live-key', request(), 'running');
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { detached: true, stdio: 'ignore' });
    mkdirSync(join(stateDir, 'work', 'run-live-child'), { recursive: true });
    // The production writer records pid + boot ID + process start time.
    writeNativeChildMarker(join(stateDir, 'work', 'run-live-child'), sleeper.pid ?? 0, new Date().toISOString());
    const marker = JSON.parse(readFileSync(join(stateDir, 'work', 'run-live-child', 'native-child.json'), 'utf-8'));
    expect(marker.processStartTicks).toMatch(/^\d+$/);
    expect(marker.bootId).toBeTypeOf('string');
    expect(readdirSync(join(stateDir, 'work', 'run-live-child')).some((f) => f.includes('.tmp'))).toBe(false);
    try {
      await expect(serveRunner({ host: '127.0.0.1', port: 0, profiles: profilesPath, stateDir })).rejects.toThrow(
        /still alive/
      );
      expect(existsSync(join(stateDir, '.owner.lock'))).toBe(false);
    } finally {
      process.kill(-(sleeper.pid ?? 0), 'SIGKILL');
    }
    await new Promise((r) => setTimeout(r, 200));
    const handle = await serveRunner({ host: '127.0.0.1', port: 0, profiles: profilesPath, stateDir });
    await handle.close();
  });
});

describe('corrupt records', () => {
  it('quarantines a corrupt record and never lets its key launch new work', async () => {
    const stateDir = freshStateDir();
    seedLegacyRun(stateDir, 'run-corrupt', 'corrupt-key', request(), 'completed');
    writeFileSync(join(stateDir, 'runs', 'run-corrupt.json'), '{"secret":"/etc/operator/config.ini", truncated');
    const store = new JobStore(stateDir);
    const m = new JobManager({ execute: neverExecute, store });
    expect(store.quarantinedRecords().map((q) => q.file)).toEqual(['run-corrupt.json']);
    expect(readdirSync(join(stateDir, 'quarantine'))).toContain('run-corrupt.json');
    const error = await m.submit(request(), 'corrupt-key').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'RUN_RECORD_CORRUPT' });
    expect(String((error as Error).message)).not.toContain('/etc/operator');
  });

  it('a parseable but invalid record without an index entry still blocks its key', async () => {
    const stateDir = freshStateDir();
    mkdirSync(join(stateDir, 'runs'), { recursive: true });
    const keyHash = JobStore.keyHash('default', 'orphan-key');
    writeFileSync(
      join(stateDir, 'runs', 'run-orphan.json'),
      JSON.stringify({ idempotencyKeyHash: keyHash, runId: 'run-orphan', status: 'weird' })
    );
    const m = new JobManager({ execute: neverExecute, store: new JobStore(stateDir) });
    await expect(m.submit(request(), 'orphan-key')).rejects.toMatchObject({ code: 'RUN_RECORD_CORRUPT' });
  });
});

describe('native child marker robustness (review finding 3)', () => {
  function seedStrandedWithMarker(stateDir: string, runId: string, marker: string): string {
    seedLegacyRun(stateDir, runId, `${runId}-key`, request(), 'running');
    const dir = join(stateDir, 'work', runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'native-child.json'), marker);
    return dir;
  }

  it('a truncated marker does not block every restart: it is quarantined with a clear diagnostic', async () => {
    const stateDir = freshStateDir();
    const dir = seedStrandedWithMarker(stateDir, 'run-truncated', '{"pid": 12');
    const handle = await serveRunner({ host: '127.0.0.1', port: 0, profiles: profilesPath, stateDir });
    try {
      const response = await fetch(`${handle.url}/v1/runs/run-truncated/result`, {
        headers: { authorization: 'Bearer recovery-token' }
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as RunnerResult).execution.status).toBe('error');
      expect(existsSync(join(dir, 'native-child.json'))).toBe(false);
      expect(existsSync(join(dir, 'native-child.json.corrupt'))).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('a live but unrelated process reusing the recorded pid (different start identity) does not block startup', async () => {
    const stateDir = freshStateDir();
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { detached: true, stdio: 'ignore' });
    try {
      seedStrandedWithMarker(
        stateDir,
        'run-reused-pid',
        JSON.stringify({ pid: sleeper.pid, processStartTicks: '1', startedAt: new Date().toISOString() })
      );
      const handle = await serveRunner({ host: '127.0.0.1', port: 0, profiles: profilesPath, stateDir });
      await handle.close();
    } finally {
      process.kill(-(sleeper.pid ?? 0), 'SIGKILL');
    }
  });

  it('a marker from a previous boot does not block startup', async () => {
    const stateDir = freshStateDir();
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { detached: true, stdio: 'ignore' });
    try {
      seedStrandedWithMarker(
        stateDir,
        'run-old-boot',
        JSON.stringify({ bootId: 'boot-before-reboot', pid: sleeper.pid, startedAt: new Date().toISOString() })
      );
      const handle = await serveRunner({ host: '127.0.0.1', port: 0, profiles: profilesPath, stateDir });
      await handle.close();
    } finally {
      process.kill(-(sleeper.pid ?? 0), 'SIGKILL');
    }
  });

  it('an independent FAIL survives restart recovery as fail next to an INCONCLUSIVE scenario (review finding 1)', async () => {
    const stateDir = freshStateDir();
    const req = request();
    seedLegacyRun(stateDir, 'run-partial', 'partial-key', req, 'running');
    const path = join(stateDir, 'runs', 'run-partial.json');
    const record = JSON.parse(readFileSync(path, 'utf-8')) as StoredRun;
    const partial = completedResult('run-partial', req);
    partial.native.assertions = [
      { ...partial.native.assertions[0]!, assertion_id: 'a0001', raw: JSON.stringify({ full_title: 'generic' }) },
      {
        ...partial.native.assertions[0]!,
        assertion_id: 'a0002',
        raw: JSON.stringify({ full_title: 'matcher', scenario_id: 'WP_RP_HAPPY' })
      }
    ];
    partial.native.scenario_outcomes = [{ scenario_id: 'WP_RP_HAPPY', verdict: 'INCONCLUSIVE' }];
    writeFileSync(path, JSON.stringify({ ...record, result: partial }));
    const store = new JobStore(stateDir);
    expect(store.acquireRootLock()).toBe(true);
    const m = new JobManager({ execute: neverExecute, store });
    m.recoverInterruptedRuns();
    const result = await m.getResult('run-partial');
    expect(result.execution.status).toBe('error');
    expect(result.summary.result).toBe('fail');
    store.releaseRootLock();
  });
});

describe('second review: markers of terminal runs and corrupt markers (findings 1 and 3)', () => {
  function liveSleeper() {
    return spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { detached: true, stdio: 'ignore' });
  }

  it('a TERMINAL run whose native group is still alive blocks startup (cancel finalized after the grace period)', async () => {
    const stateDir = freshStateDir();
    seedLegacyRun(stateDir, 'run-cancelled-orphan', 'orphan-cancel-key', request(), 'completed');
    const sleeper = liveSleeper();
    const dir = join(stateDir, 'work', 'run-cancelled-orphan');
    mkdirSync(dir, { recursive: true });
    writeNativeChildMarker(dir, sleeper.pid ?? 0, new Date().toISOString());
    try {
      await expect(serveRunner({ host: '127.0.0.1', port: 0, profiles: profilesPath, stateDir })).rejects.toThrow(
        /still alive/
      );
    } finally {
      process.kill(-(sleeper.pid ?? 0), 'SIGKILL');
    }
    await new Promise((r) => setTimeout(r, 200));
    // Once the group is confirmed gone the marker is removed and startup proceeds.
    const handle = await serveRunner({ host: '127.0.0.1', port: 0, profiles: profilesPath, stateDir });
    await handle.close();
    expect(existsSync(join(dir, 'native-child.json'))).toBe(false);
  });

  it('a corrupt marker whose pid is still parseable and alive refuses startup', async () => {
    const stateDir = freshStateDir();
    seedLegacyRun(stateDir, 'run-corrupt-live', 'corrupt-live-key', request(), 'running');
    const sleeper = liveSleeper();
    const dir = join(stateDir, 'work', 'run-corrupt-live');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'native-child.json'), `{"bootId":"x","pid":${sleeper.pid},"startedAt":"2026-`);
    try {
      await expect(serveRunner({ host: '127.0.0.1', port: 0, profiles: profilesPath, stateDir })).rejects.toThrow(
        /still alive/
      );
    } finally {
      process.kill(-(sleeper.pid ?? 0), 'SIGKILL');
    }
  });
});
