import {
  MerkleAnchorRegistry__factory,
  type MerkleAnchorRegistryLike,
} from "contracts-shared";
import type { ContractTransactionResponse } from "ethers";
import { Interface, isError, parseUnits } from "ethers";
import pRetry, { AbortError } from "p-retry";
import type { ChainProvider } from "./chain.ts";

/**
 * Used only as a fallback decoder in `decodeRevertName`
 */
const contractInterface = new Interface(MerkleAnchorRegistry__factory.abi);

/** The only field this module reads off a sent transaction — mirrors the
 * real ethers type instead of hand-rolling it, so it can't drift. */
export type TransactionLike = Pick<ContractTransactionResponse, "hash">;

export class PoisonBatchError extends Error {
  revertName: string;
  constructor(revertName: string) {
    super(`contract call reverted with ${revertName} — not retryable`);
    this.name = "PoisonBatchError";
    this.revertName = revertName;
  }
}

class AlreadyOnChainSignal extends Error {}

export type SubmitResult =
  | { status: "sent"; tx: TransactionLike }
  | { status: "already-on-chain" };

export interface SubmitRootOptions {
  retries: number;
  maxFeeGwei: number;
}

/**
 * Computes bumped gas fees by applying the multiplier to the provided fee data and capping them at maxFeeGwei.
 * @param feeData - The current fee data on the network.
 * @param multiplier - The multiplier for bumping the fees.
 * @param maxFeeGwei - The maximum fee in gwei that the user is willing to pay.
 * @returns An object containing the bumped maxFeePerGas and maxPriorityFeePerGas.
 */
export function computeBumpedFees(
  feeData: { maxFeePerGas: bigint | null; maxPriorityFeePerGas: bigint | null },
  multiplier: number,
  maxFeeGwei: number,
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const oneGwei = parseUnits("1", "gwei");
  const cap = parseUnits(String(maxFeeGwei), "gwei");

  const bump = (value: bigint | null) => {
    const base = value ?? oneGwei;
    const bumped = (base * BigInt(Math.round(multiplier * 1000))) / 1000n;
    return bumped > cap ? cap : bumped;
  };

  return {
    maxFeePerGas: bump(feeData.maxFeePerGas),
    maxPriorityFeePerGas: bump(feeData.maxPriorityFeePerGas),
  };
}

/**
 * Decodes the name of a revert error if it's a CALL_EXCEPTION.
 */
export function decodeRevertName(error: unknown): string | null {
  if (!isError(error, "CALL_EXCEPTION")) {
    return null;
  }

  if (error.revert?.name) {
    return error.revert.name;
  }

  if (error.data) {
    try {
      return contractInterface.parseError(error.data)?.name ?? null;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Sends `addMerkleRoot(root, size)`, retrying failures (network,
 * timeout, RPC unreachable/rate-limited).
 *
 * In the first call, the gas fee is not bumped. Every retry, regardless
 * of what caused the previous attempt to fail, carries a fee bump, escalating
 * from the second attempt onward and capped at `maxFeeGwei`.
 *
 * A decoded contract revert is deterministic: retrying with the same
 * root/size would fail identically, so those abort immediately instead of
 * retrying. `RootAlreadyExists` resolves as success, `OwnableUnauthorizedAccount`
 * throws `PoisonBatchError`, any other named revert throws as a plain
 * non-retryable failure.
 */
export async function submitRoot(
  contract: Pick<MerkleAnchorRegistryLike, "addMerkleRoot">,
  provider: Pick<ChainProvider, "getFeeData">,
  root: string,
  size: number,
  batchId: number,
  options: SubmitRootOptions,
): Promise<SubmitResult> {
  let attempt = 0;

  const tx = await pRetry(
    async () => {
      try {
        const overrides =
          attempt === 0
            ? undefined
            : computeBumpedFees(
                await provider.getFeeData(),
                1 + attempt * 0.25,
                options.maxFeeGwei,
              );

        return await contract.addMerkleRoot(root, size, batchId, overrides);
      } catch (error) {
        const revertName = decodeRevertName(error);

        if (revertName === "RootAlreadyExists") {
          throw new AbortError(new AlreadyOnChainSignal());
        }

        if (revertName === "OwnableUnauthorizedAccount") {
          throw new AbortError(new PoisonBatchError(revertName));
        }

        if (revertName !== null) {
          throw new AbortError(
            error instanceof Error ? error : new Error(String(error)),
          );
        }

        throw error;
      }
    },
    {
      retries: options.retries,
      onFailedAttempt: () => {
        attempt++;
      },
    },
  ).catch((error) => {
    if (error instanceof AlreadyOnChainSignal) return null;
    throw error;
  });

  if (tx === null) {
    return { status: "already-on-chain" };
  }

  return { status: "sent", tx };
}

/**
 * Replaces a transaction that did send successfully but is stuck
 * by resubmitting `addMerkleRoot` with the same
 * nonce and a bumped fee, so the network treats it as a replacement instead
 * of a new pending transaction.
 */
export async function resendTransaction(
  contract: Pick<MerkleAnchorRegistryLike, "addMerkleRoot">,
  provider: Pick<ChainProvider, "getTransaction" | "getFeeData">,
  root: string,
  size: number,
  batchId: number,
  oldTxHash: string,
  maxFeeGwei: number,
): Promise<TransactionLike> {
  const oldTx = await provider.getTransaction(oldTxHash);

  if (!oldTx) {
    throw new Error(
      `stuck transaction ${oldTxHash} was not found — cannot determine its nonce to replace it`,
    );
  }

  const bumped = computeBumpedFees(
    await provider.getFeeData(),
    1.25,
    maxFeeGwei,
  );

  return contract.addMerkleRoot(root, size, batchId, {
    ...bumped,
    nonce: oldTx.nonce,
  });
}
