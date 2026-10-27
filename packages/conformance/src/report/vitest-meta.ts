/**
 * Metadata the presentation matrix attaches to each selected scenario group
 * (`describe(title, { meta: { itwctScenarioId } }, body)`), so the reporter can
 * associate every assertion occurrence with the protocol-observed scenario it
 * belongs to. Generic checks outside a scenario group carry no association.
 */
declare module 'vitest' {
  interface TaskMeta {
    itwctScenarioId?: string;
  }
}

export const SCENARIO_META_KEY = 'itwctScenarioId';
