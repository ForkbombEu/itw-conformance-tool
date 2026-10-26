import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildNativeExport, writeNativeExport, type NativeAssertion } from './native-export.js';

function makeAssertion(overrides: Partial<NativeAssertion> = {}): NativeAssertion {
  return {
    ancestor_titles: ['Suite'],
    file: 'test.ts',
    full_title: 'WP_082: test',
    native_status: 'PASS',
    phase: 'presentation',
    requirement_id: 'WP_082',
    ...overrides
  };
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'wct-native-export-'));
});

afterEach(() => {
  rmSync(tempDir, { force: true, recursive: true });
});

describe('buildNativeExport', () => {
  it('builds export with all fields', () => {
    const result = buildNativeExport({
      assertions: [makeAssertion()],
      closedAt: '2026-01-01T00:01:00Z',
      phase: 'presentation',
      runId: 'run-1',
      sessionId: 'session-1',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'PASSED'
    });
    expect(result.run_id).toBe('run-1');
    expect(result.session_id).toBe('session-1');
    expect(result.assertions).toHaveLength(1);
  });

  it('preserves duplicate requirement IDs as separate assertions', () => {
    const result = buildNativeExport({
      assertions: [makeAssertion(), makeAssertion({ full_title: 'WP_082: other' })],
      closedAt: null,
      phase: 'presentation',
      runId: 'run-1',
      sessionId: 'session-1',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'PASSED'
    });
    expect(result.assertions).toHaveLength(2);
    expect(result.assertions[0]?.requirement_id).toBe('WP_082');
    expect(result.assertions[1]?.requirement_id).toBe('WP_082');
  });

  it('preserves null requirement_id for generic assertions', () => {
    const result = buildNativeExport({
      assertions: [makeAssertion({ requirement_id: undefined, full_title: 'generic test' })],
      closedAt: null,
      phase: 'presentation',
      runId: 'run-1',
      sessionId: 'session-1',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'PASSED'
    });
    expect(result.assertions[0]?.requirement_id).toBeUndefined();
  });

  it('handles zero assertions', () => {
    const result = buildNativeExport({
      assertions: [],
      closedAt: null,
      phase: 'presentation',
      runId: 'run-1',
      sessionId: 'session-1',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'PASSED'
    });
    expect(result.assertions).toHaveLength(0);
    expect(result.status).toBe('PASSED');
  });
});

describe('writeNativeExport', () => {
  it('writes native-results.json atomically', () => {
    const data = buildNativeExport({
      assertions: [makeAssertion()],
      closedAt: null,
      phase: 'presentation',
      runId: 'run-1',
      sessionId: 'session-1',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'PASSED'
    });
    writeNativeExport(tempDir, data);
    const parsed = JSON.parse(readFileSync(join(tempDir, 'native-results.json'), 'utf-8'));
    expect(parsed.run_id).toBe('run-1');
    expect(parsed.session_id).toBe('session-1');
    expect(parsed.assertions).toHaveLength(1);
  });

  it('round-trips all fields', () => {
    const assertion = makeAssertion({
      ancestor_titles: ['A', 'B'],
      error_message: 'fail',
      file: '/path/test.ts',
      native_status: 'FAIL',
      requirement_id: 'RPR-010',
      full_title: 'RPR-010: deep',
      vitest_status: 'failed'
    });
    const data = buildNativeExport({
      assertions: [assertion],
      closedAt: null,
      phase: 'presentation',
      runId: 'run-2',
      sessionId: 'session-2',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'FAILED'
    });
    writeNativeExport(tempDir, data);
    const parsed = JSON.parse(readFileSync(join(tempDir, 'native-results.json'), 'utf-8'));
    const a = parsed.assertions[0];
    expect(a.requirement_id).toBe('RPR-010');
    expect(a.ancestor_titles).toEqual(['A', 'B']);
    expect(a.file).toBe('/path/test.ts');
    expect(a.native_status).toBe('FAIL');
    expect(a.error_message).toBe('fail');
    expect(parsed.session_id).toBe('session-2');
  });
});
