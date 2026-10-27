import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { registerSelectedScenario } from './selected-registration.js';

const require = createRequire(import.meta.url);
const vitestBin = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const packageRoot = resolve(import.meta.dirname, '../..');
const collectionConfig = resolve(import.meta.dirname, '__fixtures__/matrix-collection.config.mts');
const workDir = mkdtempSync(join(tmpdir(), 'itwct-matrix-collection-'));

const HAPPY_GROUP = 'Test Cases for Presentation Phase > Happy path — full remote presentation flow > ';
const CLEANUP_GROUP = 'Test Cases for Presentation Phase > Relying Party fault cleanup > ';

/** The happy-path payload/verdict tests the matrix registers for WP_RP_HAPPY. */
const HAPPY_REQUIREMENT_IDS = [
  'WP_076',
  'WP_082',
  'WP_091',
  'WP_092',
  'WP_093',
  'WP_093a',
  'WP_093b',
  'WP_093c',
  'WP_094'
];

interface CollectionResult {
  names: string[];
  output: string;
  status: null | number;
}

/**
 * Collects the REAL presentation matrix with Vitest's `list` command: the
 * module and its describe bodies run, but no hook or test body executes, so
 * no service, network or wallet is touched.
 */
function collectMatrix(env: Record<string, string | undefined>): CollectionResult {
  const outputFile = join(workDir, `collection-${Math.random().toString(36).slice(2)}.json`);
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'ITWCT_AUTOMATION_DIR',
    'ITWCT_RUN_ID',
    'ITWCT_PRESENTATION_SCENARIO_IDS',
    'VITEST',
    'VITEST_POOL_ID',
    'VITEST_WORKER_ID'
  ]) {
    delete childEnv[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) childEnv[key] = value;
  }

  const child = spawnSync(process.execPath, [vitestBin, 'list', '--config', collectionConfig, `--json=${outputFile}`], {
    cwd: packageRoot,
    encoding: 'utf-8',
    env: childEnv,
    timeout: 60_000
  });

  let names: string[] = [];
  try {
    const parsed = JSON.parse(readFileSync(outputFile, 'utf-8')) as { name: string }[];
    names = parsed.map((entry) => entry.name);
  } catch {
    names = [];
  }
  return { names, output: `${child.stdout}\n${child.stderr}`, status: child.status };
}

afterAll(() => {
  rmSync(workDir, { force: true, recursive: true });
});

describe('presentation matrix collection (real module, hooks not executed)', () => {
  it('automated WP_RP_HAPPY registers the full happy suite and no other scenario group', () => {
    const result = collectMatrix({
      ITWCT_AUTOMATION_DIR: workDir,
      ITWCT_PRESENTATION_SCENARIO_IDS: 'WP_RP_HAPPY',
      ITWCT_RUN_ID: 'run-collection-1'
    });

    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain('registerScenario is not defined');

    const happy = result.names.filter((name) => name.startsWith(HAPPY_GROUP));
    expect(happy.map((name) => /^\[([A-Z]+_\w+)\]/.exec(name.slice(HAPPY_GROUP.length))?.[1])).toEqual(
      HAPPY_REQUIREMENT_IDS
    );

    // Only the happy group plus the generic (non-normative) cleanup checks.
    const other = result.names.filter((name) => !name.startsWith(HAPPY_GROUP));
    expect(other.every((name) => name.startsWith(CLEANUP_GROUP))).toBe(true);
    expect(other).toHaveLength(2);
    // Cleanup checks carry no fabricated requirement ID.
    expect(other.some((name) => /\[[A-Z]+_\w+\]/.test(name))).toBe(false);
    expect(result.names).toHaveLength(HAPPY_REQUIREMENT_IDS.length + 2);
  }, 60_000);

  it('automated selection of a different scenario registers only that group', () => {
    const result = collectMatrix({
      ITWCT_AUTOMATION_DIR: workDir,
      ITWCT_PRESENTATION_SCENARIO_IDS: 'WP_090',
      ITWCT_RUN_ID: 'run-collection-2'
    });

    expect(result.status, result.output).toBe(0);
    const scenarioTests = result.names.filter((name) => !name.startsWith(CLEANUP_GROUP));
    expect(scenarioTests).toHaveLength(1);
    expect(scenarioTests[0]).toContain('[WP_090]');
    expect(result.names.some((name) => name.startsWith(HAPPY_GROUP))).toBe(false);
  }, 60_000);

  it('automated run with an empty selection fails collection instead of registering everything', () => {
    const result = collectMatrix({ ITWCT_AUTOMATION_DIR: workDir, ITWCT_RUN_ID: 'run-collection-3' });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('Automated presentation run requires');
  }, 60_000);

  it('automated run with an unknown scenario ID fails collection', () => {
    const result = collectMatrix({
      ITWCT_AUTOMATION_DIR: workDir,
      ITWCT_PRESENTATION_SCENARIO_IDS: 'WP_DOES_NOT_EXIST',
      ITWCT_RUN_ID: 'run-collection-4'
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('Automated presentation run requires');
  }, 60_000);

  it('human mode (no automation env) still registers every scenario group', () => {
    const result = collectMatrix({});

    expect(result.status, result.output).toBe(0);
    for (const id of [
      ...HAPPY_REQUIREMENT_IDS,
      'WP_079',
      'WP_080',
      'WP_081',
      'WP_087',
      'WP_090',
      'WP_091a',
      'WP_094a'
    ]) {
      expect(
        result.names.some((name) => name.includes(`[${id}]`)),
        `${id} should be registered in human mode`
      ).toBe(true);
    }
    expect(result.names.filter((name) => name.startsWith(HAPPY_GROUP))).toHaveLength(HAPPY_REQUIREMENT_IDS.length);
  }, 60_000);
});

describe('registerSelectedScenario helper', () => {
  it('calls register when selected', () => {
    let registerCount = 0;
    let skippedCount = 0;
    registerSelectedScenario(
      { automated: true, selected: true },
      () => registerCount++,
      () => skippedCount++
    );
    expect(registerCount).toBe(1);
    expect(skippedCount).toBe(0);
  });

  it('does not register when excluded in automated mode', () => {
    let registerCount = 0;
    let skippedCount = 0;
    registerSelectedScenario(
      { automated: true, selected: false },
      () => registerCount++,
      () => skippedCount++
    );
    expect(registerCount).toBe(0);
    expect(skippedCount).toBe(0);
  });

  it('registers skipped in human mode when not selected', () => {
    let registerCount = 0;
    let skippedCount = 0;
    registerSelectedScenario(
      { automated: false, selected: false },
      () => registerCount++,
      () => skippedCount++
    );
    expect(registerCount).toBe(0);
    expect(skippedCount).toBe(1);
  });
});
