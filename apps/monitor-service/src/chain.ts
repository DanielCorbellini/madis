import {
  adaptMerkleAnchorRegistry,
  decodeRevertName,
  getMerkleAnchorRegistry,
  type MerkleAnchorRegistryLike,
} from "contracts-shared";
import { JsonRpcProvider } from "ethers";
import pRetry, { AbortError } from "p-retry";
import type { MonitorConfig } from "./config.ts";
import type { AnchoredBatch } from "./root-count-check.ts";

type ChainClientConfig = Pick<MonitorConfig, "rpcUrl" | "contractAddress">;

export interface ChainClient {
  provider: JsonRpcProvider;
  contract: MerkleAnchorRegistryLike;
}

/**
 * Creates a read-only chain client: a provider and a contract instance
 * with no wallet at all, since monitor-service only ever calls `view`
 * functions. The provider itself is the contract's `ContractRunner`.
 */
export function createReadOnlyChainClient(
  config: ChainClientConfig,
): ChainClient {
  const provider = new JsonRpcProvider(config.rpcUrl, undefined, {
    staticNetwork: true,
  });

  const contract = adaptMerkleAnchorRegistry(
    getMerkleAnchorRegistry(config.contractAddress, provider),
  );

  return { provider, contract };
}

/**
 * Retries a chain call on transient failures. A genuine contract revert (e.g.
 * `RootDoesNotExist`) is deterministic — retrying it changes nothing — so it's
 * decoded and aborted immediately instead of retried; only network/RPC-shaped
 * failures (timeout, connection reset, rate limit) get retried.
 */
function retryTransient<T>(
  fn: () => Promise<T>,
  retries: number,
): Promise<T> {
  return pRetry(
    async () => {
      try {
        return await fn();
      } catch (error) {
        if (decodeRevertName(error) !== null) {
          throw new AbortError(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
        throw error;
      }
    },
    { retries },
  );
}

/**
 * Wraps `getBatchInfo`/`getRootCount` with retry-on-transient-failure.
 * `getRootCount` has no revert case of its own in practice, but sharing the
 * helper keeps the retry policy in one place.
 */
export function createRetryingContract(
  contract: Pick<MerkleAnchorRegistryLike, "getBatchInfo" | "getRootCount">,
  options: { retries: number },
): Pick<MerkleAnchorRegistryLike, "getBatchInfo" | "getRootCount"> {
  return {
    getBatchInfo: (batchId) =>
      retryTransient(() => contract.getBatchInfo(batchId), options.retries),
    getRootCount: () =>
      retryTransient(() => contract.getRootCount(), options.retries),
  };
}

/**
 * Every `(batchId, root)` the contract has ever accepted, read from the
 * `RootAdded` event log — chain-sourced, so a deleted Postgres row can't hide
 * from it. Used only to name the batches behind a root-count mismatch.
 */
export async function listAnchoredBatches(
  contract: Pick<MerkleAnchorRegistryLike, "filters" | "queryFilter">,
  options: { retries: number },
): Promise<AnchoredBatch[]> {
  const logs = await retryTransient(
    () => contract.queryFilter(contract.filters.RootAdded()),
    options.retries,
  );

  return logs.map((log) => ({
    batchId: Number(log.args.batchId),
    root: log.args.root,
  }));
}
