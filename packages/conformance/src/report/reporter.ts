import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

import { loadConfig, type ConfigSchemaType } from '@itw-conformance-tool/config';
import { DatabaseClient } from '@itw-conformance-tool/database';
import { logger } from '@itw-conformance-tool/logger';

import {
  buildNativeExport,
  writeNativeExport,
  type NativeAssertion,
  type NativeExportStatus
} from './native-export.js';
import { extractDescription, extractRequirementId } from './requirement-id.js';
import { appendCheck, closeSession, createSession } from './session-store.js';
import { SCENARIO_META_KEY } from './vitest-meta.js';

import type { ConformanceCheck, Phase } from './types.js';
import type { SerializedError } from 'vitest';
import type { TestModule, TestResult } from 'vitest/node';
import type { Reporter } from 'vitest/reporters';

type CheckResult = ConformanceCheck['result'];

type ReporterTestCase = Parameters<NonNullable<Reporter['onTestCaseResult']>>[0];

type SessionStatus = NativeExportStatus;
type TestType = Phase;

/** Upper bound on collected out-of-test error messages kept in the native export. */
const MAX_EXPORTED_ERRORS = 20;
const MAX_ERROR_LENGTH = 2_000;

function describeError(error: unknown): string {
  if (typeof error === 'string') return error.slice(0, MAX_ERROR_LENGTH);
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message.slice(0, MAX_ERROR_LENGTH);
  }
  return String(error).slice(0, MAX_ERROR_LENGTH);
}

/** Walks the parent chain of a test case: suite titles (outermost first) and the nearest scenario association. */
function describeAncestry(testCase: ReporterTestCase): { ancestorTitles: string[]; scenarioId?: string } {
  const ancestorTitles: string[] = [];
  let scenarioId: string | undefined;
  let parent = testCase.parent;
  while (parent.type === 'suite') {
    ancestorTitles.unshift(parent.name);
    const candidate = parent.meta()[SCENARIO_META_KEY];
    if (!scenarioId && typeof candidate === 'string' && candidate.length > 0) scenarioId = candidate;
    parent = parent.parent;
  }
  return { ancestorTitles, scenarioId };
}

/** Errors that happened outside test bodies: collection/import failures and suite-level hook errors. */
function collectModuleErrors(testModules: ReadonlyArray<TestModule>): string[] {
  const errors: string[] = [];
  for (const testModule of testModules) {
    for (const error of testModule.errors()) errors.push(`${testModule.relativeModuleId}: ${describeError(error)}`);
    for (const suite of testModule.children.allSuites()) {
      for (const error of suite.errors()) errors.push(`${suite.fullName}: ${describeError(error)}`);
    }
  }
  return errors;
}

export class ConformanceReporter implements Reporter {
  private checkResults: CheckResult[] = [];
  private collectedAssertions: NativeAssertion[] = [];
  private db: DatabaseClient;
  private sessionId: string | undefined;
  private readonly testType: TestType;
  private config: ConfigSchemaType;
  private resultsDir: string | undefined;
  private runId: string | undefined;
  private startedAt: string;

  constructor(testType: TestType) {
    this.config = loadConfig();
    this.db = new DatabaseClient(this.config.global.data_dir);
    this.testType = testType;
    this.startedAt = new Date().toISOString();
  }

  onTestCaseResult(testCase: ReporterTestCase): void {
    if (!this.sessionId) {
      return;
    }

    const title = testCase.name;
    const result = this.mapResult(testCase.result().state);
    const requirementId = extractRequirementId(title);
    const description = extractDescription(title);
    const check: ConformanceCheck = {
      description,
      phase: this.testType,
      requirementId: requirementId ?? title,
      result,
      timestamp: new Date().toISOString()
    };

    if (result === 'FAIL') {
      check.errorMessage = this.extractFailureMessage(testCase);
    }

    appendCheck(this.db, this.sessionId, check);
    this.checkResults.push(result);

    // Collect every occurrence for the native export when an automated run
    // configured one. Duplicate requirement IDs stay separate occurrences.
    if (this.resultsDir) {
      const { ancestorTitles, scenarioId } = describeAncestry(testCase);
      this.collectedAssertions.push({
        ancestor_titles: ancestorTitles,
        ...(check.errorMessage ? { error_message: check.errorMessage } : {}),
        file: testCase.module.relativeModuleId,
        full_title: testCase.fullName,
        native_status: result,
        phase: this.testType,
        ...(requirementId ? { requirement_id: requirementId } : {}),
        ...(scenarioId ? { scenario_id: scenarioId } : {}),
        test_id: testCase.id,
        vitest_status: testCase.result().state
      });
    }
  }

  onTestRunEnd(
    testModules: ReadonlyArray<TestModule> = [],
    unhandledErrors: ReadonlyArray<SerializedError> = []
  ): void {
    if (!this.sessionId) {
      return;
    }

    const outOfTestErrors = [
      ...collectModuleErrors(testModules),
      ...unhandledErrors.map((error) => `unhandled: ${describeError(error)}`)
    ];
    const status = this.resolveFinalStatus(this.checkResults, outOfTestErrors.length > 0);
    const closedAt = new Date().toISOString();
    closeSession(this.db, this.sessionId, status, closedAt);
    this.db.close();

    logger.info(`Conformance session ID: ${this.sessionId}`);

    if (this.resultsDir && this.runId) {
      try {
        const exportData = buildNativeExport({
          assertions: this.collectedAssertions,
          closedAt,
          errors: outOfTestErrors.slice(0, MAX_EXPORTED_ERRORS),
          phase: this.testType,
          runId: this.runId,
          sessionId: this.sessionId,
          startedAt: this.startedAt,
          status
        });
        writeNativeExport(this.resultsDir, exportData);
        logger.info(`Native export written to ${this.resultsDir}`);
      } catch (error) {
        logger.error(`Failed to write native export: ${describeError(error)}`);
      }
    }
  }

  onTestRunStart(): void {
    this.sessionId = randomUUID();
    this.checkResults = [];
    this.collectedAssertions = [];
    this.runId = process.env.ITWCT_RUN_ID?.trim() || undefined;
    const resultsDir = process.env.ITWCT_RESULTS_DIR?.trim() || undefined;
    // The export context is all-or-nothing: a run ID without a results
    // directory (or vice versa) would silently produce no evidence.
    if (Boolean(this.runId) !== Boolean(resultsDir)) {
      throw new Error('ITWCT_RUN_ID and ITWCT_RESULTS_DIR must be set together for a native export');
    }
    this.resultsDir = resultsDir;
    if (this.resultsDir) mkdirSync(this.resultsDir, { recursive: true });
    this.startedAt = new Date().toISOString();

    createSession(this.db, {
      entityName: this.config.global.organization_name,
      id: this.sessionId,
      phase: this.testType,
      startedAt: this.startedAt,
      status: 'OPEN'
    });
  }

  private extractFailureMessage(testCase: ReporterTestCase): string {
    const firstError = testCase.result().errors?.[0];

    if (!firstError) {
      return 'Test failed without error details';
    }

    if (typeof firstError === 'string') {
      return firstError;
    }

    if (typeof firstError === 'object' && 'message' in firstError) {
      const message = (firstError as { message?: unknown }).message;
      if (typeof message === 'string' && message.length > 0) {
        return message;
      }
    }

    return String(firstError);
  }

  private mapResult(state: TestResult['state']): CheckResult {
    if (state === 'passed') {
      return 'PASS';
    }

    if (state === 'failed') {
      return 'FAIL';
    }

    return 'NOT_REACHED';
  }

  private resolveFinalStatus(results: readonly CheckResult[], hasOutOfTestErrors = false): SessionStatus {
    if (results.includes('FAIL')) {
      return 'FAILED';
    }

    // Zero assertions, hook/collection errors or unreached tests never pass.
    if (results.length === 0 || hasOutOfTestErrors || results.includes('NOT_REACHED')) {
      return 'INCOMPLETE';
    }

    return 'PASSED';
  }
}
