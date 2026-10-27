import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { finalizeEvidence, serveRunner } from '../../commands/serveRunner.js';
import { ArtifactStore, type PrivateArtifact } from '../../runner-api/artifacts.js';
import { runnerResultSchema, type RunnerResult } from '../../runner-api/contract.js';
import { createOperatorFixture, type OperatorFixture, writeProfilesFile } from './helpers/operator-fixture.js';

let tempDir: string;
let savedToken: undefined | string;
let fixture: OperatorFixture;
const fixtureRoot = mkdtempSync(join(tmpdir(), 'wct-serve-operator-'));

beforeAll(async () => {
  fixture = await createOperatorFixture(fixtureRoot);
});

afterAll(() => {
  rmSync(fixtureRoot, { force: true, recursive: true });
});

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'wct-serve-'));
  savedToken = process.env.CREDIMI_RUNNER_TOKEN;
});

afterEach(() => {
  if (savedToken === undefined) {
    Reflect.deleteProperty(process.env, 'CREDIMI_RUNNER_TOKEN');
  } else {
    process.env.CREDIMI_RUNNER_TOKEN = savedToken;
  }
  rmSync(tempDir, { force: true, recursive: true });
});

function writeProfiles(): string {
  return writeProfilesFile(join(tempDir, 'profiles.json'), [
    {
      allowedScenarioIds: ['WP_RP_HAPPY'],
      category: 'presentation',
      configPath: fixture.configPath,
      coverageMode: 'interoperability',
      id: 'test',
      initializedAssetsDir: fixture.assetsDir
    }
  ]);
}

describe('serveRunner', () => {
  it('rejects missing token', async () => {
    Reflect.deleteProperty(process.env, 'CREDIMI_RUNNER_TOKEN');
    await expect(
      serveRunner({ host: '127.0.0.1', port: 0, profiles: writeProfiles(), stateDir: join(tempDir, 'state') })
    ).rejects.toThrow(/CREDIMI_RUNNER_TOKEN/);
  });

  it('rejects invalid port', async () => {
    process.env.CREDIMI_RUNNER_TOKEN = 'test';
    await expect(
      serveRunner({
        host: '127.0.0.1',
        port: 'abc' as unknown as number,
        profiles: writeProfiles(),
        stateDir: join(tempDir, 'state')
      })
    ).rejects.toThrow(/Invalid port/);
  });

  it('rejects nonexistent profiles', async () => {
    process.env.CREDIMI_RUNNER_TOKEN = 'test';
    await expect(
      serveRunner({ host: '127.0.0.1', port: 0, profiles: '/nonexistent.json', stateDir: join(tempDir, 'state') })
    ).rejects.toThrow(/not found/);
  });

  it('rejects an empty profiles list without taking the state lock', async () => {
    process.env.CREDIMI_RUNNER_TOKEN = 'test';
    const profiles = join(tempDir, 'empty.json');
    writeFileSync(profiles, JSON.stringify({ profiles: [] }));
    const stateDir = join(tempDir, 'state');
    await expect(serveRunner({ host: '127.0.0.1', port: 0, profiles, stateDir })).rejects.toThrow(/At least one/);
    expect(existsSync(join(stateDir, '.owner.lock'))).toBe(false);
  });

  it('starts and stops cleanly, reporting the actual bound port', async () => {
    process.env.CREDIMI_RUNNER_TOKEN = 'test-token';
    const handle = await serveRunner({
      host: '127.0.0.1',
      port: 0,
      profiles: writeProfiles(),
      stateDir: join(tempDir, 'state')
    });
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(handle.url).not.toMatch(/:0$/);
    await handle.close();
    expect(existsSync(join(tempDir, 'state', '.owner.lock'))).toBe(false);
  });

  it('denies second instance on same state dir', async () => {
    process.env.CREDIMI_RUNNER_TOKEN = 'test-token';
    const profiles = writeProfiles();
    const stateDir = join(tempDir, 'state');
    const h1 = await serveRunner({ host: '127.0.0.1', port: 0, profiles, stateDir });
    await expect(serveRunner({ host: '127.0.0.1', port: 0, profiles, stateDir })).rejects.toThrow(/locked/);
    await h1.close();
  });
});

describe('finalizeEvidence (second review finding 4)', () => {
  it('downgrades pass to inconclusive when evidence could not be published', () => {
    const artifacts = new ArtifactStore(join(tempDir, 'state'));
    const evidence = finalizeEvidence(artifacts, 'run-unpublished', {
      privateArtifacts: [
        {
          artifactId: 'native-results',
          filename: 'native-results.json',
          mimeType: 'application/json',
          path: join(tempDir, 'missing.json')
        }
      ],
      result: {
        artifacts: [],
        category: 'presentation',
        contract_version: '1.0',
        engine: {
          fork_repository: 'x',
          id: 'pagopa-itwct',
          revision: 'unknown',
          upstream_repository: 'x',
          version: 'x'
        },
        execution: { finished_at: '2026-01-01T00:00:01Z', started_at: '2026-01-01T00:00:00Z', status: 'completed' },
        limitations: [],
        native: {
          assertions: [
            {
              ancestor_titles: [],
              assertion_id: 'a0001',
              file: 'f.ts',
              full_title: 'x',
              native_status: 'PASS',
              phase: 'presentation'
            }
          ],
          coverage_mode: 'interoperability',
          native_suite_status: 'PASSED',
          scenario_outcomes: [],
          sessions: []
        },
        profile_id: 'test',
        run_id: 'run-unpublished',
        selection: { ids: ['WP_RP_HAPPY'] },
        summary: { assertion_count: 1, native_failed_assertion_count: 0, result: 'pass' },
        target: { actor_name: 'w', actor_type: 'wallet' }
      }
    });
    expect(evidence.result.artifacts).toEqual([]);
    expect(evidence.result.summary.result).toBe('inconclusive');
    expect(evidence.result.limitations.join(' ')).toContain('missing');
  });
});

// UNIT (R17): the production finalizer with the REAL artifact store; the worker
// evidence is a typed fixture, not a native run.
function passEvidence(runId: string, privateArtifacts: PrivateArtifact[], overrides: Partial<RunnerResult> = {}) {
  const result: RunnerResult = {
    artifacts: [],
    category: 'presentation',
    contract_version: '1.0',
    engine: { fork_repository: 'x', id: 'pagopa-itwct', revision: 'unknown', upstream_repository: 'x', version: 'x' },
    execution: { finished_at: '2026-01-01T00:00:01Z', started_at: '2026-01-01T00:00:00Z', status: 'completed' },
    limitations: ['engine.revision is unknown: no trusted build/source revision was supplied (ITWCT_SOURCE_REVISION).'],
    native: {
      assertions: [
        {
          ancestor_titles: [],
          assertion_id: 'a0001',
          file: 'f.ts',
          full_title: 'x',
          native_status: 'PASS',
          phase: 'presentation'
        }
      ],
      coverage_mode: 'interoperability',
      native_suite_status: 'PASSED',
      scenario_outcomes: [],
      sessions: []
    },
    profile_id: 'test',
    run_id: runId,
    selection: { ids: ['WP_RP_HAPPY'] },
    summary: { assertion_count: 1, native_failed_assertion_count: 0, result: 'pass' },
    target: { actor_name: 'w', actor_type: 'wallet' },
    ...overrides
  };
  return { privateArtifacts, result };
}

function declaredAt(path: string): PrivateArtifact {
  return { artifactId: 'native-results', filename: 'native-results.json', mimeType: 'application/json', path };
}

describe('finalizeEvidence publication outcome (R17, UNIT)', () => {
  it('carries the typed publication failure as an internal aggregation input, not a wire field', () => {
    const evidence = finalizeEvidence(
      new ArtifactStore(join(tempDir, 'state')),
      'run-missing',
      passEvidence('run-missing', [declaredAt(join(tempDir, 'missing.json'))])
    );
    expect(evidence.publicationFailures).toEqual([
      { artifactId: 'native-results', filename: 'native-results.json', reason: 'missing' }
    ]);
    expect(evidence.result.summary.result).toBe('inconclusive');
    expect(evidence.result.native.assertions.map((a) => a.native_status)).toEqual(['PASS']);
    expect(evidence.result.native.native_suite_status).toBe('PASSED');
    expect(evidence.result.execution.status).toBe('completed');
    expect(runnerResultSchema.safeParse(evidence.result).success).toBe(true);
    expect(JSON.stringify(evidence.result)).not.toContain('publicationFailures');
  });

  it('a benign limitation alone (unknown source revision) with a published artifact keeps a real pass', () => {
    const path = join(tempDir, 'native.json');
    writeFileSync(path, '{"ok":true}');
    const evidence = finalizeEvidence(
      new ArtifactStore(join(tempDir, 'state')),
      'run-ok',
      passEvidence('run-ok', [declaredAt(path)])
    );
    expect(evidence.publicationFailures ?? []).toEqual([]);
    expect(evidence.result.summary.result).toBe('pass');
    expect(evidence.result.artifacts).toHaveLength(1);
    expect(evidence.result.limitations.join(' ')).toContain('engine.revision is unknown');
  });

  it('a native fail with a missing artifact stays fail (no invented downgrade/upgrade)', () => {
    const evidence = finalizeEvidence(
      new ArtifactStore(join(tempDir, 'state')),
      'run-fail',
      passEvidence('run-fail', [declaredAt(join(tempDir, 'missing.json'))], {
        summary: { assertion_count: 1, native_failed_assertion_count: 1, result: 'fail' }
      })
    );
    expect(evidence.result.summary.result).toBe('fail');
    expect(evidence.publicationFailures?.map((f) => f.reason)).toEqual(['missing']);
  });

  it('an exception from the publication path yields an honest readable result, keeping native data', () => {
    // An unsafe run ID makes the real store throw before any copy.
    const evidence = finalizeEvidence(
      new ArtifactStore(join(tempDir, 'state')),
      'bad/run',
      passEvidence('bad/run', [declaredAt(join(tempDir, 'missing.json'))])
    );
    expect(evidence.result.summary.result).toBe('inconclusive');
    expect(evidence.result.native.assertions).toHaveLength(1);
    expect(evidence.result.artifacts).toEqual([]);
    expect(evidence.publicationFailures?.map((f) => f.reason)).toEqual(['write_failed']);
    expect(evidence.result.limitations.join(' ')).toContain('Unsafe run ID');
    expect(runnerResultSchema.safeParse(evidence.result).success).toBe(true);
  });
});
