import type { ScenarioOutcome } from '../verdict/outcome.js';

export interface EngagementInteraction {
  correlationId: string;
  expiresAt: string;
  interactionId: string;
  kind: 'browser_authorization' | 'wallet_deeplink' | 'wallet_qr';
  scenarioId: string;
  uri: string;
}

export interface EngagementAck {
  driverStatus: 'completed' | 'failed';
  message?: string;
}

export interface EngagementDriver {
  close(interactionId: string): Promise<void>;
  publish(interaction: EngagementInteraction): Promise<void>;
  /** The external driver's ACK for a published interaction, if one arrived. Never a verdict. */
  readAck?(interactionId: string): Promise<EngagementAck | undefined>;
  recordOutcome?(outcome: ScenarioOutcome): Promise<void>;
}
