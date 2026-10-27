import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { installRunnerSignalHandlers, serveRunner, type ServeRunnerHandle } from '../../commands/serveRunner.js';
import {
  NATIVE_DIAGNOSTICS_FILENAME,
  MAX_DIAGNOSTIC_BYTES,
  createNativeExecutor
} from '../../runner-api/native-worker.js';
import {
  createOperatorFixture,
  loadedProfile,
  type OperatorFixture,
  writeProfilesFile
} from './helpers/operator-fixture.js';

import type { RunRequest, RunSnapshot, RunnerResult } from '../../runner-api/contract.js';
import type { ProcessAdapter, SpawnOptions } from '../../runner-api/native-worker.js';

// The embedding entrypoint here is the Vitest worker, so process.argv[1] is
// NOT the CLI: the worker must resolve the compiled entrypoint itself.
const repoRoot = resolve(import.meta.dirname, '../../../../..');
const compiledCli = join(repoRoot, 'apps/cli/dist/main.js');
const TOKEN = 'native-startup-token';

interface Recorded {
  args: string[];
  command: string;
  options: SpawnOptions;
}

/**
 * Low-level process boundary: records the intended native launch, then runs a
 * real harmless child with the worker's exact env and cwd.
 */
function harmlessAdapter(childArgs: (recorded: Recorded) => string[]): { adapter: ProcessAdapter; spawns: Recorded[] } {
  const spawns: Recorded[] = [];
  return {
    adapter: {
      spawn(command, args, options) {
        const recorded = { args, command, options };
        spawns.push(recorded);
        return spawn(process.execPath, childArgs(recorded), options);
      }
    },
    spawns
  };
}

const outsideRoot = mkdtempSync(join(tmpdir(), 'itwct-native-startup-'));
let fixtureA: OperatorFixture;
let fixtureB: OperatorFixture;
let profilesPath: string;

beforeAll(async () => {
  expect(relative(repoRoot, outsideRoot).startsWith('..'), 'state must live outside the Nx tree').toBe(true);
  expect(existsSync(compiledCli), 'build the CLI first: pnpm nx run itw-conformance-cli:build').toBe(true);
  fixtureA = await createOperatorFixture(join(outsideRoot, 'operator-a'));
  fixtureB = await createOperatorFixture(join(outsideRoot, 'operator-b'));
  writeFileSync(
    fixtureB.configPath,
    readFileSync(fixtureB.configPath, 'utf-8').replace(/organization_name\s*=.*/, 'organization_name = Operator B')
  );
  // Relative paths, resolved against the profiles file directory.
  profilesPath = writeProfilesFile(join(outsideRoot, 'profiles.json'), [
    {
      allowedScenarioIds: ['WP_RP_HAPPY'],
      category: 'presentation',
      configPath: 'operator-a/config.ini',
      coverageMode: 'interoperability',
      id: 'profile-a',
      initializedAssetsDir: 'operator-a/data'
    },
    {
      allowedScenarioIds: ['WP_RP_HAPPY'],
      category: 'presentation',
      configPath: 'operator-b/config.ini',
      coverageMode: 'it_wallet_profile',
      id: 'profile-b',
      initializedAssetsDir: 'operator-b/data'
    }
  ]);
  process.env.CREDIMI_RUNNER_TOKEN = TOKEN;
}, 60_000);

afterAll(() => {
  Reflect.deleteProperty(process.env, 'CREDIMI_RUNNER_TOKEN');
  rmSync(outsideRoot, { force: true, recursive: true });
});

function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    category: 'presentation',
    contract_version: '1.0',
    parameters: {},
    profile_id: 'profile-b',
    selection: { ids: ['WP_RP_HAPPY'] },
    target: { actor_name: 'wallet-under-test', actor_type: 'wallet' },
    timeout_ms: 60_000,
    ...overrides
  };
}

async function http(handle: ServeRunnerHandle, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${handle.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...init.headers }
  });
}

async function waitTerminal(handle: ServeRunnerHandle, runId: string): Promise<RunSnapshot> {
  for (let i = 0; i < 300; i++) {
    const snapshot = (await (await http(handle, `/v1/runs/${runId}`)).json()) as RunSnapshot;
    if (['cancelled', 'completed', 'error', 'timed_out'].includes(snapshot.status)) return snapshot;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('run did not reach a terminal state');
}

describe('native startup — real compiled CLI launch boundary', () => {
  it('launches process.execPath + resolved compiled CLI with the selected profile, assets and isolated paths', async () => {
    const { adapter, spawns } = harmlessAdapter((recorded) => [recorded.args[0] ?? '', '--version']);
    const stateDir = join(outsideRoot, 'state-launch');
    const handle = await serveRunner({
      host: '127.0.0.1',
      port: 0,
      processAdapter: adapter,
      profiles: profilesPath,
      stateDir
    });
    try {
      const capabilities = (await (await http(handle, '/v1/capabilities')).json()) as {
        engine: RunnerResult['engine'];
        profiles: { id: string }[];
      };
      expect(capabilities.profiles.map((p) => p.id)).toEqual(['profile-a', 'profile-b']);
      expect(JSON.stringify(capabilities)).not.toContain(outsideRoot);
      expect(capabilities.engine.version).toBe('0.0.1');

      const response = await http(handle, '/v1/runs', {
        body: JSON.stringify(request()),
        headers: { 'idempotency-key': 'launch-1' },
        method: 'POST'
      });
      expect(response.status).toBe(202);
      const { run_id: runId } = (await response.json()) as RunSnapshot;
      await waitTerminal(handle, runId);

      expect(spawns).toHaveLength(1);
      const launch = spawns[0] as Recorded;
      expect(launch.command).toBe(process.execPath);
      expect(launch.args).toEqual([compiledCli, 'test', 'presentation', '--verbose']);
      expect(launch.args[0]).not.toBe(process.argv[1]);
      const runRoot = join(stateDir, 'work', runId);
      expect(launch.options.cwd).toBe(runRoot);
      const env = launch.options.env;
      expect(env.ITWCT_CONFIG_PATH).toBe(fixtureB.configPath);
      expect(env.ITWCT_DATA_DIR).toBe(join(runRoot, 'data'));
      expect(env.ITWCT_RESULTS_DIR).toBe(join(runRoot, 'results'));
      expect(env.ITWCT_AUTOMATION_DIR).toBe(runRoot);
      expect(env.ITWCT_RUN_ID).toBe(runId);
      expect(env.ITWCT_PRESENTATION_SCENARIO_IDS).toBe('WP_RP_HAPPY');
      expect(env.ITWCT_REPOSITORY_ROOT).toBe(repoRoot);
      expect(env.CREDIMI_RUNNER_TOKEN, 'runner secret must not reach the native child').toBeUndefined();

      // Seeded assets are copies of the selected operator's init output.
      for (const asset of ['rp/jwks.json', 'trust-anchor/federation-cert.pem', 'tls/ca-cert.pem']) {
        expect(readFileSync(join(runRoot, 'data', asset))).toEqual(readFileSync(join(fixtureB.assetsDir, asset)));
      }
      expect(readFileSync(join(runRoot, 'data', 'rp/jwks.json'))).not.toEqual(
        readFileSync(join(fixtureA.assetsDir, 'rp/jwks.json'))
      );

      // The REAL compiled CLI ran from a cwd outside the Nx tree.
      const log = readFileSync(join(runRoot, 'diagnostics', NATIVE_DIAGNOSTICS_FILENAME), 'utf-8');
      expect(log.trim()).toBe('0.0.1');

      // No export was produced by `--version`: honest error, never a pass.
      const result = (await (await http(handle, `/v1/runs/${runId}/result`)).json()) as RunnerResult;
      expect(result.execution.status).toBe('error');
      expect(result.summary.result).toBe('not_tested');
      expect(result.profile_id).toBe('profile-b');
      expect(result.native.coverage_mode).toBe('it_wallet_profile');
      expect(result.limitations.some((l) => l.includes('engine.revision is unknown'))).toBe(true);
    } finally {
      await handle.close();
    }
  }, 60_000);

  it('rejects unknown profile, wrong category and unsupported selection before accepting work', async () => {
    const { adapter, spawns } = harmlessAdapter(() => ['-e', '']);
    const handle = await serveRunner({
      host: '127.0.0.1',
      port: 0,
      processAdapter: adapter,
      profiles: profilesPath,
      stateDir: join(outsideRoot, 'state-preflight')
    });
    try {
      const cases: [Partial<RunRequest>, string][] = [
        [{ profile_id: 'nope' }, 'UNKNOWN_PROFILE'],
        [{ category: 'issuance' }, 'CATEGORY_MISMATCH'],
        [{ selection: { ids: ['WP_090'] } }, 'UNSUPPORTED_SELECTION']
      ];
      for (const [overrides, code] of cases) {
        const response = await http(handle, '/v1/runs', {
          body: JSON.stringify(request(overrides)),
          headers: { 'idempotency-key': `bad-${code}` },
          method: 'POST'
        });
        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
      }
      expect(spawns).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });

  it('fails startup on a missing seed asset or config, leaving no lock behind', async () => {
    const broken = join(outsideRoot, 'operator-broken');
    cpSync(join(outsideRoot, 'operator-a'), broken, { recursive: true });
    unlinkSync(join(broken, 'data', 'rp', 'jwks.json'));
    const stateDir = join(outsideRoot, 'state-broken');
    const missingSeed = writeProfilesFile(join(outsideRoot, 'broken-seed.json'), [
      {
        allowedScenarioIds: ['WP_RP_HAPPY'],
        category: 'presentation',
        configPath: 'operator-broken/config.ini',
        coverageMode: 'interoperability',
        id: 'broken',
        initializedAssetsDir: 'operator-broken/data'
      }
    ]);
    await expect(serveRunner({ host: '127.0.0.1', port: 0, profiles: missingSeed, stateDir })).rejects.toThrow(
      /missing 1 required init asset/
    );
    const missingConfig = writeProfilesFile(join(outsideRoot, 'broken-config.json'), [
      {
        allowedScenarioIds: ['WP_RP_HAPPY'],
        category: 'presentation',
        configPath: 'operator-broken/absent.ini',
        coverageMode: 'interoperability',
        id: 'broken',
        initializedAssetsDir: 'operator-a/data'
      }
    ]);
    await expect(serveRunner({ host: '127.0.0.1', port: 0, profiles: missingConfig, stateDir })).rejects.toThrow(
      /config file not found/
    );
    const issuance = writeProfilesFile(join(outsideRoot, 'issuance.json'), [
      {
        allowedScenarioIds: ['WP_RP_HAPPY'],
        category: 'issuance',
        configPath: 'operator-a/config.ini',
        coverageMode: 'interoperability',
        id: 'issuance',
        initializedAssetsDir: 'operator-a/data'
      }
    ]);
    await expect(serveRunner({ host: '127.0.0.1', port: 0, profiles: issuance, stateDir })).rejects.toThrow(
      /not executable by this engine/
    );
    expect(existsSync(join(stateDir, '.owner.lock'))).toBe(false);
  });
});

describe('native worker — process hygiene at the real subprocess boundary', () => {
  const ctxFor = (runRoot: string, signal: AbortSignal) => ({
    abortSignal: signal,
    request: request({ profile_id: 'test' }),
    runId: 'run-hygiene',
    runRoot
  });

  it('a pre-aborted run never spawns', async () => {
    const { adapter, spawns } = harmlessAdapter(() => ['-e', '']);
    const controller = new AbortController();
    controller.abort();
    const execute = createNativeExecutor({ processAdapter: adapter, profile: loadedProfile(fixtureA) });
    const runRoot = join(outsideRoot, 'pre-abort');
    mkdirSync(runRoot);
    await expect(execute(ctxFor(runRoot, controller.signal))).rejects.toThrow(/aborted before/);
    expect(spawns).toHaveLength(0);
  });

  it('drains stdout larger than the pipe capacity without deadlock and bounds the private log', async () => {
    const script =
      "const c='x'.repeat(65536);for(let i=0;i<64;i++)process.stdout.write(c);process.stderr.write('done');";
    const { adapter } = harmlessAdapter(() => ['-e', script]);
    const execute = createNativeExecutor({ processAdapter: adapter, profile: loadedProfile(fixtureA) });
    const runRoot = join(outsideRoot, 'big-output');
    mkdirSync(runRoot);
    const evidence = await execute(ctxFor(runRoot, new AbortController().signal));
    const logPath = join(runRoot, 'diagnostics', NATIVE_DIAGNOSTICS_FILENAME);
    expect(readFileSync(logPath).length).toBe(MAX_DIAGNOSTIC_BYTES);
    expect(evidence.result.limitations.some((l) => l.includes('truncated'))).toBe(true);
    expect(evidence.result.execution.status).toBe('error');
  }, 30_000);

  it('abort kills the native process group (including descendants) before returning', async () => {
    const pidFile = join(outsideRoot, 'grandchild.pid');
    // The child spawns a grandchild in its own process group and both sleep.
    const script = `const {spawn}=require('node:child_process');const g=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(g.pid));setTimeout(()=>{},60000);`;
    const { adapter } = harmlessAdapter(() => ['-e', script]);
    const execute = createNativeExecutor({
      killGraceMs: 2_000,
      processAdapter: adapter,
      profile: loadedProfile(fixtureA)
    });
    const runRoot = join(outsideRoot, 'abort');
    mkdirSync(runRoot);
    const controller = new AbortController();
    const pending = execute(ctxFor(runRoot, controller.signal));
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    const grandchild = Number(readFileSync(pidFile, 'utf-8'));
    controller.abort();
    await pending;
    expect(() => process.kill(grandchild, 0)).toThrow();
  }, 30_000);

  it('SIGTERM handler closes the runner and releases its own lock', async () => {
    const stateDir = join(outsideRoot, 'state-signal');
    const handle = await serveRunner({ host: '127.0.0.1', port: 0, profiles: profilesPath, stateDir });
    expect(existsSync(join(stateDir, '.owner.lock'))).toBe(true);
    const closed = new Promise<number>((resolveClosed) => {
      installRunnerSignalHandlers(handle, resolveClosed);
    });
    process.emit('SIGTERM', 'SIGTERM');
    expect(await closed).toBe(0);
    expect(existsSync(join(stateDir, '.owner.lock'))).toBe(false);
    await expect(fetch(`${handle.url}/healthz`)).rejects.toThrow();
  });
});
