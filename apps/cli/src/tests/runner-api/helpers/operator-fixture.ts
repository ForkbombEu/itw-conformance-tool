import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { init } from '../../../commands/init.js';
import { ProfileCatalogue, type LoadedProfile } from '../../../runner-api/profiles.js';

export interface OperatorFixture {
  assetsDir: string;
  configPath: string;
}

/**
 * Creates a real operator workspace with the production `itwct init`: a
 * config.ini from the shipped template plus initialized keys/certificates.
 */
export async function createOperatorFixture(root: string): Promise<OperatorFixture> {
  mkdirSync(root, { recursive: true });
  const assetsDir = join(root, 'data');
  const write = process.stdout.write;
  // init() reports progress on stdout; keep test output readable.
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await init({ cwd: root, dataDir: assetsDir, force: false });
  } finally {
    process.stdout.write = write;
  }
  return { assetsDir, configPath: join(root, 'config.ini') };
}

export function loadedProfile(fixture: OperatorFixture, overrides: Partial<LoadedProfile> = {}): LoadedProfile {
  return {
    allowedScenarioIds: ['WP_RP_HAPPY'],
    category: 'presentation',
    configPath: fixture.configPath,
    coverageMode: 'interoperability',
    id: 'test',
    initializedAssetsDir: fixture.assetsDir,
    ...overrides
  };
}

export function catalogueOf(...profiles: LoadedProfile[]): ProfileCatalogue {
  return new ProfileCatalogue(profiles);
}

/** Writes an operator profiles JSON file with the given (possibly relative) entries. */
export function writeProfilesFile(path: string, profiles: Record<string, unknown>[]): string {
  writeFileSync(path, JSON.stringify({ profiles }, null, 2));
  return path;
}

/**
 * Catalogue for HTTP/JobManager unit tests that inject an ExecuteFn: the
 * paths are never opened because no native worker runs in those tests.
 */
export function stubCatalogue(id = 'test'): ProfileCatalogue {
  return catalogueOf({
    allowedScenarioIds: ['WP_RP_HAPPY'],
    category: 'presentation',
    configPath: '/unused/config.ini',
    coverageMode: 'interoperability',
    id,
    initializedAssetsDir: '/unused/data'
  });
}

export const TEST_ENGINE = {
  fork_repository: 'https://github.com/ForkbombEu/itw-conformance-tool',
  id: 'pagopa-itwct',
  revision: 'unknown',
  upstream_repository: 'https://github.com/pagopa/itw-conformance-tool',
  version: '0.0.1'
};
