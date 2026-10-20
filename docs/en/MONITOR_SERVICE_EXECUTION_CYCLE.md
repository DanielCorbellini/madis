# `monitor-service` — Execution Cycle

`monitor-service` ([`apps/monitor-service`](../../apps/monitor-service)) is the long-lived daemon responsible for Flow 2 of the architecture (see [`ARCHITECTURE.md`](ARCHITECTURE.md) §3): it periodically re-derives every already-anchored batch's state directly from the raw `records`/`anchor_records` tables and the blockchain itself, and raises an alert the moment either one disagrees with what was actually anchored. It never signs or sends a blockchain transaction, and it never writes to Postgres beyond the alerts it emits — every other action this daemon takes is a read. `anchor-service` is the only component that holds a funded wallet and writes to the chain; `monitor-service` exists specifically so that guarantee doesn't have to be trusted blindly.

This document is more granular than `ARCHITECTURE.md`'s §6.2 summary and reflects the daemon's current implementation precisely — read this one when the question is specifically about how `monitor-service` behaves, phase by phase.

---

## 1. Daemon Lifecycle

`monitor-service` is not a script that runs once — it is a long-running Node.js process (`apps/monitor-service/src/index.ts`) with the same three lifecycle stages `anchor-service` has: startup self-checks, a scheduled loop of execution cycles, and graceful shutdown.

### 1.1. Startup Self-Checks (Fail-Fast)

Before scheduling anything, the process validates its own environment and its ability to talk to both Postgres and the blockchain. Every check is fail-fast: if any of them fails, the process logs the error and exits immediately.

1. **Configuration parsing** (`src/config.ts`) — every required environment variable (`DATABASE_URL`, `RPC_URL`, `ANCHOR_CHAIN_ID`) must be present and well-formed. `CONTRACT_ADDRESS` is optional and resolved the same way `anchor-service` resolves it, from `packages/contracts-shared`'s committed per-chain deployment registry. Every optional setting (including `ANCHOR_MAX_BATCH_SIZE`, which this daemon also reads — see Phase 3, and the sampling-mode settings of Phase 2) is listed in §5. Right after parsing, `logSamplingWarnings` (`src/index.ts`) logs a warning if `MONITOR_SAMPLE_SEED` is set (the sampling order becomes predictable) or if sampling mode runs with `MONITOR_ESCALATE_ON_ANOMALY=false`; both are meant for experiments only.
2. **Private-key rejection.** If `ANCHOR_PRIVATE_KEY` is present in the environment at all, `loadConfig` throws immediately — the exact opposite of `anchor-service`'s own startup check. A signing key on a read-only auditor would be a real safety defect, not a harmless unused variable, so this is caught loudly before anything else runs.
3. **Database connectivity** — a `SELECT 1` against the configured Postgres pool.
4. **Network identity** — the connected RPC endpoint's `chainId` must match the configured `ANCHOR_CHAIN_ID`.
5. **Contract deployment** — the resolved contract address must actually have bytecode on that network.

There is no wallet-ownership check, because there is no wallet at all: `createReadOnlyChainClient` (`src/chain.ts`) never constructs an ethers `Wallet` — the `JsonRpcProvider` itself is the contract's `ContractRunner`, so every call this daemon ever makes is a `view` function.

If any of steps 3-5 throws, the database pool and the chain provider are both closed before the process exits. If they all succeed, the pool and provider stay open for the scheduler's entire lifetime.

### 1.2. Chain Client and Retry Policy

Every on-chain read this daemon makes — `getBatchInfo` (Phases 3 and 5) and `getRootCount` (Phase 1) — goes through the same retry wrapper, `createRetryingContract` (`src/chain.ts`), built once at startup around the read-only contract instance and reused for the process's entire lifetime. `listAnchoredBatches` (Phase 1: the contract's paged `getBatchIdsPaged` / `getMerkleRootsPaged` views) applies the same retry policy to each page it reads.

A genuine contract revert is deterministic: retrying `RootDoesNotExist` a second time would fail identically, so any error `decodeRevertName` (`packages/contracts-shared`) can decode into a named revert aborts immediately, without retrying. Everything else — timeouts, connection resets, rate limiting — is a transient network condition and is retried via [`p-retry`](https://github.com/sindresorhus/p-retry), up to `MONITOR_RPC_RETRIES` attempts (default: 4). Unlike `anchor-service`'s equivalent retry policy, there is no fee-bumping schedule here at all — these are free reads, not paid transactions, so there is nothing to bump. A read that still fails after its retries is handled by its caller: inside Phase 1's batch listing it degrades the cycle (see Phase 1); inside the per-batch loops of Phases 3 and 5 it is logged and that batch is skipped (no alert — an unreachable RPC is not evidence of tampering); a failure of the mandatory `getRootCount` read aborts the cycle, which is logged as `cycle failed unexpectedly` and retried by the next scheduled tick.

### 1.3. Scheduling

Once startup succeeds, `createCycleScheduler` (`src/index.ts`) wraps the whole execution cycle (§2 below) in a [`croner`](https://github.com/Hexagon/croner) job, configured with the cron expression in `MONITOR_CRON_SCHEDULE` (default: `*/5 * * * *`, every 5 minutes — deliberately much tighter than `anchor-service`'s 3-hour default, since every cycle here is cheap reads plus, usually, zero writes, and running often directly shrinks how long a genuine divergence can go unnoticed).

Overlap protection uses croner's `protect` option, but not as a bare `protect: true`: it's given `logSkippedOverlap(logger)` (`src/index.ts`), so a skipped tick is explicitly logged as a warning naming the still-running cycle's start time (`job.currentRun()`), rather than silently dropped. This callback can only be exercised by a genuinely overlapping *scheduled* tick — a manually triggered cycle (`.cron.trigger()`, what every other test in this codebase uses to drive a cycle without waiting on a real cron pattern) never goes through `protect` at all, verified directly against croner's own behavior. At most one cycle ever runs at a time, in a single process.

### 1.4. Graceful Shutdown

On `SIGTERM` or `SIGINT`, `shutdownGracefully` (`packages/service-runtime` — the exact same function `anchor-service` uses) runs:

1. The croner job is stopped — no new cycle will ever start after this point.
2. A cooperative abort flag is flipped.
3. If a cycle is in flight, the shutdown sequence waits for it to finish — but only up to `SHUTDOWN_GRACE_MS` (default: 30,000 ms / 30 seconds). This is deliberately much shorter than `anchor-service`'s 10-minute default: there is no pending blockchain transaction to protect here, only a handful of reads in flight at any one moment.
4. If the in-flight cycle finishes within the grace period, the database pool is closed and the chain provider is destroyed, and the process exits cleanly.
5. If the grace period elapses first, the process hard-exits with a non-zero code.

Unlike `anchor-service`'s single fixed abort checkpoint (between persisting a batch and submitting it), `runMonitorCycle` checks the abort flag *before every batch iteration*, in each of its three per-batch loops (sampling mode's suspect check, Phase 3's audit loop and Phase 5's stale-submitted-batch loop) — see §2. An in-flight check for the current batch always finishes; only the *next* batch in that loop is skipped. This is safe everywhere in this daemon, because every unit of work it performs is a read plus at most one alert insert — nothing is ever left half-sent the way an in-flight blockchain transaction would be.

**SIGTERM during a CPU-bound audit.** The image starts the service with `node --import tsx src/index.ts` rather than the `tsx` CLI: the CLI's supervising parent `SIGKILL`s a child whose event loop is blocked for more than ~60 ms (exit 143, no graceful sequence — E2E plan §8). With a plain `node` process the signal is handled as soon as the loop is free, so a SIGTERM during the per-leaf hashing of a large batch just waits for the audit to finish (verified: 10,002 records, ~5 s) and then exits 0. The dev override still runs `tsx watch`, which caps every shutdown at 5 s.

---

## 2. The Execution Cycle

Each scheduled tick runs exactly one execution cycle, implemented by `runMonitorCycle` (`src/cycle.ts`). Unlike `anchor-service`'s single linear sequence of phases, this cycle runs several largely independent checks back to back — the chain's own batch list together with a whole-system count check, an audit of the chain's batches (in full mode every batch the chain accepted plus every row Postgres calls confirmed; in sampling mode a slice of them, see Phase 2), and a per-batch staleness check — aggregating all of them into one structured summary at the end.

```mermaid
flowchart TD
    Start(["Scheduled tick (croner)"]) --> P1["Phase 1 — Chain batch list + root count check<br/>(missing / inconsistent batches, whole-system count)"]
    P1 --> P2["Phase 2 — Select the batches to audit<br/>(full: confirmed rows ∪ on-chain batches with a row;<br/>sampling: a shuffled-pass slice + new batches + spot checks)"]
    P2 --> D1{"Batches left to audit,<br/>and no shutdown requested?"}
    D1 -- Yes --> P3["Phase 3 — Audit one batch<br/>(anchor count + root rebuild / per-record proofs)"]
    P3 --> D1
    D1 -- No --> P4["Phase 4 — Fetch submitted batch ids<br/>+ prune stale-submitted tracker"]
    P4 --> D2{"Submitted batches left,<br/>and no shutdown requested?"}
    D2 -- Yes --> P5["Phase 5 — Check one batch's staleness<br/>(in-memory clock; chain re-check if stale)"]
    P5 --> D2
    D2 -- No --> P6["Phase 6 — Assemble + log cycle summary"]
    P6 --> End(["Cycle ends"])
```

The same six phases, as a plain-text list:

```text
Phase 1  Chain batch list (missing / inconsistent batches) + root count check
Phase 2  Select the batches to audit (full mode: confirmed rows plus every on-chain batch that has a row; sampling mode: a slice of a shuffled pass)
Phase 3  Audit one batch (loops over Phase 2's ids)
Phase 4  Fetch every submitted batch id + prune the stale-submitted tracker
Phase 5  Check one submitted batch's staleness (loops over Phase 4's ids)
Phase 6  Assemble and log the cycle summary
```

Phases 1-2 and 4-5 never depend on each other's outcome, and none of the checks (Phase 1's batch list and count check, Phase 3's checks, Phase 5's staleness check) ever stops the cycle from running the rest — a single batch's failure, or a count mismatch, only ever fires an alert and continues. The one exception is an unreadable chain: if a mandatory read (such as `getRootCount`) still fails after its retries, the cycle aborts, is logged as `cycle failed unexpectedly`, and the next scheduled tick tries again.

### Phase 1 — Root Count Check and Chain Batch List

**Responsibility:** detect whether an entire batch has been hidden from Phase 2's rescan, and name it — a gap a rescan of `'confirmed'` rows alone can never see.

Implemented inline in `runMonitorCycle`, via `checkRootCount` and `classifyOnChainBatches` (`src/root-count-check.ts`):

1. **The chain's own list, every cycle.** `listAnchoredBatches` (`src/chain.ts`) pages through the contract's stored state (`getBatchIdsPaged` + `getMerkleRootsPaged`) and returns every `(batchId, root)` the contract has ever accepted — no event logs, so no provider `getLogs` range limits. `findBatchStatuses` then asks Postgres what `status` it currently reports for exactly those ids. Which batches matter is decided by the chain; Postgres only says how it labels them.
2. **Classification** (`classifyOnChainBatches`). An on-chain batch whose row is `'confirmed'` or `'submitted'` is expected. A batch with **no `batches` row** is *missing*; one whose row is `'pending'` or `'failed'` is *inconsistent* (the chain accepted it, so those statuses cannot be true). Each fires a `root_divergence` alert with a `null` `batch_id` and `expected_root` set to the batch's on-chain root (`recordMissingBatch`, deduplicated by that root). This runs whether or not the counts agree, so a forged `'submitted'` padding row can no longer hide a deleted batch.
3. **The count check.** The contract's `getRootCount()` against `countTrackedBatches` (a `COUNT(*)` of rows `'confirmed'` or `'submitted'`). A mismatch is logged; only if no missing/inconsistent batch explains it (the opposite anomaly — Postgres tracks more than the chain — or the chain listing failed) does it write the generic whole-system `root_divergence` alert (`batch_id` `null`, `expected_root` `null`).
4. A failure listing the chain's batches never breaks the cycle: it degrades to the confirmed-only rescan and the generic count alert.

`'submitted'` rows are still counted as tracked: a real batch can legitimately sit there until the anchor-service reconciles it. Phase 5 closes the remaining padding gap (a fake `'submitted'` row with no on-chain batch).

### Phase 2 — Select the Batches to Audit

**Responsibility:** decide which batches Phase 3 audits, without letting anything stored in Postgres gate that decision.

`MONITOR_AUDIT_MODE` (§5) picks one of two modes. `full` is the default and audits everything each cycle; `sampling` audits a rotating slice of the chain's batches each cycle and falls back to a full rescan whenever something looks wrong. Everything outside this phase behaves identically in both modes: Phase 1's chain list and count check, Phase 3's audit of whichever batches were selected, and Phase 5 all run in full every cycle, so batch-level tampering (a deleted or re-labelled `batches` row, padding rows) is caught within one cycle either way. Only the record-level audit of Phase 3 is spread across cycles in sampling mode.

#### Full mode (default): full rescan

The audit set is the union of two lists: every `'confirmed'` row (`findConfirmedBatchIds`, `src/batch-selection-repository.ts`: `SELECT id FROM batches WHERE status = 'confirmed' ORDER BY created_at ASC`) and every batch the chain accepted that Postgres still has a row for, **whatever status that row claims** (Phase 1's `auditable` list). The second half exists because `status` is an ordinary writable column: an attacker who flips a real batch to `'submitted'` and deletes one of its records would otherwise take it out of the audit entirely (E2E scenario 13). Each batch is audited once even if it appears in both lists. Confirmed rows the chain does not know are still audited — `getBatchInfo` reverts for them, which is itself an alert.

In full mode the set is deliberately unfiltered and unlimited — no `LIMIT`, no cursor, no "last verified at" column, no stored progress of any kind. Every batch in the set is audited every single cycle.

This is a considered choice, not the obvious default. An earlier version of this policy considered a per-batch `last_verified_at` timestamp, auditing the least-recently-checked batches first — rejected because that timestamp would live in the exact database this whole system assumes a privileged attacker can freely write to. An attacker who tampers with a batch could simply also bump its own `last_verified_at` to "now," pushing it to the back of the queue indefinitely. Full rescan has no such state to attack. See `docs/overview/monitor-service/new_specs/2026-09-24-batch-selection-strategies.md` for the full comparison against that rejected alternative, and for how the sampling mode below came to be built as a refined variant of the random-sampling alternative.

#### Sampling mode: shuffled passes, spot checks, escalation

Implemented by `createAuditSelector` (`src/audit-selection.ts`), whose only inputs are the chain's own batch list (Phase 1's `auditable` ids) and the ids Postgres calls `'confirmed'`. Randomness comes from `createRandomInt` (`src/random-source.ts`): the OS CSPRNG, or — only if `MONITOR_SAMPLE_SEED` is set — a deterministic HMAC-SHA256 stream, so an experiment can be replayed exactly. Each cycle selects up to `MONITOR_SAMPLE_SIZE` (k) batches from the pass, plus any new batch, plus up to `MONITOR_SPOT_CHECKS` (j) spot checks; Phase 3 then audits them exactly as in full mode.

1. **The shuffled pass.** On the first cycle the chain's batch ids are put in a uniformly random order (Fisher-Yates) and a cursor starts at the front; each cycle takes the next k ids and advances the cursor, so every batch is audited exactly once per pass. When the cursor reaches the end, the whole list is reshuffled and a new pass begins. The order and cursor live only in this process's memory — never in Postgres — so there is nothing an attacker can write to postpone a batch's turn, which is the same reason full mode rejected a `last_verified_at` column.
2. **New batches.** An id on the chain's list that the selector has not seen before (anchored since the last cycle) is audited that same cycle, so a fresh batch never waits for its turn. It is then inserted at a uniformly random position in the *unvisited* part of the pass, taken *after* this cycle's slice, so it does not displace the ids already chosen. Ids that disappear from the chain list are dropped from the pass.
3. **Spot checks.** j more batches are drawn uniformly, without replacement, from the whole chain list excluding this cycle's slice and new batches. They may already have been visited in the current pass, so every batch has at least a j / M chance of being audited in every cycle, wherever it sits in the pass (M = the number of batches on the chain's list). This counters an attacker who watches the monitor's queries to learn which batches were just visited.
4. **Suspect check.** A `'confirmed'` id that is not on the chain's list (or, if the listing failed, not already known to the selector) is a suspect. Each suspect gets one `getBatchInfo`, and a `RootDoesNotExist` revert fires the same `root_divergence` alert the batch audit would. Suspects are checked every cycle, not on a batch's turn, so a forged `'confirmed'` row is still caught within one cycle.
5. **Requeue.** If a slice batch's audit ends without a verdict (any error other than the `RootDoesNotExist` alert path, such as a dropped RPC connection), it is put back at a random position in the unvisited part of the pass instead of being counted as visited. Without this, a transient failure would silently exempt that batch for a whole pass. The same applies to slice batches a cycle never reached because it threw partway (an alert insert or a Postgres read failing), though not to batches skipped on shutdown. A batch is requeued at most once per pass: if it fails again in the same pass its slot is consumed and an `error` log names it as not audited this pass, so one persistently failing batch cannot keep the pass from ending. That is an operational failure, not an anomaly, so it does not escalate.
6. **Escalation.** At the end of each cycle, if it detected any anomaly (a missing or inconsistent batch, a count mismatch, a failed anchor count, a tampered record, or a decoded `RootDoesNotExist` on an audited batch (slice, new or spot), a suspect or a stale-submitted batch), the *next* cycle is an escalated full rescan: it audits the same set as full mode, skips sampling and the suspect check, and only syncs the selector's pass with the chain list. This keys off detected anomalies, not `alertsFired`, because alert inserts are deduplicated and a persisting tamper would otherwise stop escalating after its first alert. `MONITOR_ESCALATE_ON_ANOMALY=false` disables escalation, for experiments that need to measure the pass alone.
7. **Chain listing failure.** The chain defines the batch set, so no new batch can be recognised while its list is unreadable. Before the first successful listing there is no pass yet: no batch is sampled and every `'confirmed'` id is a suspect (one `getBatchInfo` each). Afterwards the selector keeps its existing pass, keeps taking slices and spot checks from it, and treats the `'confirmed'` ids it does not already know as suspects.

**What sampling costs and guarantees.** The record-level work per cycle is bounded by `k + j` plus the batches newly anchored since the last cycle, rather than by the whole history. A persistent record-level tamper is caught within at most 2L − 1 cycles (L = ⌈M_p / k⌉, where M_p is the length of the pass including batches inserted mid-pass, and M the number of batches on the chain's list when the pass began) and in about 7L/12 on average (both bounds, like "every batch is audited once per pass", hold for batches whose audits reach a verdict: a batch whose audit fails twice in one pass is only logged); the full derivation, and the limitations (transient tamper-and-revert, restarts, whole-batch granularity), are in [`docs/superpowers/specs/2026-10-18-monitor-probabilistic-audit-design.md`](../superpowers/specs/2026-10-18-monitor-probabilistic-audit-design.md) §6-7. A restart discards the pass and reshuffles; the bound restarts with it.

### Phase 3 — Audit One Batch

**Responsibility:** for one batch from Phase 2's audit set, verify both that every one of its records is still present, and that none of their content has been edited since anchoring.

Implemented by `auditBatch` (`src/audit.ts`), called once per batch id from Phase 2 (whatever status Postgres claims for it — the audit never trusts that column to decide *whether* a batch is checked):

1. **Ground truth from the chain.** `getBatchInfo(batchId)` — never Postgres's own `batches.size`/`merkle_root` — is the only source this phase trusts for what this batch actually anchored. If this reverts `RootDoesNotExist` (a `'confirmed'` Postgres row with no matching on-chain `BatchInfo` at all), the revert propagates out of `auditBatch` uncaught; `runMonitorCycle` catches it at the loop level, fires a `root_divergence` alert (`expected_root: null`, since there is no root to report) naming that batch id, and moves on. Any other exception (a genuinely unexpected shape, a dropped connection mid-stream) is logged and the batch is skipped without an alert — it's an anomaly, not evidence of tampering. In full mode the rescan picks this same batch up again next cycle regardless. In sampling mode a failed slice batch is requeued into the unvisited part of the pass (see Phase 2, item 5), while a failed new or spot batch is not retried until its own turn in the pass or a later spot check.
2. **Anchor count check.** `countAnchoredRecords` (`src/audit-repository.ts`) — a plain `COUNT(*)` of this batch's current `anchor_records` rows — is compared against the on-chain `size` via `checkAnchorCount` (`src/anchor-count.ts`). Any mismatch, not only "fewer than," fires a `root_divergence` alert. This is the one gap a per-record proof loop can never notice on its own, since it only ever visits rows that are still there — a deleted `anchor_records` row is invisible to it.
3. **Root rebuild, with a per-record fallback.** When the anchor count check passes, `auditBatch` first tries a cheap fast path: every currently-pinned record's leaf is recomputed from its *current* raw `records` columns (`computeRecordLeaf`, `src/record-verification.ts`), and `computeMerkleRoot` (`packages/crypto-utils`) rebuilds the batch's root from that leaf set in one shot — no stored proof is read at all for this. If the rebuilt root matches the on-chain root, the batch is clean and the audit is done; no per-record proof check runs. If it doesn't match, or the rebuild itself fails (a malformed record's leaf computation throwing, the same shape `verifyAnchoredRecord` already guards against), `auditBatch` falls back to a per-record check: `streamAnchoredRecords` (`src/audit-repository.ts`) streams every `anchor_records` row still pinned to this batch, joined against that record's current columns, and `verifyAnchoredRecord` (`src/record-verification.ts`) recomputes each leaf — via the same `computeRecordLeaf` the fast path uses — and checks it against the proof captured at anchor time plus the on-chain root. This fallback is the only place a stored `merkle_proof` is ever read, and the only step that can name a specific tampered `record_id`; a `record_tampered` alert fires for each one that fails. `verifyAnchoredRecord` never throws, even on a malformed `client_address`/`signature` that would otherwise make `computeRecordLeaf` itself throw — a row a privileged actor edited directly is reported as a normal tamper finding, not a crash that would abort the whole batch's audit.

When the anchor count check doesn't pass (step 2 already found a deleted row), the fast path isn't attempted at all — a rebuild would mismatch for a reason already explained, buying no new information — and `auditBatch` goes straight to the fallback. That's also the step's only way to find a *second*, independent tampered record among whatever is still there: a deleted row and an edited row can coexist in the same batch, and the fallback is never skipped because the count check already fired its own alert.

**Size limit on the rebuild.** The rebuild holds the whole batch's tree in memory (about 1.3 KB per leaf with the OpenZeppelin implementation: ~134 MB at 100,000 records, ~450 MB at 500,000), whereas the per-record path streams in roughly constant memory. So the fast path only runs for batches whose on-chain `size` is at most `rootRebuildMaxSize` (`src/config.ts`): the value of `ANCHOR_MAX_BATCH_SIZE` when it is set — `anchor-service` never builds a batch larger than its cap, and needs at least as much memory to build one — or 100,000 when it is not. Larger batches (for example ones created before a cap was configured) skip the rebuild and are verified record by record exactly as before, which also means a damaged *stored proof* is still reported for them (see E2E scenario 7 in the test plan: below the limit a damaged proof is invisible until some record's data changes, above it the per-record path flags it). Measured on 10,000 records: the per-record path costs about 4.0 s of CPU (leaf hashing 2.3 s + proof verification 1.7 s), the rebuild about 2.95 s (2.3 s + 0.65 s); on the live 10,002-record batch the monitor's audit stage went from 4.95 s to 3.5 s. A tampered batch pays for both paths every cycle (rebuild, then fallback).

### Phase 4 — Fetch Submitted Batch IDs, Prune the Stale-Submitted Tracker

**Responsibility:** decide which `'submitted'` batches Phase 5 individually re-checks this cycle, and stop tracking any batch that's no longer in that state.

Implemented by `findSubmittedBatchIds` (`src/batch-selection-repository.ts`) — the same unfiltered, full-rescan shape as Phase 2, against `status = 'submitted'` instead — followed immediately by `pruneSubmittedTracking` (backed by `createStaleSubmittedTracker`'s `pruneExcept`, `src/stale-submitted-tracker.ts`), which drops tracking for any batch id this process previously watched that isn't in this cycle's submitted list anymore.

### Phase 5 — Check One Submitted Batch's Staleness

**Responsibility:** eventually catch a fake `'submitted'` row — the one padding vector Phase 1's count check cannot, on its own, tell apart from a real batch still legitimately confirming — without alarming on every genuinely in-flight batch that simply hasn't been mined yet.

Implemented inline in `runMonitorCycle`, backed by `createStaleSubmittedTracker` (`src/stale-submitted-tracker.ts`):

1. `observeSubmittedBatch(batchId)` records the first time this *process* has ever seen this batch id as `'submitted'` (`Date.now()` — this process's own clock, never anything read from Postgres) and returns whether it has been continuously tracked, unresolved, for at least `MONITOR_SUBMITTED_STALE_MS` (default: 24 hours). If not yet stale, nothing else happens for this batch this cycle — the ordinary state for almost every submitted batch, which usually confirms within minutes.
2. Once a batch id *is* stale, `getBatchInfo(batchId)` is called for real. If it now succeeds, the batch landed on-chain and Postgres's `status` column simply hasn't caught up yet — that's `anchor-service`'s own reconcile loop's job, not this daemon's — and nothing further happens here (such a batch is already in Phase 3's audit set, because the chain lists it). If it reverts `RootDoesNotExist`, that is the signal: a batch that has claimed to be on its way to being anchored for far longer than any honest confirmation or resend cycle should ever take, and that still does not exist on-chain at all. This fires a `root_divergence` alert (`expected_root: null`) naming that batch id.

**Why 24 hours, and why it cannot be shorter:** `anchor-service`'s own reconcile pass runs only once per `ANCHOR_CRON_SCHEDULE` tick (default every 3 hours), and a resend does not wait for its own confirmation either — it fires and returns, so confirming a resent transaction needs another full cron interval on top. Under nothing but `anchor-service`'s own defaults, a perfectly healthy submitted batch can legitimately take 6+ hours to resolve. An earlier version of this threshold (30 minutes, sized only against a single confirmation wait) would have false-alarmed on that entirely normal delay constantly. See [`docs/superpowers/specs/2026-09-24-monitor-service-daemon-design.md`](../superpowers/specs/2026-09-24-monitor-service-daemon-design.md) §3.1 for the full reasoning.

**Why this has to be this process's own clock, not `batches.created_at`:** that column is an ordinary, attacker-writable value under this system's own threat model — an attacker could keep a fake row's `created_at` pinned to "now" every cycle, forever suppressing this exact check. Tracking "how long have I personally watched this batch" in memory, never persisted anywhere, closes that hole specifically. The one honest tradeoff: a `monitor-service` restart resets the tracker, giving every currently-submitted batch one fresh grace period. That is a bounded, one-time delay, not a standing gap — exploiting it would need the ability to restart `monitor-service` itself faster than the threshold, repeatedly, which needs process control on the monitoring host, outside this system's threat model (database write access only).

### Phase 6 — Cycle Summary

**Responsibility:** assemble one structured record of everything the cycle did.

Implemented inline at the end of `runMonitorCycle`, logged via `logger.info(summary, "monitor cycle complete")`. Every cycle emits exactly one `MonitorCycleSummary`, containing:

- the cycle number, a per-stage timing breakdown (`stageMs`: `rootCountCheck`, `findConfirmedBatchIds`, `confirmedAudit`, `findSubmittedBatchIds`, `submittedStaleCheck`) and total `durationMs`, so a slow cycle can be diagnosed by which specific stage took the time. In a non-escalated sampling cycle, `findConfirmedBatchIds` is replaced by `selectBatches` (the selection) and `suspectCheck` (the suspects' `getBatchInfo` calls);
- `rootCountMatches` — whether Phase 1 found the two counts equal;
- `auditMode` (`"full"` or `"sampling"`) and `escalated` — whether this cycle was an escalated full rescan (always `false` in full mode);
- `batchesChecked` / `batchesComplete` and `recordsChecked` / `tamperedCount` from Phase 3;
- `submittedBatchesStaleChecked` — how many submitted batches actually crossed the staleness threshold and were individually re-checked this cycle, not how many are merely `'submitted'` — most cycles this is zero;
- `alertsFired` — the total number of alerts written this cycle, across all three checks combined;
- `peakRssBytes` — a peak memory snapshot taken once per audited batch, to catch memory growth from a very large rescan before it becomes an operational problem;
- `sampling` — present only in sampling mode: `pass` (0 until the first shuffle), `passPosition` (the cursor after this cycle's slice) and `passLength`, plus `sampledCount`, `newCount`, `spotCount` and `suspectCount` for what this cycle selected. An escalated cycle reports zero for all four counts.

---

## 3. Detection Guarantees (Recap)

The checks above (Phase 1's batch list and count check; Phase 3's anchor-count check, root rebuild and per-record proof loop; Phase 5's staleness check) each close a gap the others cannot see on their own:

- **Phase 3's root rebuild and per-record proof loop** catch an *edited* row — a record still present, still pinned to its batch, whose content no longer matches what was anchored. The rebuild notices that something in the batch changed; the proof loop is what names the specific `record_id`. A *count-preserving swap* — one record deleted and a copy of another pinned in its place, reusing the copy's stored proof — is caught the same way: a copy carries a new `id`/`entity_id`/`created_at`, so its leaf appears nowhere in the on-chain tree and is flagged (the deleted record is never named, only the pinned copy).
- **Phase 3's anchor count check** catches a *deleted* or *extra* pin — a record whose `anchor_records` pin vanished (invisible to a proof loop that only visits rows still there), or a forged extra pin.
- **Phase 1's chain batch list** catches a *hidden batch* — a batch the chain accepted whose Postgres row was deleted, or flipped to `'pending'`/`'failed'` — and names it by id and root, even when a padding row keeps the counts equal. Phase 2 then audits every on-chain batch that still has a row, so flipping a real batch to `'submitted'` cannot take it out of the audit either. The plain count check remains as the fallback for an anomaly no single batch explains.
- **Phase 5's stale-submitted check** catches a *forged padding batch* — a fake `'submitted'` row inserted specifically to keep Phase 1's count balanced after hiding a real one, which Phase 1 alone cannot distinguish from a real batch still legitimately confirming.

In sampling mode, the record-level guarantees of Phase 3 (edited rows, deleted or extra pins) hold within the bounded number of cycles given in Phase 2 rather than within one cycle; the batch-level guarantees of Phases 1, 2 (suspect check) and 5 are unchanged.

Together, there is no way to tamper with a `records` row, delete or forge an `anchor_records` pin, or hide/fake a `batches` row that survives more than one cycle (Phases 1-3) or `MONITOR_SUBMITTED_STALE_MS` (Phase 5) undetected. Two things are deliberately out of this daemon's reach, because the evidence never reaches the chain: a record deleted *before* `anchor-service` ever anchored it, and a replay of a legitimately signed create under a new `entity_id` (both documented in the E2E test plan, scenarios 9 and 10b). See [`docs/superpowers/specs/2026-09-24-monitor-service-daemon-design.md`](../superpowers/specs/2026-09-24-monitor-service-daemon-design.md) §3.1 for the argument for why the checks above are complete without needing to enumerate every root the contract has ever accepted.

Every alert this daemon writes is deduplicated before insertion, so a batch or record that keeps failing the same check, cycle after cycle, produces exactly one alert, not one per cycle — the same convention `anchor-service`'s own alerts use. The key differs by alert (`src/alerts.ts`): `recordRootDivergence` looks for an existing `root_divergence` row for the same `batch_id` (using Postgres's null-safe `IS NOT DISTINCT FROM`; for the whole-system count alert, whose `batch_id` is `null`, it matches only rows that also have no `expected_root`, so it is never suppressed by a missing-batch alert); `recordMissingBatch` keys on the batch's on-chain root (`expected_root`), so a later, different missing batch still alerts; `recordTampered` keys on `record_id`.

---

## 4. Alert Taxonomy

| `alert_type` | Fired by | `batch_id` | `record_id` | `expected_root` | Deduplicated by | Meaning |
|---|---|---|---|---|---|---|
| `root_divergence` | Phase 1 (count) | `null` | `null` | `null` | `batch_id` null + no `expected_root` | The contract's total root count disagrees with how many batches Postgres tracks as on-chain-or-on-the-way, and no missing/inconsistent batch explains it. No single batch to blame. |
| `root_divergence` | Phase 1 (missing / inconsistent batch) | `null` | `null` | the batch's on-chain root | `expected_root` | A batch the contract accepted has no `batches` row in Postgres, or Postgres lists it as `'pending'`/`'failed'`. |
| `root_divergence` | Phase 3 (step 1) | real | `null` | `null` | `batch_id` | A `'confirmed'` batch has no on-chain `BatchInfo` at all — its status was tampered, or it was never really confirmed. |
| `root_divergence` | Phase 3 (step 2) | real | `null` | on-chain root | `batch_id` | A batch's `anchor_records` count no longer matches its on-chain size — a pinned record was deleted, or an extra one appeared. |
| `root_divergence` | Phase 5 | real | `null` | `null` | `batch_id` | A `'submitted'` batch has had no on-chain `BatchInfo` for longer than any honest confirmation/resend cycle should take — likely fabricated or permanently stuck. |
| `record_tampered` | Phase 3 (step 3) | real | real | on-chain root | `record_id` | One specific record's recomputed leaf no longer verifies against its stored proof and the batch's on-chain root — its data was edited after anchoring, or the record is a forged pin. |

The three per-batch `root_divergence` rows (Phase 3 steps 1 and 2, Phase 5) share one dedup slot per `batch_id`: a batch gets at most one of them, whichever fires first.

Every row here is written with `source = 'monitor'`, distinguishing it from `anchor-service`'s own alerts (`source = 'anchor'`: `signature_mismatch`, `duplicate_root`, `root_divergence`, `record_tampered`) in the same `integrity_alerts` table.

---

## 5. Configuration Reference

Required: `DATABASE_URL`, `RPC_URL`, `ANCHOR_CHAIN_ID` (`loadConfig`, `src/config.ts`; `ANCHOR_PRIVATE_KEY` must **not** be set). Everything else is optional:

| Variable | Default in code | Effect |
|---|---|---|
| `CONTRACT_ADDRESS` | resolved from the committed deployment registry for `ANCHOR_CHAIN_ID` | Address of `MerkleAnchorRegistry`. |
| `MONITOR_CRON_SCHEDULE` | `*/5 * * * *` | When cycles start (§1.3). |
| `MONITOR_RPC_RETRIES` | `4` | `p-retry` attempts for each on-chain read (§1.2). |
| `MONITOR_SUBMITTED_STALE_MS` | `86400000` (24 h) | How long a batch must stay `'submitted'`, as seen by this process, before Phase 5 checks the chain for it. |
| `ANCHOR_MAX_BATCH_SIZE` | unset → rebuild limit `100000` | Read as the largest on-chain batch size whose root Phase 3 rebuilds in memory (`rootRebuildMaxSize`); larger batches are verified record by record. Shared with `anchor-service`, which never builds a batch above this size; both use the same default (`DEFAULT_MAX_BATCH_SIZE` in `service-runtime`) when it is unset. |
| `MONITOR_AUDIT_MODE` | `full` | `full` audits every anchored batch each cycle; `sampling` audits a shuffled-pass slice, new batches and spot checks (Phase 2). Any other value fails startup. |
| `MONITOR_SAMPLE_SIZE` | `10` (≥ 1) | Sampling mode only: batches taken from the pass each cycle (k). |
| `MONITOR_SPOT_CHECKS` | `1` (≥ 0) | Sampling mode only: extra batches drawn at random each cycle from outside the slice (j). |
| `MONITOR_SAMPLE_SEED` | unset | Sampling mode only: makes the random stream deterministic. Experiments only — it makes the order predictable. Startup warns whenever a seed is set, in either mode. |
| `MONITOR_ESCALATE_ON_ANOMALY` | `true` | Sampling mode only: `true`/`false`. Whether a cycle that detected an anomaly makes the next one a full rescan. Startup warns if `false`. |
| `SHUTDOWN_GRACE_MS` | `30000` | Grace period for an in-flight cycle on shutdown (§1.4). |
| `LOG_LEVEL` | `info` | pino log level. |

## 6. Benchmarks

Three tools produce the thesis evidence for the sampling trade-off. All of them write `<prefix>-<timestamp>.{json,csv,meta.json}` into `apps/monitor-service/bench/results/` (git-ignored); the `.meta.json` records the machine (CPU, cores, RAM, OS, Node), the git commit and the run's options. Design: `docs/superpowers/specs/2026-10-18-monitor-benchmarks-design.md`.

### 6.1 Cost benchmark — `bench:perf`

Measures cycle time, CPU and peak memory for a full rescan vs sampling (k = 3, and the k that guarantees a 1-hour worst case at a 1-minute cron, k = ⌈M/30⌉), at M = 10, 100 and 1,000 batches of 1,000 records. It runs the real cycle (real Postgres reads, hashing and chain calls) against a view that only sees the first M anchored batches, so one setup serves every size. Each (M, configuration) runs in its own child process, so peak memory doesn't leak between them.

Setup, once, **with both daemons stopped** (`docker compose stop anchor-service monitor-service`):

1. Fresh chain and empty database: `docker compose --profile local down -v`, then `docker compose --profile local up -d postgres hardhat-node`. A stray root left on the chain (e.g. by the anchor's `bench:cross-chain`) would make the run invalid.
2. `pnpm --filter anchor-service seed --count 1000000 --type prescription --truncate`
3. One anchor cycle with `ANCHOR_MAX_BATCH_SIZE=1000` (1,000 confirmed batches).

**Run the anchor's own `bench:perf` before this setup, never after: it truncates the database.**

Run (from `apps/monitor-service`, `DATABASE_URL` pointing at `localhost:5433`):

```bash
DATABASE_URL=<app_user DSN @localhost:5433> RPC_URL=http://localhost:8545 ANCHOR_CHAIN_ID=31337 \
  pnpm bench:perf [--batches 10,100,1000] [--batch-size 1000] [--full-cycles 3] [--sampling-cycles 10] [--seed bench-1]
```

It refuses to start if fewer than max(M) batches are anchored, if the on-chain batch size differs from `--batch-size`, or if any of those batches isn't `confirmed` in Postgres — printing the setup commands. A cycle that raises an alert or escalates makes the run invalid (the data isn't clean); if a cell fails, the rows already measured are still written and the `.meta.json` records `incomplete`, the failed cell and the error. Expect about 30 minutes, mostly the full rescans at 1,000 batches. Run it twice and check the two agree before charting one.

### 6.2 Detection-latency simulation — `bench:detection`

```bash
pnpm --filter monitor-service bench:detection [--trials 10000] [--trials-large 1000] [--seed bench-1]
```

Drives the real selector (`createAuditSelector`) with no DB and no chain: each trial tampers a random batch at a random point of a pass and counts cycles until it is audited, for M ∈ {10, 100, 1000}, k ∈ {1, 3, 4, 10, 34, 100}, j ∈ {0, 1}, against a fresh-random-draw baseline. Cells with a pass longer than 100 cycles use `--trials-large`. Output: `monitor-detection` (mean, p50, p95, max next to the theoretical worst case 2L − 1, the continuous mean 7L/12 and the exact discrete mean, computed from the real slice sizes — (7L − 1)(L + 1)/(12L) when k divides M) and `monitor-sizing` (k needed per M for 1 h @ 1 min, 1 h @ 5 min, 1 day @ 5 min). It exits non-zero if any shuffled-pass trial exceeds the safety cap. The full default run takes about 15 minutes.

### 6.3 Charts

```bash
tools/bench-charts/.venv/bin/python tools/bench-charts/plot.py apps/monitor-service/bench/results
tools/bench-charts/.venv/bin/python tools/bench-charts/plot.py apps/anchor-service/bench/results [--file <older run>]
```

Writes PNGs (Portuguese labels) into `<results-dir>/charts/` from the newest run of each kind and prints a suggested caption per chart. Setup and details: `tools/bench-charts/README.md`.

### 6.4 Live cross-check (manual)

To show the simulation matches the real daemon: run it with `MONITOR_AUDIT_MODE=sampling`, `MONITOR_ESCALATE_ON_ANOMALY=false` and `LOG_LEVEL=debug` (the `sampling order` line shows the pass), tamper one record (`pnpm --filter anchor-service tamper edit-record …`), note the cycle, and count the cycles until its `record_tampered` alert. A handful of runs should fall within the simulated distribution and never beyond 2L − 1.
