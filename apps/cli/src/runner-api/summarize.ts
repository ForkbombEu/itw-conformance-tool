import type { PublicationFailure } from './artifacts.js';
import type { RunnerResult } from './contract.js';

type Native = RunnerResult['native'];
type Execution = RunnerResult['execution'];
type Summary = RunnerResult['summary'];

export interface SummaryContext {
  /**
   * assertion_id → protocol-observed scenario ID, or null for a generic check
   * outside any scenario group. A missing map or entry means the association
   * is unknown, which is handled conservatively.
   */
  assertionScenarios?: ReadonlyMap<string, null | string>;
}

/**
 * Recovers the assertion → scenario association from each adapted
 * assertion's `raw` producer JSON (`scenario_id`, absent for generic checks),
 * so summaries recomputed after cancellation, deadline or restart keep it.
 * Assertions without readable raw JSON stay unknown.
 */
export function assertionScenariosFromRaw(native: Native): Map<string, null | string> {
  const associations = new Map<string, null | string>();
  for (const assertion of native.assertions) {
    if (!assertion.raw) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(assertion.raw);
    } catch {
      continue;
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const scenarioId = (raw as { scenario_id?: unknown }).scenario_id;
    associations.set(
      assertion.assertion_id,
      typeof scenarioId === 'string' && scenarioId.length > 0 ? scenarioId : null
    );
  }
  return associations;
}

export interface SummaryWithLimitations {
  limitations: string[];
  summary: Summary;
}

/**
 * Aggregates native data into the conservative v1.0 summary:
 * - zero assertions never pass (not_tested);
 * - an explicit scenario FAIL, or a FAIL assertion known to be independent of
 *   every INCONCLUSIVE scenario, establishes fail;
 * - INCONCLUSIVE plus the strict-PASS matcher failures of that same scenario
 *   stays inconclusive (raw failed counts preserved);
 * - with unknown association, INCONCLUSIVE stays inconclusive with a limitation;
 * - any non-completed or unknown execution status cannot pass (partial);
 * - a native suite that is not PASSED (e.g. INCOMPLETE after hook or
 *   unhandled errors) cannot pass (partial), even with all tests PASS.
 */
export function summarizeWithLimitations(
  execution: Execution,
  native: Native,
  context: SummaryContext = {}
): SummaryWithLimitations {
  const assertionCount = native.assertions.length;
  const failed = native.assertions.filter((a) => a.native_status === 'FAIL');
  const nativeFailedCount = failed.length;
  const hasNotReached = native.assertions.some((a) => a.native_status === 'NOT_REACHED');
  const scenarioFail = native.scenario_outcomes.some((s) => s.verdict === 'FAIL');
  const inconclusiveScenarios = new Set(
    native.scenario_outcomes.filter((s) => s.verdict === 'INCONCLUSIVE').map((s) => s.scenario_id)
  );
  const assertionScenarios = context.assertionScenarios ?? assertionScenariosFromRaw(native);
  const limitations: string[] = [];
  const summary = (result: Summary['result']): SummaryWithLimitations => ({
    limitations,
    summary: { assertion_count: assertionCount, native_failed_assertion_count: nativeFailedCount, result }
  });

  if (assertionCount === 0) {
    limitations.push('No native assertions were collected; the run cannot be reported as tested.');
    return summary('not_tested');
  }

  if (scenarioFail) return summary('fail');

  if (inconclusiveScenarios.size > 0) {
    let unknownAssociation = 0;
    let independentFailures = 0;
    for (const assertion of failed) {
      const scenarioId = assertionScenarios.get(assertion.assertion_id);
      if (scenarioId === undefined) unknownAssociation++;
      else if (scenarioId === null || !inconclusiveScenarios.has(scenarioId)) independentFailures++;
    }

    if (independentFailures > 0) return summary('fail');

    if (unknownAssociation > 0) {
      limitations.push(
        `${unknownAssociation} failed native assertion(s) could not be associated with a scenario; INCONCLUSIVE is kept and the raw failed count is preserved.`
      );
    } else if (nativeFailedCount > 0) {
      limitations.push(
        `${nativeFailedCount} failed native assertion(s) are strict-PASS matchers of INCONCLUSIVE scenario(s): ${[...inconclusiveScenarios].join(', ')}.`
      );
    }
    return summary('inconclusive');
  }

  if (nativeFailedCount > 0) return summary('fail');

  if (execution.status !== 'completed') {
    limitations.push(`Execution ended with status '${execution.status}'; only partial evidence is available.`);
    return summary('partial');
  }

  if (hasNotReached) return summary('partial');

  // Hook/collection/unhandled errors make the native suite INCOMPLETE even
  // when every executed test passed: that is never a pass.
  if (native.native_suite_status !== 'PASSED') {
    limitations.push(
      `Native suite status is '${native.native_suite_status}' (errors outside test bodies or incomplete execution); the run cannot pass.`
    );
    return summary('partial');
  }

  return summary('pass');
}

export function summarizeResult(execution: Execution, native: Native, context: SummaryContext = {}): Summary {
  return summarizeWithLimitations(execution, native, context).summary;
}

/**
 * Evidence completeness as a separate aggregation input, applied after the
 * native/lifecycle summary: a declared raw evidence artifact that failed its
 * initial publication cannot back a pass, so pass becomes inconclusive. Every
 * other result (fail, partial, not_tested, inconclusive) and every native
 * verdict is kept; informational limitations never reach this function.
 */
export function applyEvidenceCompleteness(
  summary: Summary,
  publicationFailures: readonly PublicationFailure[]
): SummaryWithLimitations {
  if (publicationFailures.length === 0) return { limitations: [], summary };
  const names = [...new Set(publicationFailures.map((failure) => failure.filename))].join(', ');
  const limitation = `Declared evidence artifact(s) could not be published (${names}); the aggregate result cannot be pass and native verdicts are unchanged.`;
  return {
    limitations: [limitation],
    summary: summary.result === 'pass' ? { ...summary, result: 'inconclusive' } : summary
  };
}
