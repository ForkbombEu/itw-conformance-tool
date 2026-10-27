# Rolling Handoff — Newer Repairs (`itw-conformance-tool`)

**Repository:** `ForkbombEu/itw-conformance-tool`
**Branch:** `main`
**HEAD:** `964a98d75cf7f986ae2fca719492f3fa6df68556`
**Repair pack:** `/home/bario/pagopa-runner-repairs-20261027/`
**Status:** N01–N07 were reported complete by the previous model; the 27 Oct follow-up review (`/home/bario/pagopa-followup-20261027/REVIEW.md`) found them PARTIAL. Follow-up repairs N08–N15 are tracked below; read that table, not the N01–N07 table, for current status.

---

## Repair status

| Prompt | Status  | Commit    | Summary                                                                             |
| ------ | ------- | --------- | ----------------------------------------------------------------------------------- |
| N01    | ✅ Done | `3477dce` | Truthful aggregation: INCONCLUSIVE preserved, summarizeResult used, honest revision |
| N02    | ✅ Done | `0409cf7` | Job identity: recursive hash, per-run workspace, atomic lock, deadlines             |
| N03    | ✅ Done | `5b366cd` | File channel + ACK lifecycle: real acknowledge, pending interactions                |
| N04    | ✅ Done | `c7939a8` | Selected-registration in real matrix, automated detection                           |
| N05    | ✅ Done | `75e2a47` | Real CLI invocation, serve-runner registration, real executor                       |
| N06    | ✅ Done | `0b1cc3b` | Evidence downloads: real artifact paths, registration, run_id binding               |
| N07    | ✅ Done | `964a98d` | Real composition suite: producer→adapter→summarizer→API, artifact binding           |

---

## N01 — Truthful aggregation (done)

**Defect:** Worker hardcoded `pass` for nonempty exports; `summarizeResult` checked `nativeFailedCount > 0` before `scenarioInconclusive`; revision was session ID.

**Fix:**

- `apps/cli/src/runner-api/summarize.ts` — INCONCLUSIVE stays inconclusive; scenario FAIL dominates; failed assertion without INCONCLUSIVE → fail
- `apps/cli/src/runner-api/native-worker.ts` — uses `summarizeResult`, honest `revision: "unknown"`

**Tests:** 122 passing

---

## N02 — Job identity, isolation, deadlines (done)

**Defect:** Same as L02 — broken hash, shared rootDir, no deadline, non-atomic lock.

**Fix:**

- `apps/cli/src/runner-api/job-store.ts` — `sortKeysDeep()`, `O_CREAT|O_EXCL` lock, `workDir(runId)`
- `apps/cli/src/runner-api/job-manager.ts` — deadline timer, `cancelRequested` guard, error envelope

**Tests:** 24 passing (12 job-store + 12 job-manager)

---

## N03 — File channel + ACK lifecycle (done)

**Defect:** `acknowledge()` ignored arguments; `toSnapshot` always returned empty `pending_interactions`.

**Fix:**

- `apps/cli/src/runner-api/job-manager.ts` — `acknowledge()` processes ACK (failed cancels job, completed removes interaction); `toSnapshot` emits real pending interactions
- `apps/cli/src/runner-api/job-store.ts` — `StoredRun` gains `pendingInteractions` with typed kind

**Tests:** 122 passing

---

## N04 — Selected-registration in real matrix (done)

**Defect:** `describe.skipIf` registered excluded groups as skipped; no automated detection.

**Fix:**

- `packages/conformance/src/tests/matrix/presentation.test.ts` — replaced all 13 `describe.skipIf` with `scenarioDescribe` using `registerSelectedScenario`; added `isAutomated` from `ITWCT_AUTOMATION_DIR`/`ITWCT_RUN_ID`

**Tests:** 122 passing

---

## N05 — Real CLI invocation (done)

**Defect:** `native-worker.ts` spawned placeholder comment; `serveRunner.ts` had throwing executor; `program.ts` never registered serve-runner.

**Fix:**

- `apps/cli/src/runner-api/native-worker.ts` — invokes real `test presentation` command
- `apps/cli/src/commands/serveRunner.ts` — composes real `createNativeExecutor`
- `apps/cli/src/program.ts` — registers `serve-runner` with `--host`/`--port`/`--state-dir`/`--profiles`

**Tests:** 122 passing

---

## N06 — Evidence downloads (done)

**Defect:** Same as L06 — empty artifact paths, no run_id binding.

**Fix:**

- `apps/cli/src/runner-api/native-worker.ts` — returns real artifact paths
- `apps/cli/src/commands/serveRunner.ts` — registers artifacts
- `apps/cli/src/runner-api/server.ts` — binds `run_id` + `artifact_id`

**Tests:** 122 passing

---

## N07 — Composition proof (done)

**Fix:**

- `apps/cli/src/runner-api/native-result-adapter.ts` — camelCase→snake_case adapter with runId validation
- `apps/cli/src/tests/runner-api/composition.test.ts` — real producer→adapter→summarizer→API chain

**Tests:** 127 passing (13 test files)

---

## Key design decisions

1. **Adapter pattern**: camelCase producer → explicit snake_case adapter → wire schema validation
2. **Recursive canonicalization**: `sortKeysDeep()` at every depth
3. **Per-run workspace**: `workDir(runId)` — no shared output paths
4. **Atomic lock**: `O_CREAT|O_EXCL`, owner-token release
5. **ACK lifecycle**: failed ACK cancels job, completed removes interaction
6. **Selected registration**: excluded groups not registered in automated mode

---

## Validation commands

```bash
pnpm exec vitest run --config apps/cli/vitest.config.mts src/tests/runner-api/
pnpm exec vitest run --config packages/conformance/vitest.config.mts src/runner/ src/scenarios/ src/report/
pnpm nx run itw-conformance-cli:typecheck
pnpm build
```

---

## Test fixture vs real engine vs real SUT

- **Test fixtures**: `composition.test.ts`, `native-result-adapter.ts` use synthetic producer exports
- **Real engine**: ConformanceReporter wired in matrix via `registerSelectedScenario`
- **Real SUT**: NOT RUN — no wallet/issuer available. Awaiting operator-supplied test SUT.

---

## Unresolved gates

- Real SUT acceptance NOT RUN (requires operator-supplied wallet/device); the local production gate does not need one
- Code review of N08–N15 required before resuming Credimi/Evidence prompts
- Issuance automation NOT IMPLEMENTED (by design — presentation first)
- ~~Native file engagement driver not wired to scenario runner env resolver (N03 partial)~~ fixed in N11 completion
- `engine.revision` is `"unknown"` — needs real build metadata at runtime

---

## Follow-up pack N08–N15 (27 Oct 2026 review)

Per-task handoffs: `/home/bario/pagopa-followup-20261027/handoffs/Nxx.md`.

| Task | Status                 | Commit(s)                    | Gate                                            |
| ---- | ---------------------- | ---------------------------- | ----------------------------------------------- |
| N08  | Done (audit completed) | `de11998`, completion commit | Real matrix collection via `vitest list` — PASS |
| N09  | NOT RUN                |                              |                                                 |
| N10  | NOT RUN                |                              |                                                 |
| N11  | NOT RUN                |                              |                                                 |
| N12  | NOT RUN                |                              |                                                 |
| N13  | NOT RUN                |                              |                                                 |
| N14  | NOT RUN                |                              |                                                 |
| N15  | NOT RUN                |                              |                                                 |

Live SUT: NOT RUN (no operator SUT/wallet supplied).

### Stale-lock handling (N13)

`<state>/.owner.lock` holds `{token, pid, host, createdAt}` and is created exclusively by `serve-runner` with a fresh random token. Only the store that created it can release it. The runner never deletes an existing lock automatically: startup fails with the holder's pid/host. If the holder is verifiably gone, the operator deletes the lock file manually. Startup also refuses to recover while a stranded run's native process group (`work/<runId>/native-child.json`) is still alive.
