import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import { parseConfigIni } from './parser.js';

import type { ConfigSchemaType } from './schemas.js';

export const DEFAULT_CONFIG_FILE = 'config.ini';

export interface LoadConfigOptions {
  configPath?: string;
  cwd?: string;
  dataDir?: string;
}

export function expandPath(pathValue: string, cwd = process.cwd()): string {
  const normalizedPath = pathValue.replace(/["'`]+/g, '').trim();

  if (normalizedPath === '~') {
    return homedir();
  }

  if (normalizedPath.startsWith('~/')) {
    return resolve(homedir(), normalizedPath.slice(2));
  }

  return isAbsolute(normalizedPath) ? resolve(normalizedPath) : resolve(cwd, normalizedPath);
}

export function expandConfigDataDir(config: ConfigSchemaType, cwd = process.cwd()): ConfigSchemaType {
  return {
    ...config,
    global: {
      ...config.global,
      data_dir: expandPath(config.global.data_dir, cwd)
    }
  };
}

export function loadConfig(options?: LoadConfigOptions): ConfigSchemaType {
  const cwd = options?.cwd ?? process.cwd();

  // Resolve config path: explicit option > env override > default
  const envConfigPath = process.env.ITWCT_CONFIG_PATH?.trim();
  const configPath = options?.configPath
    ? expandPath(options.configPath, cwd)
    : envConfigPath
      ? expandPath(envConfigPath, cwd)
      : expandPath(DEFAULT_CONFIG_FILE, cwd);

  if (!existsSync(configPath)) {
    throw new Error(`Config file not found at path: ${configPath}`);
  }

  const config = parseConfigIni(configPath);

  // Resolve data_dir: explicit option > env override > config value
  const envDataDir = process.env.ITWCT_DATA_DIR?.trim();
  const dataDir = options?.dataDir
    ? expandPath(options.dataDir, cwd)
    : envDataDir
      ? expandPath(envDataDir, cwd)
      : undefined;

  const withDataDir: ConfigSchemaType = dataDir
    ? {
        ...config,
        global: {
          ...config.global,
          data_dir: dataDir
        }
      }
    : config;

  return expandConfigDataDir(withDataDir, cwd);
}
