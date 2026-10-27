import { listPendingInteractions } from '@itw-conformance-tool/utils';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createObservedEvent } from '../../events/event-bus.js';
import { assertConformanceOutcome } from '../../vitest/matchers.js';
import { resolveAutomationEngagementDriver } from '../file-engagement-driver.js';
import { createProtocolObservedScenarioRunner } from '../scenario-runner.js';
import { controlledRegistry } from './automation-scenario.js';

import type { ScenarioOutcome } from '../../verdict/outcome.js';
import type { InteractiveScenarioSession, ScenarioRunner } from '../scenario-runner.js';

// A REAL protocol-observed session in a native Vitest child: the runner
// auto-installs the file driver from ITWCT_AUTOMATION_DIR/ITWCT_RUN_ID and
// publishes a genuine interaction. The network boundary is controlled: the
// fixture feeds the protocol event itself once the runner API's ACK arrives.
// ITWCT_CHANNEL_FIXTURE_MODE:
// - pass: after a completed ACK, the wallet's entry event is observed → PASS
// - inconclusive: after a completed ACK, no wallet evidence → INCONCLUSIVE
// - wait: never concludes on its own (for cancellation/deadline tests)
const mode = process.env.ITWCT_CHANNEL_FIXTURE_MODE ?? 'pass';
const testerActionMs = mode === 'wait' ? 120_000 : mode === 'inconclusive' ? 500 : 20_000;

async function waitForAck(session: InteractiveScenarioSession, interactionId: string): Promise<void> {
  const driver = resolveAutomationEngagementDriver();
  for (let i = 0; i < 400; i++) {
    if (await driver?.readAck?.(interactionId)) return;
    if (session.abortSignal.aborted) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('No driver ACK observed through the native channel');
}

describe('Controlled presentation fixture', () => {
  describe('Happy path (controlled boundary)', { meta: { itwctScenarioId: 'WP_RP_HAPPY' } }, () => {
    let runner: ScenarioRunner;
    let outcome: ScenarioOutcome;

    beforeAll(async () => {
      runner = createProtocolObservedScenarioRunner({
        browserOpener: async () => {
          throw new Error('no system browser in automation mode');
        },
        endpoints: {},
        registry: controlledRegistry(testerActionMs),
        write: () => undefined
      });
      const session = await runner.start('WP_RP_HAPPY');
      try {
        await session.showInstructions();
        const pending = listPendingInteractions(process.env.ITWCT_AUTOMATION_DIR ?? '', process.env.ITWCT_RUN_ID ?? '')
          .pending[0];
        if (!pending) throw new Error('interaction was not published');
        if (mode !== 'wait') await waitForAck(session, pending.interactionId);
        if (mode === 'pass') {
          await session.events.emit(
            createObservedEvent({ correlationId: null, name: 'rp.request_object.requested', service: 'relying-party' })
          );
        }
        outcome = await session.awaitVerdict();
      } finally {
        await session.stop();
      }
    }, 150_000);

    afterAll(async () => {
      await runner?.close();
    });

    test('[WP_076]: Wallet Instance obtains the Remote Presentation URL from a deep link', () => {
      assertConformanceOutcome(outcome, { expected: 'PASS' });
    });
  });

  test('generic fixture check outside any scenario', () => {
    expect(mode).toMatch(/^(pass|inconclusive|wait)$/);
  });
});
