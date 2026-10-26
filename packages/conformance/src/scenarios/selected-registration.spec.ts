import { describe, expect, it } from 'vitest';

import { registerSelectedScenario } from './selected-registration.js';

describe('registerSelectedScenario', () => {
  it('selected=true calls register exactly once', () => {
    let registerCount = 0;
    let skippedCount = 0;
    registerSelectedScenario(
      { automated: false, selected: true },
      () => registerCount++,
      () => skippedCount++
    );
    expect(registerCount).toBe(1);
    expect(skippedCount).toBe(0);
  });

  it('selected=false, automated=false calls registerSkipped', () => {
    let registerCount = 0;
    let skippedCount = 0;
    registerSelectedScenario(
      { automated: false, selected: false },
      () => registerCount++,
      () => skippedCount++
    );
    expect(registerCount).toBe(0);
    expect(skippedCount).toBe(1);
  });

  it('selected=false, automated=true calls neither', () => {
    let registerCount = 0;
    let skippedCount = 0;
    registerSelectedScenario(
      { automated: true, selected: false },
      () => registerCount++,
      () => skippedCount++
    );
    expect(registerCount).toBe(0);
    expect(skippedCount).toBe(0);
  });

  it('selected=true, automated=true calls register', () => {
    let registerCount = 0;
    let skippedCount = 0;
    registerSelectedScenario(
      { automated: true, selected: true },
      () => registerCount++,
      () => skippedCount++
    );
    expect(registerCount).toBe(1);
    expect(skippedCount).toBe(0);
  });
});
