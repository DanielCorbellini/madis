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
import {
  checkRootCount,
  classifyOnChainBatches,
  type AnchoredBatch,
  type OnChainBatchClassification,
} from "./root-count-check.ts";
import { createStaleSubmittedTracker } from "./stale-submitted-tracker.ts";

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
}

/**
 * Reads the chain's own `(batchId, root)` list and sorts it against what
 * Postgres says about those ids. A failure here must never break the cycle, so
 * it degrades to `null` and the caller falls back to the Postgres-driven
 * checks (confirmed rescan + generic count alert).
 */
async function classifyChainBatches(
  deps: Pick<CycleDeps, "chain" | "batches">,
  logger: Logger,
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
      "could not read the chain's batch list; auditing confirmed batches only and falling back to the generic count alert",
    );
    return null;
  }
}

/**
 * Sequences one full monitor cycle:
 * 1. the chain's batch list (missing/inconsistent batches) and the root
 *    count check,
 * 2. a full audit of every confirmed batch plus every on-chain batch that
 *    still has a row, whatever its `status`, and
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

  const { result: rootCountResult, ms: rootCountMs } = await timed(async () => {
    const [onChainRootCount, trackedBatchCount] = await Promise.all([
      deps.chain.getRootCount(),
      deps.batches.countTrackedBatches(),
    ]);

    return checkRootCount(onChainRootCount, trackedBatchCount);
  });

  const classification = await classifyChainBatches(deps, logger);

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

  // Audit every batch Postgres calls confirmed, plus every batch the chain
  // accepted that Postgres still has a row for — whatever status that row
  // claims, so flipping `status` cannot take a batch out of the audit.
  const { result: batchIds, ms: findMs } = await timed(async () => {
    const confirmed = await deps.batches.findConfirmedBatchIds();
    const seen = new Set(confirmed);

    return [
      ...confirmed,
      ...(classification?.auditable ?? []).filter((id) => !seen.has(id)),
    ];
  });

  let batchesChecked = 0;
  let batchesComplete = 0;
  let recordsChecked = 0;
  let tamperedCount = 0;

  const { ms: auditMs } = await timed(async () => {
    for (const batchId of batchIds) {
      if (shouldAbort()) {
        logger.warn(
          { cycle: cycleNumber, batchId },
          "shutdown requested — stopping before the next batch",
        );
        break;
      }

      batchesChecked++;
      memory.sample();

      try {
        const summary = await deps.auditBatch(batchId);

        if (summary.complete) {
          batchesComplete++;
        } else {
          alertsFired++;
        }

        recordsChecked += summary.recordsChecked;
        tamperedCount += summary.tamperedRecordIds.length;
        alertsFired += summary.tamperedRecordIds.length;
      } catch (error) {
        const revertName = deps.chain.decodeRevertName(error);

        if (revertName === "RootDoesNotExist") {
          const message = `batch ${batchId} is 'confirmed' in Postgres but has no on-chain BatchInfo for this batchId — possible status tampering or the anchor was never actually confirmed`;
          logger.error({ batchId }, message);
          await deps.alerts.recordRootDivergence(batchId, null, message);
          alertsFired++;
          continue;
        }

        const message = error instanceof Error ? error.message : String(error);
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
          continue;
        }

        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          { batchId, err: message },
          "failed to check stale submitted batch, skipping",
        );
      }
    }
  });

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
      findConfirmedBatchIds: Math.round(findMs),
      confirmedAudit: Math.round(auditMs),
      findSubmittedBatchIds: Math.round(findSubmittedMs),
      submittedStaleCheck: Math.round(submittedMs),
    },
    peakRssBytes: memory.peak().rssBytes,
  };

  logger.info(summary, "monitor cycle complete");
  return summary;
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
  };
}
