import type { ScenarioOutcome } from '../verdict/outcome.js';

export interface EngagementInteraction {
  correlationId: string;
  expiresAt: string;
  interactionId: string;
  kind: 'browser_authorization' | 'wallet_deeplink' | 'wallet_qr';
  scenarioId: string;
  uri: string;
}

export interface EngagementDriver {
  close(interactionId: string): Promise<void>;
  publish(interaction: EngagementInteraction): Promise<void>;
  recordOutcome?(outcome: ScenarioOutcome): Promise<void>;
}
