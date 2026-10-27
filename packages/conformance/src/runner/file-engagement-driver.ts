import { closeInteraction, publishInteraction, readAck, recordScenarioOutcome } from '@itw-conformance-tool/utils';

import type { ScenarioOutcome } from '../verdict/outcome.js';
import type { EngagementDriver, EngagementInteraction } from './engagement-driver.js';

export interface FileEngagementDriverOptions {
  automationDir: string;
  runId: string;
}

/**
 * Native side of the canonical automation channel
 * (`@itw-conformance-tool/utils` automation-channel): publishes one immutable
 * interaction per engagement, closes it with a separate marker, persists the
 * scenario verdict, and observes the runner API's driver ACK.
 */
export function createFileEngagementDriver(options: FileEngagementDriverOptions): EngagementDriver {
  const { automationDir, runId } = options;

  return {
    async publish(interaction: EngagementInteraction): Promise<void> {
      publishInteraction(automationDir, { ...interaction, createdAt: new Date().toISOString(), runId });
    },

    async close(interactionId: string): Promise<void> {
      closeInteraction(automationDir, runId, interactionId, 'session stopped');
    },

    async readAck(interactionId: string) {
      const ack = readAck(automationDir, interactionId);
      return ack && ack.runId === runId ? { driverStatus: ack.driverStatus, message: ack.message } : undefined;
    },

    async recordOutcome(outcome: ScenarioOutcome): Promise<void> {
      recordScenarioOutcome(automationDir, {
        completedAt: outcome.timings.completedAt ?? new Date().toISOString(),
        reason: outcome.reason.slice(0, 4_096),
        runId,
        scenarioId: outcome.testCaseId,
        verdict: outcome.verdict
      });
    }
  };
}

/**
 * Resolves the driver an automated run must use from ITWCT_AUTOMATION_DIR and
 * ITWCT_RUN_ID. Neither set: human mode (undefined). Only one set: invalid.
 */
export function resolveAutomationEngagementDriver(env: NodeJS.ProcessEnv = process.env): EngagementDriver | undefined {
  const automationDir = env.ITWCT_AUTOMATION_DIR?.trim();
  const runId = env.ITWCT_RUN_ID?.trim();
  if (!automationDir && !runId) return undefined;
  if (!automationDir || !runId) {
    throw new Error('Both ITWCT_AUTOMATION_DIR and ITWCT_RUN_ID must be set for automation mode');
  }
  return createFileEngagementDriver({ automationDir, runId });
}
