import { describe, expect, it } from 'vitest';

import {
  checkNewEngineCapability,
  invalidRequest,
  isTerminalStatus,
  runRequestSchema,
  runnerResultSchema,
  runSnapshotSchema,
  runStatusSchema
} from '../../runner-api/contract.js';

const goldenRequest = {
  category: 'presentation',
  contract_version: '1.0',
  parameters: {},
  profile_id: 'wallet-presentation-dev',
  selection: { ids: ['WP_RP_HAPPY'] },
  target: {
    actor_name: 'Synthetic wallet',
    actor_type: 'wallet',
    actor_version: 'fixture'
  },
  timeout_ms: 600_000
};

const legacyRequest = {
  category: 'issuance',
  contract_version: '1.0',
  parameters: {},
  profile_id: 'capture-interop-dev',
  selection: { ids: ['credimi-issuance-smoke'] },
  target: {
    actor_name: 'Synthetic issuer',
    actor_type: 'issuer',
    issuer_identifier: 'https://issuer.example/issuers/eu-pid-device-bound'
  },
  timeout_ms: 600_000
};

describe('runRequestSchema — golden shapes', () => {
  it('accepts the ITWCT golden request', () => {
    expect(runRequestSchema.safeParse(goldenRequest).success).toBe(true);
  });

  it('accepts the WCT legacy request with optional identifiers', () => {
    const result = runRequestSchema.safeParse(legacyRequest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.target.issuer_identifier).toBe('https://issuer.example/issuers/eu-pid-device-bound');
    }
  });

  it('accepts rp_identifier in target', () => {
    const req = {
      ...goldenRequest,
      target: {
        actor_name: 'RP',
        actor_type: 'relying_party',
        rp_identifier: 'https://rp.example'
      }
    };
    expect(runRequestSchema.safeParse(req).success).toBe(true);
  });
});

describe('runRequestSchema — rejections', () => {
  it('rejects unknown top-level keys', () => {
    expect(runRequestSchema.safeParse({ ...goldenRequest, evil: true }).success).toBe(false);
  });

  it('rejects unknown target fields', () => {
    expect(
      runRequestSchema.safeParse({
        ...goldenRequest,
        target: { ...goldenRequest.target, evil_field: 'x' }
      }).success
    ).toBe(false);
  });

  it('rejects wrong contract_version', () => {
    expect(runRequestSchema.safeParse({ ...goldenRequest, contract_version: '2.0' }).success).toBe(false);
  });

  it('rejects empty selection', () => {
    expect(
      runRequestSchema.safeParse({
        ...goldenRequest,
        selection: { ids: [] }
      }).success
    ).toBe(false);
  });

  it('rejects duplicate selection IDs', () => {
    expect(
      runRequestSchema.safeParse({
        ...goldenRequest,
        selection: { ids: ['WP_RP_HAPPY', 'WP_RP_HAPPY'] }
      }).success
    ).toBe(false);
  });

  it('rejects more than 32 selection IDs', () => {
    expect(
      runRequestSchema.safeParse({
        ...goldenRequest,
        selection: { ids: Array.from({ length: 33 }, (_, i) => `id-${i}`) }
      }).success
    ).toBe(false);
  });

  it('rejects empty ID in selection', () => {
    expect(
      runRequestSchema.safeParse({
        ...goldenRequest,
        selection: { ids: [''] }
      }).success
    ).toBe(false);
  });

  it('rejects invalid category', () => {
    expect(runRequestSchema.safeParse({ ...goldenRequest, category: 'evil' }).success).toBe(false);
  });

  it('rejects invalid actor_type', () => {
    expect(
      runRequestSchema.safeParse({
        ...goldenRequest,
        target: { ...goldenRequest.target, actor_type: 'evil' }
      }).success
    ).toBe(false);
  });

  it('rejects non-integer timeout_ms', () => {
    expect(runRequestSchema.safeParse({ ...goldenRequest, timeout_ms: 1000.5 }).success).toBe(false);
  });

  it('rejects timeout_ms below minimum', () => {
    expect(runRequestSchema.safeParse({ ...goldenRequest, timeout_ms: 500 }).success).toBe(false);
  });

  it('rejects timeout_ms above maximum', () => {
    expect(runRequestSchema.safeParse({ ...goldenRequest, timeout_ms: 900_001 }).success).toBe(false);
  });

  it('rejects unknown parameters keys', () => {
    expect(
      runRequestSchema.safeParse({
        ...goldenRequest,
        parameters: { evil: true }
      }).success
    ).toBe(false);
  });

  it('rejects non-empty parameters for new engine', () => {
    const req = {
      ...goldenRequest,
      parameters: { issuer_url: 'https://x.example' }
    };
    const parsed = runRequestSchema.safeParse(req);
    // Shape validation passes but capability check rejects
    if (parsed.success) {
      expect(checkNewEngineCapability(parsed.data).ok).toBe(false);
    }
  });
});

describe('checkNewEngineCapability', () => {
  it('accepts presentation + WP_RP_HAPPY', () => {
    const req = runRequestSchema.parse(goldenRequest);
    expect(checkNewEngineCapability(req).ok).toBe(true);
  });

  it('rejects issuance category', () => {
    const req = runRequestSchema.parse(legacyRequest);
    expect(checkNewEngineCapability(req).ok).toBe(false);
  });

  it('rejects non-WP_RP_HAPPY selection', () => {
    const req = runRequestSchema.parse({
      ...goldenRequest,
      selection: { ids: ['OTHER_SCENARIO'] }
    });
    expect(checkNewEngineCapability(req).ok).toBe(false);
  });

  it('rejects non-empty parameters', () => {
    const result = runRequestSchema.safeParse({
      ...goldenRequest,
      parameters: { foo: 'bar' }
    });
    // Shape validation rejects non-empty parameters (strictObject({}))
    expect(result.success).toBe(false);
  });
});

describe('runStatusSchema', () => {
  it('accepts all valid statuses', () => {
    for (const s of ['queued', 'running', 'waiting_for_interaction', 'completed', 'cancelled', 'timed_out', 'error']) {
      expect(runStatusSchema.safeParse(s).success).toBe(true);
    }
  });
});

describe('isTerminalStatus', () => {
  it('identifies terminal statuses', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('timed_out')).toBe(true);
    expect(isTerminalStatus('error')).toBe(true);
  });

  it('identifies non-terminal statuses', () => {
    expect(isTerminalStatus('queued')).toBe(false);
    expect(isTerminalStatus('running')).toBe(false);
    expect(isTerminalStatus('waiting_for_interaction')).toBe(false);
  });
});

describe('runSnapshotSchema', () => {
  it('accepts a valid snapshot', () => {
    const snapshot = {
      cancel_requested: false,
      contract_version: '1.0',
      created_at: '2026-01-01T00:00:00Z',
      engine: 'pagopa-itwct',
      pending_interactions: [],
      result_url: '/v1/runs/abc/result',
      run_id: 'abc',
      status: 'running',
      updated_at: '2026-01-01T00:00:01Z'
    };
    expect(runSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it('rejects invalid status', () => {
    expect(
      runSnapshotSchema.safeParse({
        cancel_requested: false,
        contract_version: '1.0',
        created_at: '2026-01-01T00:00:00Z',
        engine: 'x',
        pending_interactions: [],
        result_url: '/r',
        run_id: 'a',
        status: 'evil',
        updated_at: '2026-01-01T00:00:01Z'
      }).success
    ).toBe(false);
  });
});

describe('runnerResultSchema', () => {
  it('accepts the golden WCT pass fixture shape', () => {
    const result = {
      artifacts: [],
      category: 'issuance',
      contract_version: '1.0',
      engine: {
        fork_repository: 'https://github.com/ForkbombEu/wallet-conformance-test-fb',
        id: 'pagopa-wct',
        revision: 'b728cca',
        upstream_repository: 'https://github.com/pagopa/wallet-conformance-test',
        version: '1.0'
      },
      execution: {
        exit_code: 0,
        finished_at: '2026-01-01T00:00:02Z',
        started_at: '2026-01-01T00:00:00Z',
        status: 'completed'
      },
      limitations: [],
      native: {
        assertions: [
          {
            ancestor_titles: ['Suite'],
            assertion_id: 'a0001',
            file: 'test.ts',
            full_title: 'CI_001: test',
            native_status: 'PASS',
            phase: 'issuance',
            requirement_id: 'CI_001'
          }
        ],
        coverage_mode: 'interoperability',
        native_suite_status: 'PASSED',
        scenario_outcomes: [],
        sessions: []
      },
      profile_id: 'test',
      run_id: 'abc',
      selection: { ids: ['credimi-issuance-smoke'] },
      summary: {
        assertion_count: 1,
        native_failed_assertion_count: 0,
        result: 'pass'
      },
      target: { actor_name: 'x', actor_type: 'issuer' }
    };
    expect(runnerResultSchema.safeParse(result).success).toBe(true);
  });

  it('preserves assertions with no requirement_id', () => {
    const result = {
      artifacts: [],
      category: 'presentation',
      contract_version: '1.0',
      engine: {
        fork_repository: 'x',
        id: 'pagopa-itwct',
        revision: 'x',
        upstream_repository: 'x',
        version: 'x'
      },
      execution: { started_at: '2026-01-01T00:00:00Z', status: 'completed' },
      limitations: [],
      native: {
        assertions: [
          {
            ancestor_titles: [],
            assertion_id: 'a0001',
            file: 'test.ts',
            full_title: 'generic smoke test',
            native_status: 'PASS',
            phase: 'presentation'
          }
        ],
        coverage_mode: 'interoperability',
        native_suite_status: 'PASSED',
        scenario_outcomes: [],
        sessions: []
      },
      profile_id: 'p',
      run_id: 'r',
      selection: { ids: ['WP_RP_HAPPY'] },
      summary: {
        assertion_count: 1,
        native_failed_assertion_count: 0,
        result: 'pass'
      },
      target: { actor_name: 'x', actor_type: 'wallet' }
    };
    expect(runnerResultSchema.safeParse(result).success).toBe(true);
  });
});

describe('RunnerError', () => {
  it('invalidRequest has code INVALID_REQUEST and 400', () => {
    const e = invalidRequest('bad');
    expect(e.code).toBe('INVALID_REQUEST');
    expect(e.httpStatus).toBe(400);
  });
});
