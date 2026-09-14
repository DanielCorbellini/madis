import { parseUnits } from "ethers";

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
