import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { serveRunner } from '../../commands/serveRunner.js';

let tempDir: string;
let savedToken: undefined | string;

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
  const p = join(tempDir, 'profiles.json');
  writeFileSync(
    p,
    JSON.stringify({
      profiles: [
        {
          allowedScenarioIds: ['WP_RP_HAPPY'],
          category: 'presentation',
          configPath: '/abs/config.ini',
          coverageMode: 'interoperability',
          id: 'test'
        }
      ]
    })
  );
  return p;
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

  it('starts and stops cleanly', async () => {
    process.env.CREDIMI_RUNNER_TOKEN = 'test-token';
    const handle = await serveRunner({
      host: '127.0.0.1',
      port: 0,
      profiles: writeProfiles(),
      stateDir: join(tempDir, 'state')
    });
    expect(handle.url).toContain('127.0.0.1:');
    await handle.close();
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
