import { wpRpHappyScenario } from '../../scenarios/factories/wp-rp-happy.js';
import { createScenarioRegistry } from '../../scenarios/registry.js';

import type { ProtocolObservedScenarioDefinition } from '../../scenarios/definitions.js';

/**
 * WP_RP_HAPPY with its network boundary controlled: no local service is
 * needed (manual-instruction stimulus) and the protocol evidence is the entry
 * event alone, which the test feeds into the session's event store. Short
 * timeouts let a missing wallet conclude INCONCLUSIVE quickly.
 */
export function controlledHappyScenario(testerActionMs = 1_500): ProtocolObservedScenarioDefinition {
  return {
    ...wpRpHappyScenario,
    forbiddenEvents: [],
    requiredEvents: [],
    services: [],
    stimulus: {
      type: 'manual-instruction',
      text: 'openid4vp://authorize?client_id=x509_hash%3Afixture&request_uri=https%3A%2F%2Frp.fixture%2Frequest'
    },
    timeouts: { forbiddenObservationMs: 100, protocolStepMs: 500, testerActionMs, vitestTestMs: 30_000 },
    verdictRules: [{ type: 'entry-event-required' }]
  };
}

export function controlledRegistry(testerActionMs?: number) {
  return createScenarioRegistry([controlledHappyScenario(testerActionMs)]);
}
