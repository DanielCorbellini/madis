import {
  adaptMerkleAnchorRegistry,
  decodeRevertName,
  getMerkleAnchorRegistry,
  type MerkleAnchorRegistryLike,
} from "contracts-shared";
import { JsonRpcProvider } from "ethers";
import pRetry, { AbortError } from "p-retry";
import type { MonitorConfig } from "./config.ts";

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
 * Wraps `getBatchInfo`/`getRootCount` with retry-on-transient-failure. A
 * genuine contract revert (e.g. `RootDoesNotExist`) is deterministic —
 * retrying it changes nothing — so it's decoded and aborted immediately
 * instead of retried; only network/RPC-shaped failures (timeout,
 * connection reset, rate limit) get retried. `getRootCount` has no
 * revert case of its own in practice, but sharing this helper keeps the
 * retry policy in one place.
 */
export function createRetryingContract(
  contract: Pick<MerkleAnchorRegistryLike, "getBatchInfo" | "getRootCount">,
  options: { retries: number },
): Pick<MerkleAnchorRegistryLike, "getBatchInfo" | "getRootCount"> {
  function withRetry<T>(fn: () => Promise<T>): Promise<T> {
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
      { retries: options.retries },
    );
  }

  return {
    getBatchInfo: (batchId) => withRetry(() => contract.getBatchInfo(batchId)),
    getRootCount: () => withRetry(() => contract.getRootCount()),
  };
}
