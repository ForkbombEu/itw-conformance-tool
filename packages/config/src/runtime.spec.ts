import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, expandPath, loadConfig } from '../src/index.js';

function makeIni(overrides: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    'global.data_dir': './data',
    'global.log_level': 'INFO',
    'relying-party.url': 'https://rp.example',
    'trust-anchor.entity_id': 'https://ta.example',
    'credential-issuer.url': 'https://issuer.example',
    'wallet-provider.local_url': 'https://wp.example',
    ...overrides
  };

  const sections: Record<string, string[]> = {
    global: [],
    'relying-party': [],
    'trust-anchor': [],
    'credential-issuer': [],
    'wallet-provider': []
  };

  for (const [key, value] of Object.entries(base)) {
    const dotIndex = key.indexOf('.');
    const section = key.slice(0, dotIndex);
    const field = key.slice(dotIndex + 1);
    const lines = sections[section];
    if (lines) {
      lines.push(`${field} = ${value}`);
    }
  }

  return Object.entries(sections)
    .filter(([, lines]) => lines.length > 0)
    .map(([section, lines]) => `[${section}]\n${lines.join('\n')}`)
    .join('\n\n');
}

let tempA: string;
let tempB: string;
let savedEnv: Record<string, undefined | string>;

beforeEach(() => {
  tempA = mkdtempSync(join(tmpdir(), 'wct-cfg-a-'));
  tempB = mkdtempSync(join(tmpdir(), 'wct-cfg-b-'));
  savedEnv = {
    ITWCT_CONFIG_PATH: process.env.ITWCT_CONFIG_PATH,
    ITWCT_DATA_DIR: process.env.ITWCT_DATA_DIR
  };
  Reflect.deleteProperty(process.env, 'ITWCT_CONFIG_PATH');
  Reflect.deleteProperty(process.env, 'ITWCT_DATA_DIR');
});

afterEach(() => {
  rmSync(tempA, { force: true, recursive: true });
  rmSync(tempB, { force: true, recursive: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) {
      Reflect.deleteProperty(process.env, k);
    } else {
      process.env[k] = v;
    }
  }
});

function writeConfig(dir: string, name: string, overrides: Record<string, string>): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, makeIni(overrides), 'utf8');
  return filePath;
}

describe('loadConfig — explicit options', () => {
  it('loads from explicit configPath', () => {
    const configPath = writeConfig(tempA, 'my-config.ini', {
      'trust-anchor.entity_id': 'https://ta-a.example'
    });
    const config = loadConfig({ configPath });
    expect(config['trust-anchor'].entity_id).toBe('https://ta-a.example');
  });

  it('resolves relative configPath against cwd', () => {
    writeConfig(tempA, 'my-config.ini', {
      'trust-anchor.entity_id': 'https://ta-rel.example'
    });
    const config = loadConfig({ configPath: 'my-config.ini', cwd: tempA });
    expect(config['trust-anchor'].entity_id).toBe('https://ta-rel.example');
  });

  it('uses absolute configPath directly', () => {
    const configPath = writeConfig(tempA, 'abs-config.ini', {
      'trust-anchor.entity_id': 'https://ta-abs.example'
    });
    const config = loadConfig({ configPath });
    expect(config['trust-anchor'].entity_id).toBe('https://ta-abs.example');
  });

  it('applies explicit dataDir override', () => {
    const configPath = writeConfig(tempA, 'config.ini', {});
    const customDataDir = join(tempA, 'custom-data');
    const config = loadConfig({ configPath, dataDir: customDataDir });
    expect(config.global.data_dir).toBe(customDataDir);
  });

  it('missing explicit configPath throws', () => {
    expect(() => loadConfig({ configPath: join(tempA, 'nonexistent.ini') })).toThrow(/Config file not found/);
  });
});

describe('loadConfig — env overrides', () => {
  it('ITWCT_CONFIG_PATH overrides default', () => {
    const configPath = writeConfig(tempA, 'env-config.ini', {
      'trust-anchor.entity_id': 'https://ta-env.example'
    });
    process.env.ITWCT_CONFIG_PATH = configPath;
    const config = loadConfig({ cwd: tempA });
    expect(config['trust-anchor'].entity_id).toBe('https://ta-env.example');
  });

  it('ITWCT_DATA_DIR overrides config data_dir', () => {
    const configPath = writeConfig(tempA, 'config.ini', {});
    const envDataDir = join(tempA, 'env-data');
    process.env.ITWCT_DATA_DIR = envDataDir;
    const config = loadConfig({ configPath });
    expect(config.global.data_dir).toBe(envDataDir);
  });

  it('explicit option takes precedence over env', () => {
    const envConfigPath = writeConfig(tempA, 'env-config.ini', {
      'trust-anchor.entity_id': 'https://ta-env.example'
    });
    const explicitConfigPath = writeConfig(tempB, 'explicit-config.ini', {
      'trust-anchor.entity_id': 'https://ta-explicit.example'
    });
    process.env.ITWCT_CONFIG_PATH = envConfigPath;
    const config = loadConfig({ configPath: explicitConfigPath });
    expect(config['trust-anchor'].entity_id).toBe('https://ta-explicit.example');
  });

  it('empty env string counts as absent', () => {
    const configPath = writeConfig(tempA, 'config.ini', {
      'trust-anchor.entity_id': 'https://ta-default.example'
    });
    process.env.ITWCT_CONFIG_PATH = '';
    const config = loadConfig({ configPath });
    expect(config['trust-anchor'].entity_id).toBe('https://ta-default.example');
  });
});

describe('loadConfig — independence between roots', () => {
  it('loading A, B, A produces independent configs', () => {
    const configA = writeConfig(tempA, 'config.ini', {
      'trust-anchor.entity_id': 'https://ta-a.example'
    });
    const configB = writeConfig(tempB, 'config.ini', {
      'trust-anchor.entity_id': 'https://ta-b.example'
    });

    const first = loadConfig({ configPath: configA });
    expect(first['trust-anchor'].entity_id).toBe('https://ta-a.example');

    const second = loadConfig({ configPath: configB });
    expect(second['trust-anchor'].entity_id).toBe('https://ta-b.example');

    const third = loadConfig({ configPath: configA });
    expect(third['trust-anchor'].entity_id).toBe('https://ta-a.example');

    // No cached leakage
    expect(first).not.toBe(second);
    expect(first['trust-anchor'].entity_id).not.toBe(second['trust-anchor'].entity_id);
  });

  it('different data directories remain independent', () => {
    const configA = writeConfig(tempA, 'config.ini', {});
    const configB = writeConfig(tempB, 'config.ini', {});

    const first = loadConfig({ configPath: configA, dataDir: join(tempA, 'data-a') });
    const second = loadConfig({ configPath: configB, dataDir: join(tempB, 'data-b') });

    expect(first.global.data_dir).toBe(join(tempA, 'data-a'));
    expect(second.global.data_dir).toBe(join(tempB, 'data-b'));
    expect(first.global.data_dir).not.toBe(second.global.data_dir);
  });
});

describe('loadConfig — return value immutability', () => {
  it('returns a new object without mutating DEFAULT_CONFIG', () => {
    const configPath = writeConfig(tempA, 'config.ini', {});
    const config = loadConfig({ configPath, dataDir: '/tmp/should-not-mutate' });

    expect(DEFAULT_CONFIG.global.data_dir).not.toBe('/tmp/should-not-mutate');
    expect(config.global.data_dir).toBe('/tmp/should-not-mutate');
  });
});

describe('expandPath', () => {
  it('resolves relative paths against cwd', () => {
    expect(expandPath('data', '/tmp/test')).toBe('/tmp/test/data');
  });

  it('resolves absolute paths as-is', () => {
    expect(expandPath('/abs/path')).toBe('/abs/path');
  });

  it('expands ~ to homedir', () => {
    expect(expandPath('~')).toBeTruthy();
  });
});
