import { describe, expect, it } from 'vitest';

import { extractDescription, extractRequirementId } from './requirement-id.js';

describe('extractRequirementId', () => {
  it('extracts unbracketed IDs', () => {
    expect(extractRequirementId('WP_082: description')).toBe('WP_082');
    expect(extractRequirementId('CI_002: test')).toBe('CI_002');
  });

  it('extracts bracketed IDs', () => {
    expect(extractRequirementId('[WP_082]: description')).toBe('WP_082');
    expect(extractRequirementId('[CI_002]: test')).toBe('CI_002');
  });

  it('extracts IDs with suffix letters', () => {
    expect(extractRequirementId('WP_082a: test')).toBe('WP_082a');
    expect(extractRequirementId('CI_015b: test')).toBe('CI_015b');
  });

  it('returns null for generic titles', () => {
    expect(extractRequirementId('generic smoke test')).toBeNull();
    expect(extractRequirementId('completes the flow')).toBeNull();
  });

  it('returns null when ID is not at start', () => {
    expect(extractRequirementId('test WP_082: something')).toBeNull();
  });
});

describe('extractDescription', () => {
  it('strips unbracketed ID prefix', () => {
    expect(extractDescription('WP_082: description')).toBe('description');
  });

  it('strips bracketed ID prefix', () => {
    expect(extractDescription('[WP_082]: description')).toBe('description');
  });

  it('returns title unchanged when no ID', () => {
    expect(extractDescription('generic test')).toBe('generic test');
  });
});
