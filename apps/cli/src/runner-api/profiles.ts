import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { loadConfig } from '@itw-conformance-tool/config';
import { z } from 'zod';

import { checkNewEngineCapability, RunnerError } from './contract.js';
import { requiredAssetPaths } from './native-launch.js';

import type { RunRequest } from './contract.js';

const profileSchema = z
  .object({
    allowedScenarioIds: z.array(z.string().min(1)).min(1),
    category: z.enum(['issuance', 'presentation']),
    configPath: z.string().min(1),
    coverageMode: z.enum(['interoperability', 'it_wallet_profile']),
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    initializedAssetsDir: z.string().optional(),
    publicOrigins: z.array(z.string().url()).optional()
  })
  .strict();

export type Profile = z.infer<typeof profileSchema>;

/** A startup-validated operator profile: every path is absolute and exists. */
export interface LoadedProfile extends Profile {
  configPath: string;
  initializedAssetsDir: string;
}

/** Public, path-free description of a loaded profile for /v1/capabilities. */
export interface PublicProfileDescriptor {
  allowed_selection_ids: string[];
  category: Profile['category'];
  coverage_mode: Profile['coverageMode'];
  id: string;
}

/** Scenario IDs the native presentation worker can actually execute unattended. */
export const SUPPORTED_SCENARIO_IDS: readonly string[] = ['WP_RP_HAPPY'];

export class ProfileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProfileError';
    this.code = code;
  }
}

export function validateProfile(raw: unknown): Profile {
  const result = profileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ProfileError('INVALID_PROFILE', `Invalid profile: ${issues}`);
  }
  return result.data;
}

export function assertSelectionAllowed(profile: Profile, scenarioIds: string[]): void {
  for (const id of scenarioIds) {
    if (!profile.allowedScenarioIds.includes(id)) {
      throw new ProfileError('SELECTION_NOT_ALLOWED', `Scenario '${id}' is not allowed by profile '${profile.id}'`);
    }
  }
}

function resolveFrom(baseDir: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(baseDir, value);
}

/**
 * Validates one profile against what the native worker can execute and
 * resolves its operator paths (relative to the profiles file directory).
 */
function loadProfile(raw: unknown, baseDir: string): LoadedProfile {
  const profile = validateProfile(raw);

  if (profile.category !== 'presentation') {
    throw new ProfileError(
      'UNSUPPORTED_PROFILE',
      `Profile '${profile.id}': category '${profile.category}' is not executable by this engine (presentation only)`
    );
  }
  const unsupported = profile.allowedScenarioIds.filter((id) => !SUPPORTED_SCENARIO_IDS.includes(id));
  if (unsupported.length > 0) {
    throw new ProfileError(
      'UNSUPPORTED_PROFILE',
      `Profile '${profile.id}': unsupported scenario IDs ${unsupported.join(', ')} (supported: ${SUPPORTED_SCENARIO_IDS.join(', ')})`
    );
  }

  const configPath = resolveFrom(baseDir, profile.configPath);
  if (!existsSync(configPath) || !statSync(configPath).isFile()) {
    throw new ProfileError('PROFILE_CONFIG_MISSING', `Profile '${profile.id}': config file not found`);
  }
  try {
    // Parse/validate the INI exactly as the native child will.
    loadConfig({ configPath });
  } catch (error) {
    throw new ProfileError(
      'PROFILE_CONFIG_INVALID',
      `Profile '${profile.id}': config file is invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!profile.initializedAssetsDir) {
    throw new ProfileError(
      'PROFILE_ASSETS_MISSING',
      `Profile '${profile.id}': initializedAssetsDir (an \`itwct init\` data directory) is required`
    );
  }
  const initializedAssetsDir = resolveFrom(baseDir, profile.initializedAssetsDir);
  const missing = requiredAssetPaths(initializedAssetsDir).filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new ProfileError(
      'PROFILE_ASSETS_MISSING',
      `Profile '${profile.id}': initializedAssetsDir is missing ${missing.length} required init asset(s)`
    );
  }

  return { ...profile, configPath, initializedAssetsDir };
}

/** The single startup-loaded catalogue used by capabilities, HTTP preflight and worker dispatch. */
export class ProfileCatalogue {
  private readonly byId: ReadonlyMap<string, LoadedProfile>;

  constructor(profiles: readonly LoadedProfile[]) {
    if (profiles.length === 0) throw new ProfileError('NO_PROFILES', 'At least one operator profile is required');
    const byId = new Map<string, LoadedProfile>();
    for (const profile of profiles) {
      if (byId.has(profile.id)) {
        throw new ProfileError('DUPLICATE_PROFILE', `Duplicate profile id '${profile.id}'`);
      }
      byId.set(profile.id, profile);
    }
    this.byId = byId;
  }

  get(id: string): LoadedProfile | undefined {
    return this.byId.get(id);
  }

  list(): LoadedProfile[] {
    return [...this.byId.values()];
  }

  publicDescriptors(): PublicProfileDescriptor[] {
    return this.list().map((profile) => ({
      allowed_selection_ids: [...profile.allowedScenarioIds],
      category: profile.category,
      coverage_mode: profile.coverageMode,
      id: profile.id
    }));
  }

  /** Rejects a request the worker cannot execute, before any job is accepted. */
  preflight(request: RunRequest): LoadedProfile {
    const profile = this.byId.get(request.profile_id);
    if (!profile) {
      throw new RunnerError('UNKNOWN_PROFILE', 400, `Unknown profile_id '${request.profile_id}'`);
    }
    if (request.category !== profile.category) {
      throw new RunnerError(
        'CATEGORY_MISMATCH',
        400,
        `Profile '${profile.id}' serves category '${profile.category}', not '${request.category}'`
      );
    }
    const capability = checkNewEngineCapability(request);
    if (!capability.ok) throw new RunnerError('UNSUPPORTED_SELECTION', 400, capability.reason ?? 'Unsupported');
    try {
      assertSelectionAllowed(profile, request.selection.ids);
    } catch (error) {
      throw new RunnerError('UNSUPPORTED_SELECTION', 400, error instanceof Error ? error.message : String(error));
    }
    return profile;
  }
}

/** Loads and validates the operator profiles file; fails visibly on any invalid input. */
export function loadProfileCatalogue(profilesPath: string): ProfileCatalogue {
  const absolute = resolve(profilesPath);
  if (!existsSync(absolute)) throw new ProfileError('PROFILES_NOT_FOUND', `Profiles file not found: ${absolute}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absolute, 'utf-8'));
  } catch {
    throw new ProfileError('INVALID_PROFILES_FILE', `Profiles file is not valid JSON: ${absolute}`);
  }
  const profiles = (raw as { profiles?: unknown }).profiles;
  if (!Array.isArray(profiles)) {
    throw new ProfileError('INVALID_PROFILES_FILE', 'Profiles file must contain a "profiles" array');
  }
  const baseDir = dirname(absolute);
  return new ProfileCatalogue(profiles.map((profile) => loadProfile(profile, baseDir)));
}
