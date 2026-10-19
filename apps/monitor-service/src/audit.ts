import { computeMerkleRoot } from "crypto-utils";
import type { MerkleAnchorRegistryLike } from "contracts-shared";
import type { Pool } from "pg";
import { DEFAULT_MAX_BATCH_SIZE, type Logger } from "service-runtime";
import {
  countAnchoredRecords as dbCountAnchoredRecords,
  streamAnchoredRecords as dbStreamAnchoredRecords,
  type AnchoredRecordEntry,
} from "./audit-repository.ts";
import {
  recordRootDivergence as dbRecordRootDivergence,
  recordTampered as dbRecordTampered,
} from "./alerts.ts";
import { checkAnchorCount } from "./anchor-count.ts";
import {
  computeRecordLeaf,
  verifyAnchoredRecord,
} from "./record-verification.ts";

export interface AuditDeps {
  /**
   * Largest on-chain batch size whose root is rebuilt in memory (O(n) memory);
   * bigger batches are verified record by record, streaming in constant
   * memory. Defaults to `DEFAULT_MAX_BATCH_SIZE`.
   */
  rootRebuildMaxSize?: number;
  chain: {
    getBatchInfo(batchId: number): Promise<{ root: string; size: number }>;
  };
  records: {
    countAnchoredRecords(batchId: number): Promise<number>;
    streamAnchoredRecords(batchId: number): AsyncGenerator<AnchoredRecordEntry>;
  };
  alerts: {
    recordRootDivergence(
      batchId: number,
      expectedRoot: string | null,
      details: string,
    ): Promise<boolean>;
    recordTampered(
      batchId: number,
      recordId: number,
      expectedRoot: string,
      details: string,
    ): Promise<boolean>;
  };
}

export interface AuditSummary {
  batchId: number;
  onChainRoot: string;
  onChainSize: number;
  anchoredCount: number;
  complete: boolean;
  recordsChecked: number;
  tamperedRecordIds: number[];
}

/**
 * Audits one already-anchored batch against the chain: anchor count
 * check (an O(1) count vs. the on-chain size) plus a root rebuild
 * (never Postgres's own `batches.size`/`merkle_root`). Which batches to
 * audit and when is a daemon-level policy decision left to a future
 * caller.
 */
export async function auditBatch(
  deps: AuditDeps,
  batchId: number,
  logger: Logger,
): Promise<AuditSummary> {
  const { root, size } = await deps.chain.getBatchInfo(batchId);
  const anchoredCount = await deps.records.countAnchoredRecords(batchId);
  const anchorCountCheck = checkAnchorCount(size, anchoredCount);

  if (!anchorCountCheck.complete) {
    const message = `batch ${batchId}: anchor_records count ${anchoredCount} does not match on-chain size ${size} — a pinned record was likely deleted`;
    logger.error({ batchId, onChainSize: size, anchoredCount }, message);
    await deps.alerts.recordRootDivergence(batchId, root, message);
  }

  const rebuildLimit = deps.rootRebuildMaxSize ?? DEFAULT_MAX_BATCH_SIZE;

  if (anchorCountCheck.complete && size > rebuildLimit) {
    logger.debug(
      { batchId, size, rebuildLimit },
      "batch is larger than the root-rebuild limit, verifying record by record",
    );
  }

  if (anchorCountCheck.complete && size <= rebuildLimit) {
    const fastPath = await tryFastPath(deps, batchId, root, logger);

    if (fastPath) {
      return {
        batchId,
        onChainRoot: root,
        onChainSize: size,
        anchoredCount,
        complete: true,
        recordsChecked: fastPath.recordsChecked,
        tamperedRecordIds: [],
      };
    }
  }

  let recordsChecked = 0;
  const tamperedRecordIds: number[] = [];

  for await (const { record, proof } of deps.records.streamAnchoredRecords(
    batchId,
  )) {
    recordsChecked++;
    const { verified } = verifyAnchoredRecord(record, proof, root);

    if (!verified) {
      tamperedRecordIds.push(record.id);
      const message = `record ${record.id} in batch ${batchId}: recomputed leaf does not verify against its stored proof and the on-chain root — data was likely tampered with`;
      logger.error({ batchId, recordId: record.id }, message);
      await deps.alerts.recordTampered(batchId, record.id, root, message);
    }
  }

  return {
    batchId,
    onChainRoot: root,
    onChainSize: size,
    anchoredCount,
    complete: anchorCountCheck.complete,
    recordsChecked,
    tamperedRecordIds,
  };
}

/**
 * Tries to confirm a batch is clean by rebuilding its root from every
 * currently-pinned record's current content and comparing it to the
 * on-chain root — needs no stored proof at all, unlike the per-record
 * fallback, so it's the cheap path for the common case where nothing is
 * wrong. Returns `null` (never throws) on any mismatch, or if anything
 * about the rebuild itself fails (e.g. a malformed record's leaf
 * computation throwing) — either way, the caller falls back to the
 * per-record loop, which is the only thing that can actually name a
 * tampered record.
 */
async function tryFastPath(
  deps: Pick<AuditDeps, "records">,
  batchId: number,
  onChainRoot: string,
  logger: Logger,
): Promise<{ recordsChecked: number } | null> {
  const leaves: string[] = [];

  try {
    for await (const { record } of deps.records.streamAnchoredRecords(
      batchId,
    )) {
      leaves.push(computeRecordLeaf(record));
    }

    logger.debug({ batchId }, "rebuilding merkle root");

    if (computeMerkleRoot(leaves) !== onChainRoot) {
      return null;
    }

    return { recordsChecked: leaves.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      { batchId, err: message },
      "batch root rebuild failed, falling back to per-record verification",
    );
    return null;
  }
}

/** Wires `auditBatch`'s dependencies to a real chain contract and Postgres pool. */
export function createAuditDeps(
  contract: Pick<MerkleAnchorRegistryLike, "getBatchInfo">,
  pool: Pool,
  options: { rootRebuildMaxSize?: number } = {},
): AuditDeps {
  return {
    rootRebuildMaxSize: options.rootRebuildMaxSize,
    chain: {
      getBatchInfo: (batchId) => contract.getBatchInfo(batchId),
    },
    records: {
      countAnchoredRecords: (batchId) => dbCountAnchoredRecords(pool, batchId),
      streamAnchoredRecords: (batchId) =>
        dbStreamAnchoredRecords(pool, batchId),
    },
    alerts: {
      recordRootDivergence: (batchId, expectedRoot, details) =>
        dbRecordRootDivergence(pool, batchId, expectedRoot, details),
      recordTampered: (batchId, recordId, expectedRoot, details) =>
        dbRecordTampered(pool, batchId, recordId, expectedRoot, details),
    },
  };
}
