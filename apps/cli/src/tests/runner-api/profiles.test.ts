import { describe, expect, it } from 'vitest';

import { assertSelectionAllowed, ProfileError, validateProfile } from '../../runner-api/profiles.js';

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    allowedScenarioIds: ['WP_RP_HAPPY'],
    category: 'presentation',
    configPath: '/abs/config.ini',
    coverageMode: 'interoperability',
    id: 'test-profile',
    ...overrides
  };
}

describe('validateProfile', () => {
  it('accepts valid profile', () => {
    const profile = validateProfile(makeProfile());
    expect(profile.id).toBe('test-profile');
    expect(profile.coverageMode).toBe('interoperability');
  });

  it('rejects unknown fields', () => {
    expect(() => validateProfile(makeProfile({ evil: true }))).toThrow(ProfileError);
  });

  it('rejects invalid ID', () => {
    expect(() => validateProfile(makeProfile({ id: '../evil' }))).toThrow(ProfileError);
  });

  it('rejects empty allowedScenarioIds', () => {
    expect(() => validateProfile(makeProfile({ allowedScenarioIds: [] }))).toThrow(ProfileError);
  });

  it('rejects invalid category', () => {
    expect(() => validateProfile(makeProfile({ category: 'evil' }))).toThrow(ProfileError);
  });
});

describe('assertSelectionAllowed', () => {
  it('allows permitted scenario', () => {
    const profile = validateProfile(makeProfile());
    expect(() => assertSelectionAllowed(profile, ['WP_RP_HAPPY'])).not.toThrow();
  });

  it('rejects unpermitted scenario', () => {
    const profile = validateProfile(makeProfile());
    expect(() => assertSelectionAllowed(profile, ['OTHER'])).toThrow(ProfileError);
  });
});
