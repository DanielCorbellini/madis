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
  /** The deploy transaction's gas limit: the estimate the deploy tool filled in. Absent in runs before it was recorded. */
  testnetGasEstimate?: string;
  /** The deploy's gas estimated on the mainnet, whose gas schedule can differ from the testnet's. */
  mainnetGasEstimate: string | null;
  /** Arbitrum only: the L1 part of that estimate, from NodeInterface. */
  mainnetL1GasUsed: string | null;
}

/**
 * The deploy's testnet gas, split like an anchoring's (Arbitrum's `gasUsed`
 * already includes the L1 part), next to its mainnet estimate.
 */
export function deployGas(
  txHash: string,
  transaction: { gasUsed: bigint; gasLimit: bigint },
  rawReceipt: { gasUsedForL1?: string },
  mainnetGasEstimate: bigint | null,
  mainnetL1GasUsed: bigint | null,
): DeployGas {
  const gas = splitReceiptGas(transaction.gasUsed, rawReceipt);
  return {
    txHash,
    gasUsed: gas.totalGas.toString(),
    l1GasUsed: gas.l1Gas.toString(),
    l2GasUsed: gas.l2Gas.toString(),
    testnetGasEstimate: transaction.gasLimit.toString(),
    mainnetGasEstimate: mainnetGasEstimate === null ? null : mainnetGasEstimate.toString(),
    mainnetL1GasUsed: mainnetL1GasUsed === null ? null : mainnetL1GasUsed.toString(),
  };
}

/**
 * The deploy's mainnet gas, corrected by the estimator's margin measured on
 * the testnet, as for an anchoring: mainnet estimate × gas used ÷ testnet
 * estimate. Without a testnet estimate, the mainnet estimate stands as is.
 */
export function adjustedDeployGas(
  deploy: DeployGas,
  testnetEstimate: number | null,
): { total: number; l2: number } {
  const estimate = Number(deploy.mainnetGasEstimate);
  const total = testnetEstimate === null ? estimate : (estimate * Number(deploy.gasUsed)) / testnetEstimate;
  return { total, l2: total - Number(deploy.mainnetL1GasUsed ?? 0) };
}

/** `--deploy-gas-limits sepolia=4479377,amoy=665129`: the deploy transactions' gas limits, for runs that did not record them. */
export function parseGasLimits(raw: string | undefined): Record<string, number> {
  const limits: Record<string, number> = {};
  for (const pair of raw ? raw.split(",") : []) {
    const [name, value] = pair.split("=");
    if (!name || !/^\d+$/.test(value ?? "")) {
      throw new Error(`--deploy-gas-limits: expected name=gas, got "${pair}"`);
    }
    limits[name] = Number(value);
  }
  return limits;
}
