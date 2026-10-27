import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acknowledgeInteraction, listPendingInteractions, readScenarioOutcomes } from '@itw-conformance-tool/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createObservedEvent } from '../events/event-bus.js';
import { controlledRegistry } from './__fixtures__/automation-scenario.js';
import { createFileEngagementDriver, resolveAutomationEngagementDriver } from './file-engagement-driver.js';
import { createProtocolObservedScenarioRunner } from './scenario-runner.js';

import type { EngagementDriver } from './engagement-driver.js';

let root: string;
const saved = { dir: process.env.ITWCT_AUTOMATION_DIR, run: process.env.ITWCT_RUN_ID };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wct-file-drv-'));
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
  for (const [key, value] of [
    ['ITWCT_AUTOMATION_DIR', saved.dir],
    ['ITWCT_RUN_ID', saved.run]
  ] as const) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

const silent = (): void => undefined;

describe('resolveAutomationEngagementDriver', () => {
  it('neither env var keeps human mode', () => {
    expect(resolveAutomationEngagementDriver({})).toBeUndefined();
  });

  it('incomplete automation env is rejected', () => {
    expect(() => resolveAutomationEngagementDriver({ ITWCT_AUTOMATION_DIR: root })).toThrow(/Both/);
    expect(() => resolveAutomationEngagementDriver({ ITWCT_RUN_ID: 'r' })).toThrow(/Both/);
  });

  it('the scenario runner rejects incomplete automation env at construction', () => {
    process.env.ITWCT_RUN_ID = 'run-x';
    Reflect.deleteProperty(process.env, 'ITWCT_AUTOMATION_DIR');
    expect(() =>
      createProtocolObservedScenarioRunner({ endpoints: {}, registry: controlledRegistry(), write: silent })
    ).toThrow(/Both ITWCT_AUTOMATION_DIR and ITWCT_RUN_ID/);
  });
});

describe('protocol-observed runner with the auto-installed file driver', () => {
  async function startAutomated(testerActionMs?: number) {
    process.env.ITWCT_AUTOMATION_DIR = root;
    process.env.ITWCT_RUN_ID = 'run-native-1';
    const runner = createProtocolObservedScenarioRunner({
      browserOpener: async () => {
        throw new Error('the system browser must not be opened in automation mode');
      },
      endpoints: {},
      registry: controlledRegistry(testerActionMs),
      write: silent
    });
    const session = await runner.start('WP_RP_HAPPY');
    return { runner, session };
  }

  it('publishes a real interaction file, observes the ACK, records the PASS verdict and closes', async () => {
    const { runner, session } = await startAutomated();
    await session.showInstructions();

    const [pending] = listPendingInteractions(root, 'run-native-1').pending;
    expect(pending?.scenarioId).toBe('WP_RP_HAPPY');
    expect(pending?.uri).toContain('openid4vp://authorize');
    expect(pending?.correlationId).toBe(session.correlationId);

    expect(
      acknowledgeInteraction(root, 'run-native-1', pending?.interactionId ?? '', { driverStatus: 'completed' })
    ).toBe('accepted');
    const driver = createFileEngagementDriver({ automationDir: root, runId: 'run-native-1' });
    expect(await driver.readAck?.(pending?.interactionId ?? '')).toEqual({ driverStatus: 'completed' });

    // The ACK alone does not produce a verdict: the protocol event does.
    await session.events.emit(
      createObservedEvent({ correlationId: null, name: 'rp.request_object.requested', service: 'relying-party' })
    );
    const outcome = await session.awaitVerdict();
    await session.stop();
    await runner.close();

    expect(outcome.verdict).toBe('PASS');
    expect(readScenarioOutcomes(root, 'run-native-1').outcomes.map((o) => [o.scenarioId, o.verdict])).toEqual([
      ['WP_RP_HAPPY', 'PASS']
    ]);
    expect(listPendingInteractions(root, 'run-native-1').pending).toEqual([]);
    expect(readdirSync(join(root, 'closed'))).toHaveLength(1);
  });

  it('an ACK without protocol evidence never becomes PASS (INCONCLUSIVE is recorded)', async () => {
    const { runner, session } = await startAutomated(300);
    await session.showInstructions();
    const [pending] = listPendingInteractions(root, 'run-native-1').pending;
    acknowledgeInteraction(root, 'run-native-1', pending?.interactionId ?? '', { driverStatus: 'completed' });
    const outcome = await session.awaitVerdict();
    await session.stop();
    await runner.close();
    expect(outcome.verdict).toBe('INCONCLUSIVE');
    expect(readScenarioOutcomes(root, 'run-native-1').outcomes[0]?.verdict).toBe('INCONCLUSIVE');
  });

  it('an explicit driver option takes precedence over the automation env', async () => {
    process.env.ITWCT_AUTOMATION_DIR = root;
    process.env.ITWCT_RUN_ID = 'run-native-1';
    const published: string[] = [];
    const explicit: EngagementDriver = {
      async close() {
        // Nothing to close for this recording driver.
      },
      async publish(interaction) {
        published.push(interaction.interactionId);
      }
    };
    const runner = createProtocolObservedScenarioRunner({
      endpoints: {},
      engagementDriver: explicit,
      registry: controlledRegistry(),
      write: silent
    });
    const session = await runner.start('WP_RP_HAPPY');
    await session.showInstructions();
    await session.stop();
    expect(published).toHaveLength(1);
    expect(existsSync(join(root, 'interactions'))).toBe(false);
  });
});
