export { readPackageVersion, resolveRootPackageJsonPath } from './package-json.js';
export { isUriUnderAttestedPrefix, normalizeUrl, trimTrailingSlashes } from './url.js';
export { sha256HashArtifact } from './artifact-hash.js';
export {
  isTestCategory,
  testCategories,
  testCategoryByFileName,
  testCategoryNames,
  type TestCategory
} from './test-categories.js';
export { escapeHtml, toInlineScriptStringLiteral } from './html.js';
export { INTERNAL_SERVICE_REQUEST_HEADER, isInternalServiceRequest } from './internal-request.js';
export * from './json-schema.js';
export * from './result.js';
export * from './matchers.js';
export {
  acknowledgeInteraction,
  AutomationChannelError,
  closeInteraction,
  listPendingInteractions,
  MAX_PENDING_INTERACTIONS,
  publishInteraction,
  readAck,
  readScenarioOutcomes,
  recordScenarioOutcome,
  type AckOutcome,
  type ChannelAck,
  type ChannelErrorCode,
  type ChannelInteraction,
  type ChannelOutcome,
  type PendingInteractionsView,
  type ScenarioOutcomesView
} from './automation-channel.js';
