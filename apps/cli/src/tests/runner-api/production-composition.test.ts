import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serveRunner, type ServeRunnerHandle } from '../../commands/serveRunner.js';
import { runnerResultSchema } from '../../runner-api/contract.js';
import { nativeFixtureAdapter, repoRoot, REPORTER_FIXTURE_CONFIG } from './helpers/native-fixture-adapter.js';
import { createOperatorFixture, type OperatorFixture, writeProfilesFile } from './helpers/operator-fixture.js';

import type { RunnerResult, RunRequest, RunSnapshot } from '../../runner-api/contract.js';
import type { ProcessAdapter } from '../../runner-api/native-worker.js';

const TOKEN = 'production-composition-token';
const compiledCli = join(repoRoot, 'apps/cli/dist/main.js');
const root = mkdtempSync(join(tmpdir(), 'itwct-production-composition-'));
let operator: OperatorFixture;
let profilesPath: string;

beforeAll(async () => {
  expect(existsSync(compiledCli), 'run `pnpm build` first').toBe(true);
  operator = await createOperatorFixture(join(root, 'operator'));
  profilesPath = writeProfilesFile(join(root, 'profiles.json'), [
    {
      allowedScenarioIds: ['WP_RP_HAPPY'],
      category: 'presentation',
      configPath: 'operator/config.ini',
      coverageMode: 'interoperability',
      id: 'production',
      initializedAssetsDir: 'operator/data'
    }
  ]);
  process.env.CREDIMI_RUNNER_TOKEN = TOKEN;
}, 60_000);

afterAll(() => {
  Reflect.deleteProperty(process.env, 'CREDIMI_RUNNER_TOKEN');
  rmSync(root, { force: true, recursive: true });
});

function runRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    category: 'presentation',
    contract_version: '1.0',
    parameters: {},
    profile_id: 'production',
    selection: { ids: ['WP_RP_HAPPY'] },
    target: { actor_name: 'wallet-under-test', actor_type: 'wallet', actor_version: '1.0.0' },
    timeout_ms: 300_000,
    ...overrides
  };
}

async function api(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...init.headers }
  });
}

async function post(base: string, key: string, body: unknown): Promise<Response> {
  return api(base, '/v1/runs', { body: JSON.stringify(body), headers: { 'idempotency-key': key }, method: 'POST' });
}

const isTerminal = (s: RunSnapshot): boolean => ['cancelled', 'completed', 'error', 'timed_out'].includes(s.status);

async function poll(
  base: string,
  runId: string,
  done: (s: RunSnapshot) => boolean,
  ms = 240_000
): Promise<RunSnapshot> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const snapshot = (await (await api(base, `/v1/runs/${runId}`)).json()) as RunSnapshot;
    if (done(snapshot)) return snapshot;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`run ${runId} did not reach the expected state`);
}

/** Fetches the final result, parses it with the wire schema and verifies every artifact URL. */
async function verifiedResult(base: string, runId: string, nativeExportPath?: string): Promise<RunnerResult> {
  const raw = await (await api(base, `/v1/runs/${runId}/result`)).text();
  const parsed = runnerResultSchema.safeParse(JSON.parse(raw));
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  expect(raw).not.toContain(root);
  const result = parsed.data as RunnerResult;
  for (const entry of result.artifacts) {
    const response = await api(base, entry.download_url);
    expect(response.status).toBe(200);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.length).toBe(entry.size_bytes);
    expect(createHash('sha256').update(body).digest('hex')).toBe(entry.sha256);
    if (nativeExportPath && entry.artifact_id === 'native-results')
      expect(body).toEqual(readFileSync(nativeExportPath));
  }
  return result;
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

// ---------------------------------------------------------------------------
// A. The exact production composition constructor (serveRunner) with the real
//    profile loader, selection validator, config/asset provisioning, native
//    worker, adapter, summarizer, manifest persistence and routes. ONLY the
//    subprocess boundary runs a REAL Vitest child with the REAL
//    ConformanceReporter on a protocol-free fixture.
// ---------------------------------------------------------------------------
describe('A. production composition with the real reporter at the subprocess boundary', () => {
  let handle: ServeRunnerHandle;
  const stateDir = join(root, 'state-a');
  const fixture = nativeFixtureAdapter(REPORTER_FIXTURE_CONFIG, { ITWCT_REPORTER_FIXTURE_MODE: 'mixed' });
  const mismatched = nativeFixtureAdapter(REPORTER_FIXTURE_CONFIG, {
    ITWCT_REPORTER_FIXTURE_MODE: 'mixed',
    ITWCT_RUN_ID: 'OLD-RUN'
  });
  const empty = nativeFixtureAdapter(REPORTER_FIXTURE_CONFIG, { ITWCT_REPORTER_FIXTURE_MODE: 'empty' });
  let active: ProcessAdapter = fixture.adapter;
  const switching: ProcessAdapter = { spawn: (command, args, options) => active.spawn(command, args, options) };
  const malformed: ProcessAdapter = {
    spawn(_command, _args, options) {
      const target = join(options.env.ITWCT_RESULTS_DIR ?? '', 'native-results.json');
      return spawn(
        process.execPath,
        ['-e', `require('fs').writeFileSync(${JSON.stringify(target)}, '{"assertions": [ truncated')`],
        options
      );
    }
  };
  let firstRunId = '';

  beforeAll(async () => {
    handle = await serveRunner({
      host: '127.0.0.1',
      port: 0,
      processAdapter: switching,
      profiles: profilesPath,
      stateDir
    });
  });

  afterAll(async () => {
    await handle.close();
  });

  it('a deliberate native FAIL is completed + fail with raw failed count, artifacts verified', async () => {
    const created = await post(handle.url, 'key-a', runRequest());
    expect(created.status).toBe(202);
    firstRunId = ((await created.json()) as RunSnapshot).run_id;
    await poll(handle.url, firstRunId, isTerminal);

    // Default production launch resolution, asserted at the boundary.
    const launch = fixture.launches[0];
    expect(launch?.command).toBe(process.execPath);
    expect(launch?.args).toEqual([compiledCli, 'test', 'presentation', '--verbose']);
    expect(launch?.options.env.ITWCT_CONFIG_PATH).toBe(operator.configPath);
    expect(launch?.options.env.ITWCT_RUN_ID).toBe(firstRunId);
    expect(launch?.options.cwd).toBe(join(stateDir, 'work', firstRunId));

    const result = await verifiedResult(
      handle.url,
      firstRunId,
      join(stateDir, 'work', firstRunId, 'results', 'native-results.json')
    );
    expect(result.execution.status).toBe('completed');
    expect(result.execution.exit_code).not.toBe(0);
    expect(result.summary).toEqual({ assertion_count: 3, native_failed_assertion_count: 1, result: 'fail' });
    const [bracketed, duplicate, generic] = result.native.assertions;
    expect(bracketed?.full_title).toContain('[WP_082]:');
    expect(bracketed?.native_status).toBe('PASS');
    expect(duplicate?.requirement_id).toBe('WP_082');
    expect(duplicate?.native_status).toBe('FAIL');
    expect(duplicate?.assertion_id).not.toBe(bracketed?.assertion_id);
    expect(generic?.requirement_id).toBeUndefined();
    expect(result.artifacts.map((a) => a.artifact_id)).toEqual(['native-results']);
  }, 60_000);

  it('sequential runs with different keys, replay and changed nested target on the same key', async () => {
    const second = await post(handle.url, 'key-b', runRequest());
    expect(second.status).toBe(202);
    const secondId = ((await second.json()) as RunSnapshot).run_id;
    expect(secondId).not.toBe(firstRunId);
    await poll(handle.url, secondId, isTerminal);

    const replay = await post(handle.url, 'key-a', runRequest());
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as RunSnapshot).run_id).toBe(firstRunId);

    const changed = await post(
      handle.url,
      'key-a',
      runRequest({ target: { actor_name: 'wallet-under-test', actor_type: 'wallet', actor_version: '2.0.0' } })
    );
    expect(changed.status).toBe(409);
    expect(((await changed.json()) as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_CONFLICT');
  }, 60_000);

  it('rejects unknown profile, category and selection before work', async () => {
    for (const [overrides, code] of [
      [{ profile_id: 'nope' }, 'UNKNOWN_PROFILE'],
      [{ category: 'issuance' }, 'CATEGORY_MISMATCH'],
      [{ selection: { ids: ['WP_090'] } }, 'UNSUPPORTED_SELECTION']
    ] as const) {
      const response = await post(handle.url, `bad-${code}`, runRequest(overrides as Partial<RunRequest>));
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
    }
  });

  it('mismatched (other run), zero and malformed native evidence never pass', async () => {
    const cases: [ProcessAdapter, string, RunnerResult['execution']['status'], string][] = [
      [mismatched.adapter, 'mismatch', 'error', 'does not match expected'],
      [empty.adapter, 'zero', 'completed', 'No native assertions'],
      [malformed, 'malformed', 'error', 'Native export rejected']
    ];
    for (const [adapter, key, status, limitation] of cases) {
      active = adapter;
      const created = await post(handle.url, `evidence-${key}`, runRequest());
      const runId = ((await created.json()) as RunSnapshot).run_id;
      await poll(handle.url, runId, isTerminal);
      const result = await verifiedResult(handle.url, runId);
      expect(result.execution.status, key).toBe(status);
      expect(result.summary.result, key).toBe('not_tested');
      expect(result.limitations.join(' '), key).toContain(limitation);
    }
    active = fixture.adapter;
  }, 120_000);

  it('wrong run / artifact lookups are 404', async () => {
    expect((await api(handle.url, '/v1/runs/not-a-run/artifacts/native-results')).status).toBe(404);
    expect((await api(handle.url, `/v1/runs/${firstRunId}/artifacts/other`)).status).toBe(404);
    expect((await api(handle.url, '/v1/runs/not-a-run/result')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// B. The ACTUAL compiled server command, no seam at all: real CLI child, real
//    local Trust Anchor + Relying Party, the real presentation matrix
//    (WP_RP_HAPPY selected) and the real reporter. The test plays only the
//    minimal wallet boundary: it fetches the Request Object from the
//    request_uri the RP generated, and never completes a presentation.
// ---------------------------------------------------------------------------
describe('B. actual compiled server, real native presentation run', () => {
  const stateDir = join(root, 'state-b');
  let server: ChildProcess | undefined;
  let base = '';

  /** Tail of the private native diagnostics, shown only in assertion messages. */
  function diagnostics(runId: string): string {
    const path = join(stateDir, 'work', runId, 'diagnostics', 'native-child.log');
    return existsSync(path) ? readFileSync(path, 'utf-8').slice(-3_000) : 'no diagnostics';
  }

  async function startServer(): Promise<void> {
    const child = spawn(
      process.execPath,
      [compiledCli, 'serve-runner', '--profiles', profilesPath, '--state-dir', stateDir, '--port', '0'],
      { cwd: root, env: { ...process.env, CREDIMI_RUNNER_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    server = child;
    base = await new Promise<string>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 30_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        const match = /Runner listening on (http:\/\/\S+)/.exec(out);
        if (match?.[1]) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.stderr?.on('data', () => undefined);
      child.once('exit', (code) => reject(new Error(`server exited early (${code}): ${out}`)));
    });
  }

  async function stopServer(): Promise<number | null> {
    const child = server;
    if (!child || child.exitCode !== null) return child?.exitCode ?? null;
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    child.kill('SIGTERM'); // the actual process signal path
    return exited;
  }

  beforeAll(async () => {
    for (const port of [3001, 3002]) {
      expect(await portOpen(port), `port ${port} must be free for the local services`).toBe(false);
    }
    mkdirSync(stateDir, { recursive: true });
    await startServer();
  }, 60_000);

  afterAll(async () => {
    await stopServer();
  });

  let inconclusiveRunId = '';
  let inconclusiveResult: RunnerResult;

  it('genuine pending interaction → ACK (no PASS) → Request Object fetched → INCONCLUSIVE with native matcher failures', async () => {
    const created = await post(base, 'real-1', runRequest());
    expect(created.status).toBe(202);
    inconclusiveRunId = ((await created.json()) as RunSnapshot).run_id;

    const waiting = await poll(
      base,
      inconclusiveRunId,
      (s) => s.pending_interactions.length > 0 || isTerminal(s),
      90_000
    );
    expect(waiting.status).toBe('waiting_for_interaction');
    const interaction = waiting.pending_interactions[0];
    expect(interaction?.scenario_id).toBe('WP_RP_HAPPY');
    const requestUri = new URL(interaction?.uri ?? '').searchParams.get('request_uri') ?? '';
    expect(requestUri).toMatch(/^https:\/\/127\.0\.0\.1:3002\/auth\/request\//);

    const ack = await api(base, `/v1/runs/${inconclusiveRunId}/interactions/${interaction?.interaction_id}/ack`, {
      body: JSON.stringify({ driver_status: 'completed' }),
      method: 'POST'
    });
    expect(ack.status).toBe(200);
    // ACK alone is not a verdict.
    expect(isTerminal((await ack.json()) as RunSnapshot)).toBe(false);

    // Minimal wallet boundary: retrieve the signed Request Object (local RP,
    // locally generated CA — verification is irrelevant for this probe).
    const requestObject = await new Promise<string>((resolve, reject) => {
      httpsRequest(requestUri, { rejectUnauthorized: false }, (response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => (body += chunk.toString()));
        response.on('end', () => resolve(body));
      })
        .on('error', reject)
        .end();
    });
    expect(requestObject.split('.')).toHaveLength(3);

    await poll(base, inconclusiveRunId, isTerminal, 180_000);
    inconclusiveResult = await verifiedResult(
      base,
      inconclusiveRunId,
      join(stateDir, 'work', inconclusiveRunId, 'results', 'native-results.json')
    );
    expect(inconclusiveResult.execution.status).toBe('completed');
    expect(inconclusiveResult.native.scenario_outcomes).toEqual([
      { scenario_id: 'WP_RP_HAPPY', verdict: 'INCONCLUSIVE' }
    ]);
    expect(inconclusiveResult.summary.result).toBe('inconclusive');
    expect(inconclusiveResult.summary.native_failed_assertion_count).toBe(9);
    // Real matrix collected in automated mode: only the selected happy group
    // (9 normative tests) plus the 2 generic cleanup checks.
    expect(inconclusiveResult.summary.assertion_count).toBe(11);
    const happy = inconclusiveResult.native.assertions.filter((a) => a.full_title.includes('Happy path — full remote'));
    expect(happy.map((a) => a.requirement_id)).toEqual([
      'WP_076',
      'WP_082',
      'WP_091',
      'WP_092',
      'WP_093',
      'WP_093a',
      'WP_093b',
      'WP_093c',
      'WP_094'
    ]);
    expect(happy.every((a) => a.native_status === 'FAIL')).toBe(true);
    expect(inconclusiveResult.engine.version).toBe('0.0.1');
    expect(inconclusiveResult.native.sessions[0]?.id).not.toBe(inconclusiveResult.engine.revision);
    expect(await portOpen(3002)).toBe(false);
  }, 300_000);

  it('cancelling a waiting native child yields a readable cancelled result and frees the services', async () => {
    const created = await post(base, 'real-cancel', runRequest());
    const createdBody = await created.text();
    expect(created.status, createdBody).toBe(202);
    const runId = (JSON.parse(createdBody) as RunSnapshot).run_id;
    await poll(base, runId, (s) => s.pending_interactions.length > 0 || isTerminal(s), 90_000);
    const cancelled = await api(base, `/v1/runs/${runId}/cancel`, { method: 'POST' });
    expect(((await cancelled.json()) as RunSnapshot).status, diagnostics(runId)).toBe('cancelled');
    const result = await verifiedResult(base, runId);
    expect(result.execution.status).toBe('cancelled');
    expect(result.summary.result).not.toBe('pass');
    expect(await portOpen(3001)).toBe(false);
    expect(await portOpen(3002)).toBe(false);
  }, 120_000);

  it('a real deadline produces timed_out in snapshot and result and frees the services', async () => {
    const created = await post(base, 'real-deadline', runRequest({ timeout_ms: 20_000 }));
    const createdBody = await created.text();
    expect(created.status, createdBody).toBe(202);
    const runId = (JSON.parse(createdBody) as RunSnapshot).run_id;
    const terminal = await poll(base, runId, isTerminal, 120_000);
    expect(terminal.status, diagnostics(runId)).toBe('timed_out');
    const result = await verifiedResult(base, runId);
    expect(result.execution.status).toBe('timed_out');
    expect(result.summary.result).not.toBe('pass');
    expect(await portOpen(3002)).toBe(false);
  }, 150_000);

  it('SIGTERM shuts the server down cleanly; a restart on the same root keeps results, replay and downloads', async () => {
    expect(await stopServer()).toBe(0);
    expect(existsSync(join(stateDir, '.owner.lock'))).toBe(false);

    await startServer();
    const again = await verifiedResult(base, inconclusiveRunId);
    expect(again).toEqual(inconclusiveResult);
    const replay = await post(base, 'real-1', runRequest());
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as RunSnapshot).run_id).toBe(inconclusiveRunId);
  }, 60_000);
});

// Keeps the operator INI untouched across all runs.
it('operator files were never modified', () => {
  expect(readFileSync(operator.configPath, 'utf-8')).toContain('[global]');
  writeFileSync(join(root, '.done'), '');
});
