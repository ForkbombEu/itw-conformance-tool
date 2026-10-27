import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { readPackageVersion } from '@itw-conformance-tool/utils';

import type { RunnerResult } from './contract.js';

const CLI_PACKAGE_NAME = 'itw-conformance-cli';

/**
 * Init asset layout (`itwct init`) the local Trust Anchor, Relying Party,
 * Credential Issuer and Wallet Provider read from their data directory.
 */
const INIT_ASSET_DIRECTORIES = ['issuer', 'rp', 'trust-anchor', 'tls', 'wallet-provider'] as const;

export function requiredAssetPaths(assetsDir: string): string[] {
  return [
    'issuer/jwks.json',
    'issuer/jwks-intermediate.json',
    'issuer/intermediate-cert.pem',
    'issuer/cert.pem',
    'rp/jwks.json',
    'rp/cert.pem',
    'rp/enc-cert.pem',
    'rp/federation-key.jwk.json',
    'rp/federation-cert.pem',
    'wallet-provider/jwks.json',
    'wallet-provider/jwks-intermediate.json',
    'wallet-provider/intermediate-cert.pem',
    'wallet-provider/cert.pem',
    'trust-anchor/federation-key.jwk.json',
    'trust-anchor/federation-cert.pem',
    'tls/ca-cert.pem',
    'tls/ca-key.pem'
  ].map((relative) => join(assetsDir, relative));
}

/**
 * Copies the operator's initialized keys/certificates into a fresh per-run
 * data directory. The originals are never modified; existing files in the
 * destination are never overwritten, and nothing is generated.
 */
export function provisionInitializedAssets(sourceDir: string, dataDir: string): void {
  const missing = requiredAssetPaths(sourceDir).filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(`Initialized assets are incomplete: ${missing.length} required file(s) missing`);
  }
  mkdirSync(dataDir, { recursive: true });
  for (const directory of INIT_ASSET_DIRECTORIES) {
    const source = join(sourceDir, directory);
    if (!existsSync(source)) continue;
    cpSync(source, join(dataDir, directory), { errorOnExist: true, force: false, recursive: true });
  }
}

/** Finds this CLI package's root from the module location (source or dist). */
export function resolveCliPackageRoot(moduleDir = import.meta.dirname): string {
  let directory = resolve(moduleDir);
  while (true) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      const name = (JSON.parse(readFileSync(manifest, 'utf-8')) as { name?: string }).name;
      if (name === CLI_PACKAGE_NAME) return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate the ${CLI_PACKAGE_NAME} package from ${moduleDir}`);
    directory = parent;
  }
}

/** The compiled CLI entrypoint, resolved independently of process.argv[1] and cwd. */
export function resolveCliEntry(moduleDir = import.meta.dirname): string {
  const entry = join(resolveCliPackageRoot(moduleDir), 'dist', 'main.js');
  if (!existsSync(entry)) {
    throw new Error(`Compiled CLI entrypoint not found at ${entry}; run \`pnpm nx run itw-conformance-cli:build\``);
  }
  return entry;
}

/** The Nx workspace that owns the CLI, used for services and the Vitest matrix. */
export function resolveRepositoryRoot(moduleDir = import.meta.dirname): string {
  let directory = resolveCliPackageRoot(moduleDir);
  while (!existsSync(join(directory, 'nx.json'))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Cannot locate the Nx workspace root of the CLI package');
    directory = parent;
  }
  return directory;
}

const ENGINE_REPOSITORIES = {
  fork_repository: 'https://github.com/ForkbombEu/itw-conformance-tool',
  id: 'pagopa-itwct',
  upstream_repository: 'https://github.com/pagopa/itw-conformance-tool'
} as const;

export const SOURCE_REVISION_ENV_VAR = 'ITWCT_SOURCE_REVISION';

export interface EngineIdentity {
  engine: RunnerResult['engine'];
  limitations: string[];
}

/**
 * Engine identity from actual metadata: the workspace package version read
 * from disk and a source revision supplied at startup. Never a session UUID
 * or a fabricated hash; unknown values carry an explicit limitation.
 */
export function resolveEngineIdentity(env: NodeJS.ProcessEnv = process.env): EngineIdentity {
  const limitations: string[] = [];
  let version = 'unknown';
  try {
    version = readPackageVersion(import.meta.dirname);
  } catch {
    limitations.push('engine.version is unknown: the workspace package manifest could not be read.');
  }
  const suppliedRevision = env[SOURCE_REVISION_ENV_VAR]?.trim().toLowerCase();
  let revision = 'unknown';
  if (suppliedRevision && /^[0-9a-f]{7,64}$/.test(suppliedRevision)) {
    revision = suppliedRevision;
  } else {
    limitations.push(
      `engine.revision is unknown: no trusted build/source revision was supplied (${SOURCE_REVISION_ENV_VAR}).`
    );
  }
  return { engine: { ...ENGINE_REPOSITORIES, revision, version }, limitations };
}
