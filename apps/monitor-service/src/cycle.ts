import {
  decodeRevertName,
  type MerkleAnchorRegistryLike,
} from "contracts-shared";
import type { Pool } from "pg";
import { timed, trackPeakMemory, type Logger } from "service-runtime";
import {
  recordMissingBatch as dbRecordMissingBatch,
  recordRootDivergence as dbRecordRootDivergence,
} from "./alerts.ts";
import { createAuditSelector, type AuditSelector } from "./audit-selection.ts";
import {
  auditBatch as runAuditBatch,
  type AuditDeps,
  type AuditSummary,
} from "./audit.ts";
import {
  countTrackedBatches as dbCountTrackedBatches,
  findConfirmedBatchIds as dbFindConfirmedBatchIds,
  findSubmittedBatchIds as dbFindSubmittedBatchIds,
  findBatchStatuses as dbFindBatchStatuses,
  type BatchStatus,
} from "./batch-selection-repository.ts";
import type { RandomInt } from "./random-source.ts";
import {
  checkRootCount,
  classifyOnChainBatches,
  type AnchoredBatch,
  type OnChainBatchClassification,
} from "./root-count-check.ts";
import { createStaleSubmittedTracker } from "./stale-submitted-tracker.ts";

export interface SamplingDeps {
  selector: AuditSelector;
  escalateOnAnomaly: boolean;
  /** Mutated by runMonitorCycle: true makes the next cycle a full rescan. */
  escalation: { pending: boolean };
}

export interface CycleDeps {
  auditBatch(batchId: number): Promise<AuditSummary>;
  batches: {
    findConfirmedBatchIds(): Promise<number[]>;
    findSubmittedBatchIds(): Promise<number[]>;
    countTrackedBatches(): Promise<number>;
    findBatchStatuses(batchIds: number[]): Promise<Map<number, BatchStatus>>;
  };
  chain: {
    getBatchInfo(batchId: number): Promise<{ root: string; size: number }>;
    getRootCount(): Promise<number>;
    listAnchoredBatches(): Promise<AnchoredBatch[]>;
    decodeRevertName(error: unknown): string | null;
  };
  tracking: {
    observeSubmittedBatch(batchId: number): boolean;
    pruneSubmittedTracking(currentBatchIds: number[]): void;
  };
  alerts: {
    recordRootDivergence(
      batchId: number | null,
      expectedRoot: string | null,
      details: string,
    ): Promise<boolean>;
    recordMissingBatch(root: string, details: string): Promise<boolean>;
  };
  /** Absent means full mode: every anchored batch is audited each cycle. */
  sampling?: SamplingDeps;
}

export interface MonitorCycleSummary {
  cycle: number;
  batchesChecked: number;
  batchesComplete: number;
  recordsChecked: number;
  tamperedCount: number;
  rootCountMatches: boolean;
  submittedBatchesStaleChecked: number;
  alertsFired: number;
  durationMs: number;
  stageMs: Record<string, number>;
  peakRssBytes: number;
  auditMode: "full" | "sampling";
  escalated: boolean;
  sampling?: {
    pass: number;
    passPosition: number;
    passLength: number;
    sampledCount: number;
    newCount: number;
    spotCount: number;
    suspectCount: number;
  };
}

/**
 * Reads the chain's own `(batchId, root)` list and sorts it against what
 * Postgres says about those ids. A failure here must never break the cycle, so
 * it degrades to `null` and the caller falls back to the generic count alert
 * plus, in full or escalated cycles, a confirmed-only rescan or, in sampling
 * cycles, the current pass (nothing before the first pass, §5.7).
 */
async function classifyChainBatches(
  deps: Pick<CycleDeps, "chain" | "batches">,
  logger: Logger,
  sampled: boolean,
): Promise<OnChainBatchClassification | null> {
  try {
    const onChain = await deps.chain.listAnchoredBatches();
    const statuses = await deps.batches.findBatchStatuses(
      onChain.map((batch) => batch.batchId),
    );

    return classifyOnChainBatches(onChain, statuses);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      { err: message },
      sampled
        ? "could not read the chain's batch list; continuing the current pass from the last known list (auditing nothing if no pass has started), checking confirmed batches outside it on-chain, and falling back to the generic count alert"
        : "could not read the chain's batch list; auditing confirmed batches only and falling back to the generic count alert",
    );
    return null;
  }
}

/**
 * Sequences one full monitor cycle:
 * 1. the chain's batch list (missing/inconsistent batches) and the root
 *    count check,
 * 2. an audit of the on-chain batches that still have a row, whatever their
 *    `status` (the mode decides which: all of them, or a sampled subset), and
 * 3. the stale-submitted check.
 * Results from all three are aggregated into one structured summary
 * logged at the end.
 *
 * A single batch's failure never stops the loop — a decoded `RootDoesNotExist`,
 * on either a confirmed batch or a stale submitted one, fires its own
 * alert rather than just a log line, since a Postgres row claiming
 * on-chain success with no matching `BatchInfo` is itself a tampering
 * signal, not merely an anomaly. The root count mismatch case has no
 * single batch to blame, so its alert is recorded with a `null` batchId.
 */
export async function runMonitorCycle(
  deps: CycleDeps,
  cycleNumber: number,
  logger: Logger,
  shouldAbort: () => boolean = () => false,
): Promise<MonitorCycleSummary> {
  const cycleStart = performance.now();
  const memory = trackPeakMemory();

  let alertsFired = 0;
  let anomalyCount = 0;
  const sampling = deps.sampling;
  const escalated = sampling?.escalation.pending ?? false;

  // Escalation is set the moment an anomaly is seen, so a later throw cannot lose it.
  const countAnomalies = (count: number): void => {
    anomalyCount += count;
    if (count > 0 && sampling?.escalateOnAnomaly) {
      sampling.escalation.pending = true;
    }
  };

  const { result: rootCountResult, ms: rootCountMs } = await timed(async () => {
    const [onChainRootCount, trackedBatchCount] = await Promise.all([
      deps.chain.getRootCount(),
      deps.batches.countTrackedBatches(),
    ]);

    return checkRootCount(onChainRootCount, trackedBatchCount);
  });

  const classification = await classifyChainBatches(
    deps,
    logger,
    sampling !== undefined && !escalated,
  );

  countAnomalies(
    (classification?.missing.length ?? 0) +
      (classification?.inconsistent.length ?? 0) +
      (rootCountResult.matches ? 0 : 1),
  );

  // The chain knows every batch it accepted, so a batch Postgres lost track of
  // is named whether or not the counts happen to agree (a forged 'submitted'
  // row can pad the count back to equal).
  for (const batch of classification?.missing ?? []) {
    const detail = `batch ${batch.batchId} (root ${batch.root}) was accepted on-chain but is no longer tracked as confirmed/submitted in Postgres — its batches row was likely deleted or its status tampered`;

    logger.error({ batchId: batch.batchId, root: batch.root }, detail);
    await deps.alerts.recordMissingBatch(batch.root, detail);
    alertsFired++;
  }

  for (const batch of classification?.inconsistent ?? []) {
    const detail = `batch ${batch.batchId} (root ${batch.root}) was accepted on-chain but Postgres lists it as '${batch.status}' — its status was likely tampered`;

    logger.error({ batchId: batch.batchId, root: batch.root }, detail);
    await deps.alerts.recordMissingBatch(batch.root, detail);
    alertsFired++;
  }

  if (!rootCountResult.matches) {
    const message = `on-chain root count ${rootCountResult.onChainRootCount} does not match ${rootCountResult.trackedBatchCount} batches tracked as confirmed/submitted in Postgres — a batch was likely deleted or had its status tampered`;

    logger.error(
      {
        onChainRootCount: rootCountResult.onChainRootCount,
        trackedBatchCount: rootCountResult.trackedBatchCount,
      },
      message,
    );

    // The per-batch alerts above already explain the mismatch when they exist;
    // only an unexplained one (the opposite anomaly, or the listing failed)
    // falls back to the generic whole-system alert.
    const explained =
      (classification?.missing.length ?? 0) +
        (classification?.inconsistent.length ?? 0) >
      0;

    if (!explained) {
      await deps.alerts.recordRootDivergence(null, null, message);
      alertsFired++;
    }
  }

  // Full and escalated cycles audit every batch Postgres calls confirmed plus
  // every batch the chain accepted that Postgres still has a row for, whatever
  // status that row claims. Sampling cycles pick from the chain list only.
  const { result: selected, ms: findMs } = await timed(async () => {
    const confirmed = await deps.batches.findConfirmedBatchIds();
    const seen = new Set(confirmed);
    const all = [
      ...confirmed,
      ...(classification?.auditable ?? []).filter((id) => !seen.has(id)),
    ];

    if (!sampling) return { auditIds: all, selection: null };

    const selection = sampling.selector.select({
      chainIds: classification?.auditable ?? null,
      confirmedIds: confirmed,
      escalated,
    });

    return {
      auditIds: escalated
        ? all
        : [...selection.sliceIds, ...selection.newIds, ...selection.spotIds],
      selection,
    };
  });

  const { auditIds, selection } = selected;
  // Slice ids still owed a verdict; whatever is left at the end goes back into the pass.
  const owedSliceIds = new Set(selection?.sliceIds);

  const alertConfirmedWithoutRoot = async (batchId: number): Promise<void> => {
    const message = `batch ${batchId} is 'confirmed' in Postgres but has no on-chain BatchInfo for this batchId — possible status tampering or the anchor was never actually confirmed`;
    logger.error({ batchId }, message);
    await deps.alerts.recordRootDivergence(batchId, null, message);
    alertsFired++;
    countAnomalies(1);
  };

  try {
    // A suspect is a confirmed id the chain list lacks; the chain has the last word.
    const { ms: suspectMs } = await timed(async () => {
      if (escalated) return;

      for (const batchId of selection?.suspectIds ?? []) {
        if (shouldAbort()) break;

        try {
          await deps.chain.getBatchInfo(batchId);
        } catch (error) {
          if (deps.chain.decodeRevertName(error) === "RootDoesNotExist") {
            await alertConfirmedWithoutRoot(batchId);
            continue;
          }

          const message =
            error instanceof Error ? error.message : String(error);
          logger.error(
            { batchId, err: message },
            "failed to check suspect batch, skipping",
          );
        }
      }
    });

    let batchesChecked = 0;
    let batchesComplete = 0;
    let recordsChecked = 0;
    let tamperedCount = 0;

    const { ms: auditMs } = await timed(async () => {
      for (const [index, batchId] of auditIds.entries()) {
        if (shouldAbort()) {
          logger.warn(
            { cycle: cycleNumber, batchId },
            "shutdown requested — stopping before the next batch",
          );
          // Skipped on shutdown, not failed: these slots stay consumed (§5.8).
          for (const id of auditIds.slice(index)) owedSliceIds.delete(id);
          break;
        }

        batchesChecked++;
        memory.sample();

        try {
          const summary = await deps.auditBatch(batchId);
          owedSliceIds.delete(batchId);

          if (summary.complete) {
            batchesComplete++;
          } else {
            alertsFired++;
            countAnomalies(1);
          }

          recordsChecked += summary.recordsChecked;
          tamperedCount += summary.tamperedRecordIds.length;
          alertsFired += summary.tamperedRecordIds.length;
          countAnomalies(summary.tamperedRecordIds.length);
        } catch (error) {
          const revertName = deps.chain.decodeRevertName(error);

          if (revertName === "RootDoesNotExist") {
            await alertConfirmedWithoutRoot(batchId);
            owedSliceIds.delete(batchId);
            continue;
          }

          const message =
            error instanceof Error ? error.message : String(error);
          logger.error(
            { batchId, err: message },
            "failed to audit batch, skipping",
          );
        }
      }
    });

    const { result: submittedIds, ms: findSubmittedMs } = await timed(() =>
      deps.batches.findSubmittedBatchIds(),
    );

    deps.tracking.pruneSubmittedTracking(submittedIds);

    let submittedBatchesStaleChecked = 0;

    const { ms: submittedMs } = await timed(async () => {
      for (const batchId of submittedIds) {
        if (shouldAbort()) {
          break;
        }

        if (!deps.tracking.observeSubmittedBatch(batchId)) {
          continue; // still within the normal in-flight grace period
        }

        submittedBatchesStaleChecked++;

        try {
          await deps.chain.getBatchInfo(batchId);
          // Landed on-chain — Postgres just hasn't reconciled its status
          // yet. Nothing to do; the next anchor-service reconcile cycle
          // will catch up.
        } catch (error) {
          const revertName = deps.chain.decodeRevertName(error);

          if (revertName === "RootDoesNotExist") {
            const message = `batch ${batchId} has been 'submitted' with no on-chain BatchInfo for longer than expected — likely fabricated or permanently stuck`;
            logger.error({ batchId }, message);
            await deps.alerts.recordRootDivergence(batchId, null, message);
            alertsFired++;
            countAnomalies(1);
            continue;
          }

          const message =
            error instanceof Error ? error.message : String(error);
          logger.error(
            { batchId, err: message },
            "failed to check stale submitted batch, skipping",
          );
        }
      }
    });

    // Keyed off anomalies, not alertsFired: alert inserts are deduplicated.
    if (sampling && anomalyCount === 0) sampling.escalation.pending = false;

    const summary: MonitorCycleSummary = {
      cycle: cycleNumber,
      batchesChecked,
      batchesComplete,
      recordsChecked,
      tamperedCount,
      rootCountMatches: rootCountResult.matches,
      submittedBatchesStaleChecked,
      alertsFired,
      durationMs: Math.round(performance.now() - cycleStart),
      stageMs: {
        rootCountCheck: Math.round(rootCountMs),
        ...(sampling && !escalated
          ? {
              selectBatches: Math.round(findMs),
              suspectCheck: Math.round(suspectMs),
            }
          : { findConfirmedBatchIds: Math.round(findMs) }),
        confirmedAudit: Math.round(auditMs),
        findSubmittedBatchIds: Math.round(findSubmittedMs),
        submittedStaleCheck: Math.round(submittedMs),
      },
      peakRssBytes: memory.peak().rssBytes,
      auditMode: sampling ? "sampling" : "full",
      escalated,
      ...(sampling && selection
        ? {
            sampling: {
              pass: selection.pass,
              passPosition: selection.passPosition,
              passLength: selection.passLength,
              sampledCount: selection.sliceIds.length,
              newCount: selection.newIds.length,
              spotCount: selection.spotIds.length,
              suspectCount: selection.suspectIds.length,
            },
          }
        : {}),
    };

    logger.info(summary, "monitor cycle complete");
    return summary;
  } finally {
    // Failed or never reached (a throw): back into the unvisited part, once per pass (§5.3.1).
    if (sampling && owedSliceIds.size > 0) {
      for (const batchId of sampling.selector.requeue([...owedSliceIds])) {
        logger.error(
          { batchId },
          `batch ${batchId} could not be audited this pass — its audit failed again after a requeue, so its slot is consumed`,
        );
      }
    }
  }
}

/**
 * Creates the dependencies for a single monitor cycle
 */
export function createCycleDeps(
  auditDeps: AuditDeps,
  contract: Pick<MerkleAnchorRegistryLike, "getRootCount">,
  pool: Pool,
  logger: Logger,
  options: {
    submittedStaleMs: number;
    listAnchoredBatches: () => Promise<AnchoredBatch[]>;
    sampling?: {
      sampleSize: number;
      spotChecks: number;
      randomInt: RandomInt;
      escalateOnAnomaly: boolean;
    };
  },
): CycleDeps {
  const tracker = createStaleSubmittedTracker(options.submittedStaleMs);

  return {
    auditBatch: (batchId) => runAuditBatch(auditDeps, batchId, logger),
    batches: {
      findConfirmedBatchIds: () => dbFindConfirmedBatchIds(pool),
      findSubmittedBatchIds: () => dbFindSubmittedBatchIds(pool),
      countTrackedBatches: () => dbCountTrackedBatches(pool),
      findBatchStatuses: (batchIds) => dbFindBatchStatuses(pool, batchIds),
    },
    chain: {
      getBatchInfo: (batchId) => auditDeps.chain.getBatchInfo(batchId),
      getRootCount: () => contract.getRootCount(),
      listAnchoredBatches: options.listAnchoredBatches,
      decodeRevertName,
    },
    tracking: {
      observeSubmittedBatch: (batchId) => tracker.observe(batchId),
      pruneSubmittedTracking: (currentBatchIds) =>
        tracker.pruneExcept(currentBatchIds),
    },
    alerts: {
      recordRootDivergence: (batchId, expectedRoot, details) =>
        dbRecordRootDivergence(pool, batchId, expectedRoot, details),
      recordMissingBatch: (root, details) =>
        dbRecordMissingBatch(pool, root, details),
    },
    ...(options.sampling && {
      sampling: {
        selector: createAuditSelector(options.sampling),
        escalateOnAnomaly: options.sampling.escalateOnAnomaly,
        escalation: { pending: false },
      },
    }),
  };
}
