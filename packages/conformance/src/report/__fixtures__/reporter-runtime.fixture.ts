import { beforeAll, describe, expect, test } from 'vitest';

// Protocol-free fixture for the real ConformanceReporter. The shape is chosen
// by ITWCT_REPORTER_FIXTURE_MODE:
// - mixed (default): bracketed + unbracketed duplicate requirement IDs, a
//   deliberate failure, and a generic check without a requirement ID
// - hook-error: a scenario group whose beforeAll throws
// - empty: no tests at all
const mode = process.env.ITWCT_REPORTER_FIXTURE_MODE ?? 'mixed';

if (mode === 'mixed') {
  describe('Fixture presentation phase', () => {
    describe('Scenario group', { meta: { itwctScenarioId: 'WP_RP_HAPPY' } }, () => {
      test('[WP_082]: bracketed requirement passes', () => {
        expect(1 + 1).toBe(2);
      });

      test('WP_082: unbracketed duplicate requirement fails deliberately', () => {
        expect('actual', 'deliberate fixture failure').toBe('expected');
      });
    });

    test('generic cleanup check passes', () => {
      expect(true).toBe(true);
    });
  });
}

if (mode === 'hook-error') {
  describe('Scenario group with failing hook', { meta: { itwctScenarioId: 'WP_RP_HAPPY' } }, () => {
    beforeAll(() => {
      throw new Error('deliberate beforeAll failure');
    });

    test('[WP_091]: never reached because the hook failed', () => {
      expect(true).toBe(true);
    });
  });
}
