import { splitReceiptGas } from "./fees.ts";

const REGISTRY_FUTURE = "MerkleAnchorRegistry#MerkleAnchorRegistry";

/** The registry's deploy transaction hash, from an Ignition `journal.jsonl`. */
export function readDeployTxHash(journalText: string): string {
  for (const line of journalText.split("\n")) {
    if (line.trim() === "") continue;
    const entry = JSON.parse(line) as { type?: string; futureId?: string; hash?: string };
    if (entry.type === "TRANSACTION_CONFIRM" && entry.futureId === REGISTRY_FUTURE && entry.hash) {
      return entry.hash;
    }
  }
  throw new Error(`journal has no confirmed ${REGISTRY_FUTURE} deploy`);
}

export interface DeployGas {
  txHash: string;
  gasUsed: string;
  l1GasUsed: string;
  l2GasUsed: string;
}

/** The deploy's gas, split like an anchoring's (Arbitrum's `gasUsed` already includes the L1 part). */
export function deployGas(
  txHash: string,
  receipt: { gasUsed: bigint },
  rawReceipt: { gasUsedForL1?: string },
): DeployGas {
  const gas = splitReceiptGas(receipt.gasUsed, rawReceipt);
  return {
    txHash,
    gasUsed: gas.totalGas.toString(),
    l1GasUsed: gas.l1Gas.toString(),
    l2GasUsed: gas.l2Gas.toString(),
  };
}
