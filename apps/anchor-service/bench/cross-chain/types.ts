export type NetworkKind = "ethereum" | "polygon" | "arbitrum";

export interface Tick {
  index: number;
  /** Scheduled time, epoch ms. */
  at: number;
}

export type RowStatus = "finalized" | "included" | "failed" | "skipped-busy" | "missed";

/** One network's anchoring at one tick of the cross-chain run. Wei and gas values are decimal strings. */
export interface CrossChainRow {
  runId: string;
  tick: number;
  scheduledAt: string;
  network: string;
  kind: NetworkKind;
  status: RowStatus;
  warmUp: boolean;
  txHash: string | null;
  blockNumber: number | null;
  sentAt: string | null;
  inclusionMs: number | null;
  finalityMs: number | null;
  gasUsed: string | null;
  l1GasUsed: string | null;
  l2GasUsed: string | null;
  effectiveGasPrice: string | null;
  testnetFeeWei: string | null;
  mainnetBaseFeeWei: string | null;
  mainnetTipWei: string | null;
  mainnetL1GasUsed: string | null;
  sends: number;
  rpcCallsTestnet: number;
  rpcCallsMainnet: number;
  errorMessage: string | null;
  // Makes the all-primitive shape explicit so rows pass as writeResults' Record<string, unknown>.
  [key: string]: string | number | boolean | null;
}
