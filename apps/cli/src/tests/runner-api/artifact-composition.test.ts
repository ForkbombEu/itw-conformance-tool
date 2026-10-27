import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serveRunner, type ServeRunnerHandle } from '../../commands/serveRunner.js';
import { runnerResultSchema } from '../../runner-api/contract.js';
import { nativeFixtureAdapter, REPORTER_FIXTURE_CONFIG } from './helpers/native-fixture-adapter.js';
import { createOperatorFixture, writeProfilesFile } from './helpers/operator-fixture.js';

import type { RunnerResult, RunSnapshot } from '../../runner-api/contract.js';

// Production composition (serveRunner → JobManager → native worker → artifact
// finalization → routes); only the subprocess boundary runs the real-reporter
// fixture child instead of the full CLI. No artifact ID is registered by hand.

const TOKEN = 'artifact-composition-token';
const root = mkdtempSync(join(tmpdir(), 'itwct-artifact-composition-'));
const stateDir = join(root, 'state');
let profilesPath: string;
// The benign "unknown source revision" limitation must be present in R17 runs.
const savedRevision = process.env.ITWCT_SOURCE_REVISION;
Reflect.deleteProperty(process.env, 'ITWCT_SOURCE_REVISION');

beforeAll(async () => {
  const fixture = await createOperatorFixture(join(root, 'operator'));
  profilesPath = writeProfilesFile(join(root, 'profiles.json'), [
    {
      allowedScenarioIds: ['WP_RP_HAPPY'],
      category: 'presentation',
      configPath: fixture.configPath,
      coverageMode: 'interoperability',
      id: 'evidence',
      initializedAssetsDir: fixture.assetsDir
    }
  ]);
  process.env.CREDIMI_RUNNER_TOKEN = TOKEN;
}, 60_000);

afterAll(() => {
  Reflect.deleteProperty(process.env, 'CREDIMI_RUNNER_TOKEN');
  if (savedRevision !== undefined) process.env.ITWCT_SOURCE_REVISION = savedRevision;
  rmSync(root, { force: true, recursive: true });
});

async function start(): Promise<ServeRunnerHandle> {
  const { adapter } = nativeFixtureAdapter(REPORTER_FIXTURE_CONFIG, { ITWCT_REPORTER_FIXTURE_MODE: 'mixed' });
  return serveRunner({ host: '127.0.0.1', port: 0, processAdapter: adapter, profiles: profilesPath, stateDir });
}

function get(handle: ServeRunnerHandle, path: string): Promise<Response> {
  return fetch(`${handle.url}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
}

let runId = '';
let result: RunnerResult;

describe('artifact composition — production finalization, downloads and restart', () => {
  it('publishes a schema-valid result whose every download URL returns the exact native bytes', async () => {
    const handle = await start();
    try {
      const created = await fetch(`${handle.url}/v1/runs`, {
        body: JSON.stringify({
          category: 'presentation',
          contract_version: '1.0',
          parameters: {},
          profile_id: 'evidence',
          selection: { ids: ['WP_RP_HAPPY'] },
          target: { actor_name: 'wallet-under-test', actor_type: 'wallet' },
          timeout_ms: 120_000
        }),
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'idempotency-key': 'ev-1' },
        method: 'POST'
      });
      expect(created.status).toBe(202);
      runId = ((await created.json()) as RunSnapshot).run_id;
      for (let i = 0; i < 300; i++) {
        const snapshot = (await (await get(handle, `/v1/runs/${runId}`)).json()) as RunSnapshot;
        if (snapshot.status === 'completed' || snapshot.status === 'error') break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const raw = await (await get(handle, `/v1/runs/${runId}/result`)).text();
      const parsed = runnerResultSchema.safeParse(JSON.parse(raw));
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      result = parsed.data as RunnerResult;
      expect(result.execution.status).toBe('completed');
      expect(result.summary.result).toBe('fail');
      expect(result.native.assertions.every((a) => a.assertion_id && a.raw)).toBe(true);
      expect(raw).not.toContain(stateDir);
      expect(raw).not.toContain(root);

      expect(result.artifacts).toHaveLength(1);
      const nativeBytes = readFileSync(join(stateDir, 'work', runId, 'results', 'native-results.json'));
      for (const entry of result.artifacts) {
        const response = await get(handle, entry.download_url);
        expect(response.status).toBe(200);
        const body = Buffer.from(await response.arrayBuffer());
        expect(body).toEqual(nativeBytes);
        expect(body.length).toBe(entry.size_bytes);
        expect(createHash('sha256').update(body).digest('hex')).toBe(entry.sha256);
        expect(response.headers.get('x-content-sha256')).toBe(entry.sha256);
        expect(response.headers.get('content-type')).toContain('application/json');
      }

      expect((await get(handle, `/v1/runs/not-this-run/artifacts/native-results`)).status).toBe(404);
      expect((await get(handle, `/v1/runs/${runId}/artifacts/unknown-artifact`)).status).toBe(404);
      expect((await get(handle, `/v1/runs/${runId}/artifacts/${encodeURIComponent('../runs')}`)).status).toBe(400);
    } finally {
      await handle.close();
    }
  }, 90_000);

  it('after a restart on the same root the same bytes download and the result is unchanged', async () => {
    const handle = await start();
    try {
      const again = (await (await get(handle, `/v1/runs/${runId}/result`)).json()) as RunnerResult;
      expect(again).toEqual(result);
      const entry = result.artifacts[0];
      const body = Buffer.from(await (await get(handle, entry?.download_url ?? '')).arrayBuffer());
      expect(createHash('sha256').update(body).digest('hex')).toBe(entry?.sha256);
    } finally {
      await handle.close();
    }
  }, 30_000);

  it('a corrupted or missing stored artifact is refused, never served', async () => {
    const stored = join(stateDir, 'artifacts', runId, 'files', 'native-results');
    writeFileSync(stored, 'tampered bytes');
    const handle = await start();
    try {
      const corrupt = await get(handle, `/v1/runs/${runId}/artifacts/native-results`);
      expect(corrupt.status).toBe(500);
      expect(((await corrupt.json()) as { error: { code: string } }).error.code).toBe('ARTIFACT_CORRUPT');
      rmSync(stored);
      const missing = await get(handle, `/v1/runs/${runId}/artifacts/native-results`);
      expect(missing.status).toBe(410);
    } finally {
      await handle.close();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// R17 — initial publication failure through the REAL server composition:
// serveRunner → JobManager → native worker → REAL Vitest child with the REAL
// ConformanceReporter (protocol-free `pass` fixture) → adapter → artifact
// finalization → routes. Only the filesystem/artifact boundary is controlled:
// either through the named internal `artifactSourceReader` seam or by a real
// read-only directory. No entry is registered by hand and no RunnerResult is
// fabricated on this path.
// ---------------------------------------------------------------------------

type ArtifactSourceReader = (path: string) => Buffer;

function startPass(state: string, artifactSourceReader?: ArtifactSourceReader): Promise<ServeRunnerHandle> {
  const { adapter } = nativeFixtureAdapter(REPORTER_FIXTURE_CONFIG, { ITWCT_REPORTER_FIXTURE_MODE: 'pass' });
  return serveRunner({
    host: '127.0.0.1',
    port: 0,
    processAdapter: adapter,
    profiles: profilesPath,
    stateDir: state,
    ...(artifactSourceReader ? { artifactSourceReader } : {})
  });
}

const PASS_REQUEST = {
  category: 'presentation',
  contract_version: '1.0',
  parameters: {},
  profile_id: 'evidence',
  selection: { ids: ['WP_RP_HAPPY'] },
  target: { actor_name: 'wallet-under-test', actor_type: 'wallet' },
  timeout_ms: 120_000
};

function submit(handle: ServeRunnerHandle, key: string): Promise<Response> {
  return fetch(`${handle.url}/v1/runs`, {
    body: JSON.stringify(PASS_REQUEST),
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'idempotency-key': key },
    method: 'POST'
  });
}

async function runToTerminal(handle: ServeRunnerHandle, key: string): Promise<{ raw: string; result: RunnerResult }> {
  const created = await submit(handle, key);
  expect(created.status).toBe(202);
  const id = ((await created.json()) as RunSnapshot).run_id;
  for (let i = 0; i < 600; i++) {
    const snapshot = (await (await get(handle, `/v1/runs/${id}`)).json()) as RunSnapshot;
    if (['cancelled', 'completed', 'error', 'timed_out'].includes(snapshot.status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const raw = await (await get(handle, `/v1/runs/${id}/result`)).text();
  const parsed = runnerResultSchema.safeParse(JSON.parse(raw));
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  return { raw, result: parsed.data as RunnerResult };
}

function expectNativePass(r: RunnerResult): void {
  expect(r.execution.status).toBe('completed');
  expect(r.native.native_suite_status).toBe('PASSED');
  expect(r.native.assertions.length).toBeGreaterThan(0);
  expect(r.native.assertions.every((a) => a.native_status === 'PASS')).toBe(true);
  expect(r.summary.native_failed_assertion_count).toBe(0);
}

describe('artifact composition — initial publication failure (R17, real native reporter child)', () => {
  it('normal publication of a native PASS keeps a real pass with byte/hash-correct download, despite benign limitations', async () => {
    const state = join(root, 'r17-pass');
    const handle = await startPass(state);
    try {
      const { result: r } = await runToTerminal(handle, 'r17-pass');
      expectNativePass(r);
      expect(r.summary.result).toBe('pass');
      expect(r.limitations.join(' ')).toContain('engine.revision is unknown');
      expect(r.artifacts.map((a) => a.artifact_id)).toEqual(['native-results']);
      const entry = r.artifacts[0];
      const nativeBytes = readFileSync(join(state, 'work', r.run_id, 'results', 'native-results.json'));
      const body = Buffer.from(await (await get(handle, entry?.download_url ?? '')).arrayBuffer());
      expect(body).toEqual(nativeBytes);
      expect(body.length).toBe(entry?.size_bytes);
      expect(createHash('sha256').update(body).digest('hex')).toBe(entry?.sha256);
    } finally {
      await handle.close();
    }
  }, 90_000);

  it('an unreadable declared artifact turns the native PASS into inconclusive, surviving restart and replay', async () => {
    const state = join(root, 'r17-unreadable');
    const failingReader: ArtifactSourceReader = (path) => {
      if (path.endsWith('native-results.json')) throw new Error('EACCES: permission denied (R17 test seam)');
      return readFileSync(path);
    };
    let first: RunnerResult;
    let firstRaw: string;
    const handle = await startPass(state, failingReader);
    try {
      ({ raw: firstRaw, result: first } = await runToTerminal(handle, 'r17-unreadable'));
      expectNativePass(first);
      expect(first.summary.result).toBe('inconclusive');
      expect(first.artifacts).toEqual([]);
      expect(first.limitations.join(' ')).toContain("'native-results.json' could not be read");
      expect(first.limitations.join(' ')).toContain('could not be published');
      expect(firstRaw).not.toContain(root);
      expect((await get(handle, `/v1/runs/${first.run_id}/artifacts/native-results`)).status).toBe(404);
    } finally {
      await handle.close();
    }

    // Restart on the same state root WITHOUT the seam: the stored terminal
    // result is unchanged and same-key replay returns that run.
    const restarted = await startPass(state);
    try {
      const again = (await (await get(restarted, `/v1/runs/${first.run_id}/result`)).json()) as RunnerResult;
      expect(again).toEqual(first);
      const replay = await submit(restarted, 'r17-unreadable');
      expect(replay.status).toBe(200);
      expect(((await replay.json()) as RunSnapshot).run_id).toBe(first.run_id);
      const replayed = await (await get(restarted, `/v1/runs/${first.run_id}/result`)).text();
      expect(replayed).toBe(firstRaw);
      expect((await get(restarted, `/v1/runs/${first.run_id}/artifacts/native-results`)).status).toBe(404);
    } finally {
      await restarted.close();
    }
  }, 120_000);

  it('a real write error in the artifact store keeps native data and yields a readable inconclusive result', async () => {
    const state = join(root, 'r17-readonly');
    // Real filesystem boundary, no seam: the artifact root is read-only.
    mkdirSync(join(state, 'artifacts'), { recursive: true });
    chmodSync(join(state, 'artifacts'), 0o500);
    const handle = await startPass(state);
    try {
      const { result: r } = await runToTerminal(handle, 'r17-readonly');
      expectNativePass(r);
      expect(r.execution.error).toBeUndefined();
      expect(r.summary.result).toBe('inconclusive');
      expect(r.artifacts).toEqual([]);
      expect(r.limitations.join(' ')).toContain('could not be stored');
      expect((await get(handle, `/v1/runs/${r.run_id}/artifacts/native-results`)).status).toBe(404);
    } finally {
      await handle.close();
      chmodSync(join(state, 'artifacts'), 0o700);
    }
  }, 90_000);
});
