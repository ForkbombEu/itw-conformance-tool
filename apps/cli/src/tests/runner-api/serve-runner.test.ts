import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { serveRunner } from '../../commands/serveRunner.js';
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
