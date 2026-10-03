import {
  decodeRevertName,
  type MerkleAnchorRegistryLike,
} from "contracts-shared";
import type { Pool } from "pg";
import { timed, trackPeakMemory, type Logger } from "service-runtime";
import { recordRootDivergence as dbRecordRootDivergence } from "./alerts.ts";
import {
  auditBatch as runAuditBatch,
  type AuditDeps,
  type AuditSummary,
} from "./audit.ts";
import {
  countTrackedBatches as dbCountTrackedBatches,
  findConfirmedBatchIds as dbFindConfirmedBatchIds,
  findSubmittedBatchIds as dbFindSubmittedBatchIds,
} from "./batch-selection-repository.ts";
import { checkRootCount } from "./root-count-check.ts";
import { createStaleSubmittedTracker } from "./stale-submitted-tracker.ts";

export interface CycleDeps {
  auditBatch(batchId: number): Promise<AuditSummary>;
  batches: {
    findConfirmedBatchIds(): Promise<number[]>;
    findSubmittedBatchIds(): Promise<number[]>;
    countTrackedBatches(): Promise<number>;
  };
  chain: {
    getBatchInfo(batchId: number): Promise<{ root: string; size: number }>;
    getRootCount(): Promise<number>;
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
 * Sequences one full monitor cycle:
 * 1. the root count check,
 * 2. a full rescan of every confirmed batch, and
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

  if (!rootCountResult.matches) {
    const message = `on-chain root count ${rootCountResult.onChainRootCount} does not match ${rootCountResult.trackedBatchCount} batches tracked as confirmed/submitted in Postgres — a batch was likely deleted or had its status tampered`;

    logger.error(
      {
        onChainRootCount: rootCountResult.onChainRootCount,
        trackedBatchCount: rootCountResult.trackedBatchCount,
      },
      message,
    );

    await deps.alerts.recordRootDivergence(null, null, message);
    alertsFired++;
  }

  const { result: batchIds, ms: findMs } = await timed(() =>
    deps.batches.findConfirmedBatchIds(),
  );

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
  options: { submittedStaleMs: number },
): CycleDeps {
  const tracker = createStaleSubmittedTracker(options.submittedStaleMs);

  return {
    auditBatch: (batchId) => runAuditBatch(auditDeps, batchId, logger),
    batches: {
      findConfirmedBatchIds: () => dbFindConfirmedBatchIds(pool),
      findSubmittedBatchIds: () => dbFindSubmittedBatchIds(pool),
      countTrackedBatches: () => dbCountTrackedBatches(pool),
    },
    chain: {
      getBatchInfo: (batchId) => auditDeps.chain.getBatchInfo(batchId),
      getRootCount: () => contract.getRootCount(),
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
    },
  };
}
