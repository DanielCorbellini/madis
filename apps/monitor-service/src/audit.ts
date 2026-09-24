import type { MerkleAnchorRegistryLike } from "contracts-shared";
import type { Pool } from "pg";
import type { Logger } from "service-runtime";
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
import { verifyAnchoredRecord } from "./record-verification.ts";

export interface AuditDeps {
  getBatchInfo(batchId: number): Promise<{ root: string; size: number }>;
  countAnchoredRecords(batchId: number): Promise<number>;
  streamAnchoredRecords(batchId: number): AsyncGenerator<AnchoredRecordEntry>;
  recordRootDivergence(batchId: number, details: string): Promise<boolean>;
  recordTampered(
    batchId: number,
    recordId: number,
    details: string,
  ): Promise<boolean>;
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
 * check (an O(1) count vs. the on-chain size) plus per-record proof
 * verification (recomputing each leaf from current raw `records` columns).
 * Both read the chain as the only trustworthy source for the batch's root
 * and size — never Postgres's own `batches.size`. Which batches to audit
 * and when is a daemon-level policy decision left to a future caller.
 */
export async function auditBatch(
  deps: AuditDeps,
  batchId: number,
  logger: Logger,
): Promise<AuditSummary> {
  const { root, size } = await deps.getBatchInfo(batchId);
  const anchoredCount = await deps.countAnchoredRecords(batchId);
  const anchorCountCheck = checkAnchorCount(size, anchoredCount);

  if (!anchorCountCheck.complete) {
    const message = `batch ${batchId}: anchor_records count ${anchoredCount} does not match on-chain size ${size} — a pinned record was likely deleted`;
    logger.error({ batchId, onChainSize: size, anchoredCount }, message);
    await deps.recordRootDivergence(batchId, message);
  }

  let recordsChecked = 0;
  const tamperedRecordIds: number[] = [];

  for await (const { record, proof } of deps.streamAnchoredRecords(batchId)) {
    recordsChecked++;
    const { verified } = verifyAnchoredRecord(record, proof, root);

    if (!verified) {
      tamperedRecordIds.push(record.id);
      const message = `record ${record.id} in batch ${batchId}: recomputed leaf does not verify against its stored proof and the on-chain root — data was likely tampered with`;
      logger.error({ batchId, recordId: record.id }, message);
      await deps.recordTampered(batchId, record.id, message);
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

/** Wires `auditBatch`'s dependencies to a real chain contract and Postgres pool. */
export function createAuditDeps(
  contract: Pick<MerkleAnchorRegistryLike, "getBatchInfo">,
  pool: Pool,
): AuditDeps {
  return {
    getBatchInfo: (batchId) => contract.getBatchInfo(batchId),
    countAnchoredRecords: (batchId) => dbCountAnchoredRecords(pool, batchId),
    streamAnchoredRecords: (batchId) => dbStreamAnchoredRecords(pool, batchId),
    recordRootDivergence: (batchId, details) =>
      dbRecordRootDivergence(pool, batchId, details),
    recordTampered: (batchId, recordId, details) =>
      dbRecordTampered(pool, batchId, recordId, details),
  };
}
