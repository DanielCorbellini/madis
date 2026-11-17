/**
 * Splits an anchoring's gas into its L1 data and L2 execution parts.
 * On Arbitrum, the receipt's `gasUsed` already includes `gasUsedForL1`
 * (the L1 data charge re-expressed in L2 gas), so the fee is
 * `gasUsed × effectiveGasPrice` and the L2 part is the difference. Chains
 * without the field are all L2 gas.
 */
export function splitReceiptGas(
  gasUsed: bigint,
  rawReceipt: { gasUsedForL1?: string },
): { totalGas: bigint; l1Gas: bigint; l2Gas: bigint } {
  const l1Gas = rawReceipt.gasUsedForL1 ? BigInt(rawReceipt.gasUsedForL1) : 0n;
  return { totalGas: gasUsed, l1Gas, l2Gas: gasUsed - l1Gas };
}

export interface FeeHistoryResult {
  baseFeePerGas: string[];
  reward?: string[][];
  baseFeePerBlobGas?: string[];
}

function meanWei(values: string[]): bigint {
  return values.reduce((sum, v) => sum + BigInt(v), 0n) / BigInt(values.length);
}

/**
 * Mean base fee, p50 priority fee and blob base fee over an `eth_feeHistory`
 * window requested with reward percentiles `[50]`. The per-block arrays carry
 * one extra trailing entry for the next block, which is ignored.
 */
export function priceFromFeeHistory(fh: FeeHistoryResult): {
  baseFeeWei: bigint;
  tipWei: bigint;
  blobBaseFeeWei: bigint | null;
} {
  const blocks = fh.baseFeePerGas.length - 1;
  const tips = (fh.reward ?? []).map((row) => row[0]);
  const blob = fh.baseFeePerBlobGas?.slice(0, blocks) ?? [];
  return {
    baseFeeWei: meanWei(fh.baseFeePerGas.slice(0, blocks)),
    tipWei: tips.length > 0 ? meanWei(tips) : 0n,
    blobBaseFeeWei: blob.length > 0 ? meanWei(blob) : null,
  };
}
