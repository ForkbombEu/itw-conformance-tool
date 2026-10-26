import { describe, expect, it } from 'vitest';

import { isScenarioSelected, validateSelection } from './selection.js';

describe('validateSelection', () => {
  it('accepts known IDs', () => {
    const result = validateSelection({
      automated: true,
      requestedIds: ['WP_RP_HAPPY'],
      supportedIds: ['WP_RP_HAPPY', 'WP_CI_HAPPY']
    });
    expect(result.valid).toBe(true);
    expect(result.selectedIds).toEqual(['WP_RP_HAPPY']);
  });

  it('rejects empty selection', () => {
    expect(validateSelection({ automated: true, requestedIds: [], supportedIds: ['X'] }).valid).toBe(false);
  });

  it('rejects unknown IDs', () => {
    expect(validateSelection({ automated: true, requestedIds: ['EVIL'], supportedIds: ['X'] }).valid).toBe(false);
  });

  it('rejects duplicate IDs', () => {
    expect(validateSelection({ automated: true, requestedIds: ['X', 'X'], supportedIds: ['X'] }).valid).toBe(false);
  });

  it('accepts multiple known IDs', () => {
    const result = validateSelection({
      automated: true,
      requestedIds: ['A', 'B'],
      supportedIds: ['A', 'B', 'C']
    });
    expect(result.valid).toBe(true);
    expect(result.selectedIds).toEqual(['A', 'B']);
  });
});

describe('isScenarioSelected', () => {
  it('selected IDs are selected', () => {
    expect(isScenarioSelected('A', ['A'], true)).toBe(true);
    expect(isScenarioSelected('B', ['A'], true)).toBe(false);
  });

  it('empty selection in automated mode selects nothing', () => {
    expect(isScenarioSelected('A', [], true)).toBe(false);
  });

  it('empty selection in manual mode selects everything', () => {
    expect(isScenarioSelected('A', [], false)).toBe(true);
  });
});
