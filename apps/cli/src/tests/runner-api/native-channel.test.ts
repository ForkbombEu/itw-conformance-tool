import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serveRunner, type ServeRunnerHandle } from '../../commands/serveRunner.js';
import { runnerResultSchema } from '../../runner-api/contract.js';
import { CHANNEL_FIXTURE_CONFIG, nativeFixtureAdapter } from './helpers/native-fixture-adapter.js';
import { createOperatorFixture, writeProfilesFile } from './helpers/operator-fixture.js';

import type { RunnerResult, RunSnapshot } from '../../runner-api/contract.js';

const TOKEN = 'native-channel-token';
const root = mkdtempSync(join(tmpdir(), 'itwct-native-channel-'));
let profilesPath: string;

beforeAll(async () => {
  const fixture = await createOperatorFixture(join(root, 'operator'));
  profilesPath = writeProfilesFile(join(root, 'profiles.json'), [
    {
      allowedScenarioIds: ['WP_RP_HAPPY'],
      category: 'presentation',
      configPath: fixture.configPath,
      coverageMode: 'interoperability',
      id: 'channel',
      initializedAssetsDir: fixture.assetsDir
    }
  ]);
  process.env.CREDIMI_RUNNER_TOKEN = TOKEN;
}, 60_000);

afterAll(() => {
  Reflect.deleteProperty(process.env, 'CREDIMI_RUNNER_TOKEN');
  rmSync(root, { force: true, recursive: true });
});

async function start(mode: string): Promise<ServeRunnerHandle> {
  const { adapter } = nativeFixtureAdapter(CHANNEL_FIXTURE_CONFIG, { ITWCT_CHANNEL_FIXTURE_MODE: mode });
  return serveRunner({
    host: '127.0.0.1',
    port: 0,
    processAdapter: adapter,
    profiles: profilesPath,
    stateDir: join(root, `state-${mode}-${Math.random().toString(36).slice(2)}`)
  });
}

async function http(handle: ServeRunnerHandle, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${handle.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...init.headers }
  });
}

async function submit(handle: ServeRunnerHandle, key: string): Promise<string> {
  const response = await http(handle, '/v1/runs', {
    body: JSON.stringify({
      category: 'presentation',
      contract_version: '1.0',
      parameters: {},
      profile_id: 'channel',
      selection: { ids: ['WP_RP_HAPPY'] },
      target: { actor_name: 'wallet-under-test', actor_type: 'wallet' },
      timeout_ms: 120_000
    }),
    headers: { 'idempotency-key': key },
    method: 'POST'
  });
  expect(response.status).toBe(202);
  return ((await response.json()) as RunSnapshot).run_id;
}

async function poll(
  handle: ServeRunnerHandle,
  runId: string,
  done: (snapshot: RunSnapshot) => boolean
): Promise<RunSnapshot> {
  for (let i = 0; i < 600; i++) {
    const snapshot = (await (await http(handle, `/v1/runs/${runId}`)).json()) as RunSnapshot;
    if (done(snapshot)) return snapshot;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out polling run ${runId}`);
}

const isTerminal = (s: RunSnapshot): boolean => ['cancelled', 'completed', 'error', 'timed_out'].includes(s.status);

async function ack(handle: ServeRunnerHandle, runId: string, interactionId: string, body: unknown): Promise<Response> {
  return http(handle, `/v1/runs/${runId}/interactions/${interactionId}/ack`, {
    body: JSON.stringify(body),
    method: 'POST'
  });
}

describe('native channel — real session file → HTTP snapshot/ACK → native outcome', () => {
  it('exposes the genuine pending interaction, ACK is observed natively, PASS comes from protocol evidence', async () => {
    const handle = await start('pass');
    try {
      const runId = await submit(handle, 'pass-1');
      const waiting = await poll(handle, runId, (s) => s.pending_interactions.length > 0 || isTerminal(s));
      expect(waiting.status).toBe('waiting_for_interaction');
      const interaction = waiting.pending_interactions[0];
      expect(interaction?.scenario_id).toBe('WP_RP_HAPPY');
      expect(interaction?.uri).toContain('openid4vp://authorize');
      expect(Date.parse(interaction?.expires_at ?? '')).toBeGreaterThan(Date.now());

      const interactionId = interaction?.interaction_id ?? '';
      expect((await ack(handle, 'other-run', interactionId, { driver_status: 'completed' })).status).toBe(404);
      expect((await ack(handle, runId, 'unknown-interaction', { driver_status: 'completed' })).status).toBe(404);
      expect((await ack(handle, runId, interactionId, { driver_status: 'maybe' })).status).toBe(400);
      expect((await ack(handle, runId, interactionId, { driver_status: 'completed', extra: 1 })).status).toBe(400);

      const first = await ack(handle, runId, interactionId, { driver_status: 'completed' });
      expect(first.status).toBe(200);
      const duplicate = await ack(handle, runId, interactionId, { driver_status: 'completed' });
      expect([200, 409]).toContain(duplicate.status); // 409 only if the run already finished
      if (duplicate.status === 409) {
        expect(((await duplicate.json()) as { error: { code: string } }).error.code).toBe('RUN_TERMINAL');
      }

      const terminal = await poll(handle, runId, isTerminal);
      expect(terminal.status).toBe('completed');
      expect(terminal.pending_interactions).toEqual([]);
      const result = (await (await http(handle, `/v1/runs/${runId}/result`)).json()) as RunnerResult;
      expect(result.native.scenario_outcomes).toEqual([{ scenario_id: 'WP_RP_HAPPY', verdict: 'PASS' }]);
      expect(result.summary).toEqual({ assertion_count: 2, native_failed_assertion_count: 0, result: 'pass' });
      expect(runnerResultSchema.shape.native.safeParse(result.native).success).toBe(true);
    } finally {
      await handle.close();
    }
  }, 90_000);

  it('a completed ACK without wallet evidence stays INCONCLUSIVE with the strict matcher failure counted', async () => {
    const handle = await start('inconclusive');
    try {
      const runId = await submit(handle, 'inconclusive-1');
      const waiting = await poll(handle, runId, (s) => s.pending_interactions.length > 0 || isTerminal(s));
      const interactionId = waiting.pending_interactions[0]?.interaction_id ?? '';
      expect((await ack(handle, runId, interactionId, { driver_status: 'completed' })).status).toBe(200);
      await poll(handle, runId, isTerminal);
      const result = (await (await http(handle, `/v1/runs/${runId}/result`)).json()) as RunnerResult;
      expect(result.execution.status).toBe('completed');
      expect(result.native.scenario_outcomes).toEqual([{ scenario_id: 'WP_RP_HAPPY', verdict: 'INCONCLUSIVE' }]);
      expect(result.summary.result).toBe('inconclusive');
      expect(result.summary.native_failed_assertion_count).toBe(1);
      expect(result.limitations.join(' ')).toContain('strict-PASS matchers of INCONCLUSIVE');
    } finally {
      await handle.close();
    }
  }, 90_000);

  it('a failed ACK goes through the cancellation path and stops the native child', async () => {
    const handle = await start('wait');
    try {
      const runId = await submit(handle, 'failed-ack-1');
      const waiting = await poll(handle, runId, (s) => s.pending_interactions.length > 0 || isTerminal(s));
      const interactionId = waiting.pending_interactions[0]?.interaction_id ?? '';
      const response = await ack(handle, runId, interactionId, { driver_status: 'failed', message: 'wallet crashed' });
      expect(response.status).toBe(200);
      const snapshot = (await response.json()) as RunSnapshot;
      expect(snapshot.status).toBe('cancelled');
      expect(snapshot.cancel_requested).toBe(true);
      // A conflicting ACK after termination is rejected; nothing is resurrected.
      expect((await ack(handle, runId, interactionId, { driver_status: 'completed' })).status).toBe(409);
      const after = (await (await http(handle, `/v1/runs/${runId}`)).json()) as RunSnapshot;
      expect(after.pending_interactions).toEqual([]);
      // The cancelled run has a readable, schema-valid envelope (N12).
      const resultResponse = await http(handle, `/v1/runs/${runId}/result`);
      expect(resultResponse.status).toBe(200);
      const result = (await resultResponse.json()) as RunnerResult;
      expect(result.execution.status).toBe('cancelled');
      expect(result.summary.result).not.toBe('pass');
    } finally {
      await handle.close();
    }
  }, 90_000);
});
