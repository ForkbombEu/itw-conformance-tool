import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

import { loadConfig, type ConfigSchemaType } from '@itw-conformance-tool/config';
import { DatabaseClient } from '@itw-conformance-tool/database';
import { logger } from '@itw-conformance-tool/logger';

import { buildNativeExport, writeNativeExport, type NativeAssertion } from './native-export.js';
import { extractDescription, extractRequirementId } from './requirement-id.js';
import { appendCheck, closeSession, createSession } from './session-store.js';

import type { ConformanceCheck, Phase } from './types.js';
import type { TestResult } from 'vitest/node';
import type { Reporter } from 'vitest/reporters';

type CheckResult = ConformanceCheck['result'];

type ReporterTestCase = Parameters<NonNullable<Reporter['onTestCaseResult']>>[0];

type SessionStatus = 'FAILED' | 'INCOMPLETE' | 'PASSED';
type TestType = Phase;

export class ConformanceReporter implements Reporter {
  private checkResults: CheckResult[] = [];
  private collectedAssertions: NativeAssertion[] = [];
  private db: DatabaseClient;
  private sessionId: string | undefined;
  private readonly testType: TestType;
  private config: ConfigSchemaType;
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

    // Collect for native export (snake_case to match native-export.ts)
    if (this.runId) {
      this.collectedAssertions.push({
        ancestor_titles: [],
        file: (testCase as { file?: { name?: string } }).file?.name ?? 'unknown',
        full_title: title,
        native_status: result,
        phase: this.testType,
        requirement_id: requirementId ?? undefined,
        vitest_status: testCase.result().state as NativeAssertion['vitest_status']
      });
    }
  }

  onTestRunEnd(): void {
    if (!this.sessionId) {
      return;
    }

    const status = this.resolveFinalStatus(this.checkResults);
    closeSession(this.db, this.sessionId, status, new Date().toISOString());
    this.db.close();

    logger.info(`Conformance session ID: ${this.sessionId}`);

    // Write native export if configured
    if (this.runId && process.env.ITWCT_RESULTS_DIR) {
      try {
        const exportData = buildNativeExport({
          assertions: this.collectedAssertions,
          closedAt: new Date().toISOString(),
          phase: this.testType,
          runId: this.runId,
          sessionId: this.sessionId,
          startedAt: this.startedAt,
          status
        });
        mkdirSync(process.env.ITWCT_RESULTS_DIR, { recursive: true });
        writeNativeExport(process.env.ITWCT_RESULTS_DIR, exportData);
        logger.info(`Native export written to ${process.env.ITWCT_RESULTS_DIR}`);
      } catch (error) {
        logger.error(`Failed to write native export: ${error}`);
      }
    }
  }

  onTestRunStart(): void {
    this.sessionId = randomUUID();
    this.checkResults = [];
    this.collectedAssertions = [];
    this.runId = process.env.ITWCT_RUN_ID;
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

  private resolveFinalStatus(results: readonly CheckResult[]): SessionStatus {
    if (results.includes('FAIL')) {
      return 'FAILED';
    }

    if (results.includes('NOT_REACHED')) {
      return 'INCOMPLETE';
    }

    return 'PASSED';
  }
}
