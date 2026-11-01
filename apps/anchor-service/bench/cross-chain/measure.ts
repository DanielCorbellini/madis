import { computeLeafHash } from "crypto-utils";
import { Interface, JsonRpcProvider, toBeHex, zeroPadValue } from "ethers";
import { createChainClient } from "../../src/chain.ts";
import { submitRoot } from "../../src/chain-submit.ts";
import { buildAnchorTree, type LeafEntry } from "../../src/tree.ts";
import type { CrossChainNetwork } from "./config.ts";
import { priceFromFeeHistory, splitReceiptGas, type FeeHistoryResult } from "./fees.ts";
import type { CrossChainRow, NetworkKind, Tick } from "./types.ts";

const DATASET_SIZE = 1000;
const SUBMIT_OPTIONS = { retries: 2, maxFeeGwei: 100 };
// The polling interval is the inclusion measurement's resolution. Polygon and
// Arbitrum include in seconds, so they poll fast; Ethereum's 12 s blocks
// allow 1 s, which keeps the three networks under Infura's per-second limit.
const INCLUSION_POLL_MS: Record<NetworkKind, number> = {
  ethereum: 1_000,
  polygon: 250,
  arbitrum: 250,
};
const INCLUSION_TIMEOUT_MS = 10 * 60_000;
// Arbitrum Sepolia's batch posting can lag well behind Ethereum's finality.
const FINALITY_TIMEOUT_MS = 3 * 3_600_000;
const NODE_INTERFACE = "0x00000000000000000000000000000000000000C8";
const ANY_ADDRESS = "0x000000000000000000000000000000000000dEaD";
// Where the registry is simulated on mainnet (it is not deployed there).
const SIMULATED_REGISTRY = "0x000000000000000000000000000000000000bEEF";

const registryAbi = new Interface([
  "function addMerkleRoot(bytes32 root, uint256 batchSize, uint256 batchId) returns (uint256)",
]);
const nodeInterfaceAbi = new Interface([
  "function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)",
]);

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Counts JSON-RPC requests a provider sends, through ethers' `"debug"` events. */
export function countRpcCalls(provider: { on(event: "debug", listener: (info: unknown) => void): unknown }): {
  total(): number;
  method(name: string): number;
} {
  const byMethod = new Map<string, number>();
  provider.on("debug", (info) => {
    const event = info as { action?: string; payload?: { method: string } | { method: string }[] };
    if (event.action !== "sendRpcPayload" || !event.payload) return;
    for (const { method } of [event.payload].flat()) {
      byMethod.set(method, (byMethod.get(method) ?? 0) + 1);
    }
  });
  return {
    total: () => [...byMethod.values()].reduce((sum, n) => sum + n, 0),
    method: (name) => byMethod.get(name) ?? 0,
  };
}

/**
 * Polls until the chain's finalized block reaches `blockNumber`. Returns the
 * clock reading at that moment, or `null` once `timeoutMs` has passed.
 */
export async function waitFinalized(
  getFinalizedNumber: () => Promise<number>,
  blockNumber: number,
  pollMs: number,
  timeoutMs: number,
  clock: Clock = realClock,
): Promise<number | null> {
  const start = clock.now();
  for (;;) {
    if ((await getFinalizedNumber()) >= blockNumber) return clock.now();
    if (clock.now() - start >= timeoutMs) return null;
    await clock.sleep(pollMs);
  }
}

/**
 * The mainnet price an anchoring would pay right now. Ethereum and Polygon:
 * mean base fee and p50 tip of the last 20 blocks. Arbitrum: NodeInterface's
 * L2 base fee (no tip market in practice) plus the L1 data charge for this
 * calldata (or creation code), in L2 gas units. `blockTag` (Arbitrum only)
 * reads a past block, which needs an archive RPC.
 */
export async function mainnetSnapshot(
  kind: NetworkKind,
  mainnet: {
    send(method: string, params: unknown[]): Promise<unknown>;
    call(tx: { to: string; data: string; blockTag?: number }): Promise<string>;
  },
  calldata: string,
  contractCreation = false,
  blockTag?: number,
): Promise<{ baseFeeWei: bigint; tipWei: bigint; l1GasUsed: bigint | null }> {
  if (kind === "arbitrum") {
    const result = await mainnet.call({
      ...(blockTag !== undefined && { blockTag }),
      to: NODE_INTERFACE,
      data: nodeInterfaceAbi.encodeFunctionData("gasEstimateL1Component", [ANY_ADDRESS, contractCreation, calldata]),
    });
    const [gasEstimateForL1, baseFee] = nodeInterfaceAbi.decodeFunctionResult("gasEstimateL1Component", result);
    return { baseFeeWei: baseFee, tipWei: 0n, l1GasUsed: gasEstimateForL1 };
  }
  const history = (await mainnet.send("eth_feeHistory", ["0x14", "latest", [50]])) as FeeHistoryResult;
  const { baseFeeWei, tipWei } = priceFromFeeHistory(history);
  return { baseFeeWei, tipWei, l1GasUsed: null };
}

export type StateOverride = Record<string, { code: string; stateDiff: Record<string, string> }>;

/**
 * Simulates the registry at `contractAddress` for `eth_estimateGas`: its
 * runtime code, `Ownable._owner` (slot 0) and `merkleRoots.length` (slot 1).
 * The root count matters: the first root initializes the length slot and
 * costs more than the rest.
 */
export function stateOverride(
  contractAddress: string,
  runtimeBytecode: string,
  owner: string,
  rootCount: number,
): StateOverride {
  return {
    [contractAddress]: {
      code: runtimeBytecode,
      stateDiff: {
        [zeroPadValue("0x00", 32)]: zeroPadValue(owner.toLowerCase(), 32),
        [zeroPadValue("0x01", 32)]: zeroPadValue(toBeHex(rootCount), 32),
      },
    },
  };
}

/**
 * The gas a call (or, without `to`, a contract creation) would use on the
 * mainnet, whose gas schedule can differ from its testnet's.
 */
export async function estimateOnMainnet(
  mainnet: { send(method: string, params: unknown[]): Promise<unknown> },
  from: string,
  to: string | undefined,
  data: string,
  override?: StateOverride,
): Promise<bigint> {
  const tx = to === undefined ? { from, data } : { from, to, data };
  const params: unknown[] = override ? [tx, "latest", override] : [tx, "latest"];
  return BigInt((await mainnet.send("eth_estimateGas", params)) as string);
}

/** Hides RPC keys embedded in URLs (`/v3/<key>`) and any of the given secrets. */
export function maskSecrets(text: string, secrets: string[]): string {
  let masked = text.replace(/\/v3\/[0-9A-Za-z]+/g, "/v3/***");
  for (const secret of secrets) {
    if (secret) masked = masked.split(secret).join("***");
  }
  return masked;
}

const SYNTHETIC_CREATED_AT = new Date("2026-01-01T00:00:00.000Z");

/**
 * A real Merkle root over a synthetic dataset, built through production's
 * `buildAnchorTree`. The salt makes every anchoring's root unique.
 */
export function syntheticRoot(count: number, salt: string): { root: string; size: number } {
  const leaves: LeafEntry[] = [];
  for (let i = 0; i < count; i++) {
    leaves.push({
      recordId: i,
      leaf: computeLeafHash({
        id: i,
        entityId: i,
        recordType: "prescription",
        data: { i, salt },
        version: 1,
        isDeleted: false,
        replaces: null,
        clientAddress: `0x${"1".repeat(40)}`,
        signature: "0xbench",
        createdAt: SYNTHETIC_CREATED_AT,
      }),
    });
  }
  const tree = buildAnchorTree(leaves);
  return { root: tree.root, size: tree.entries.length };
}

/** A row with nothing measured yet; `anchorOnce` fills it, and skipped or missed ticks keep it as is. */
export function emptyRow(
  net: CrossChainNetwork,
  tick: Tick,
  runId: string,
  status: CrossChainRow["status"] = "failed",
): CrossChainRow {
  return {
    runId,
    tick: tick.index,
    scheduledAt: new Date(tick.at).toISOString(),
    network: net.name,
    kind: net.kind,
    status,
    warmUp: false,
    txHash: null,
    blockNumber: null,
    sentAt: null,
    inclusionMs: null,
    finalityMs: null,
    gasUsed: null,
    l1GasUsed: null,
    l2GasUsed: null,
    effectiveGasPrice: null,
    testnetFeeWei: null,
    testnetGasEstimate: null,
    mainnetGasEstimate: null,
    mainnetBaseFeeWei: null,
    mainnetTipWei: null,
    mainnetL1GasUsed: null,
    sends: 0,
    rpcCallsTestnet: 0,
    rpcCallsMainnet: 0,
    errorMessage: null,
  };
}

/**
 * Anchors one synthetic root on one network and measures it: inclusion (one
 * confirmation), gas, the mainnet price at that moment, and finality. Uses
 * its own providers so overlapping anchorings never mix RPC counts. Never
 * throws: errors become a `failed` row (or an error note on an included one).
 * `onIncluded` fires once, when the transaction is included or the attempt
 * ends without inclusion.
 */
export async function anchorOnce(
  net: CrossChainNetwork,
  tick: Tick,
  runId: string,
  salt: string,
  onIncluded: () => void = () => {},
): Promise<CrossChainRow> {
  const row = emptyRow(net, tick, runId);
  const chain = createChainClient({
    rpcUrl: net.rpcUrl,
    contractAddress: net.contractAddress,
    anchorPrivateKey: net.privateKey,
    pollingIntervalMs: INCLUSION_POLL_MS[net.kind],
  });
  const mainnet = new JsonRpcProvider(net.mainnetRpcUrl, net.mainnetChainId, { staticNetwork: true });
  const testnetCalls = countRpcCalls(chain.provider);
  const mainnetCalls = countRpcCalls(mainnet);
  let included = false;
  const markIncluded = () => {
    if (!included) {
      included = true;
      onIncluded();
    }
  };
  const mask = (error: unknown) =>
    maskSecrets(error instanceof Error ? error.message : String(error), [net.privateKey]);
  // Problems after the send never fail the row; they are kept as notes.
  const note = (message: string) => {
    row.errorMessage = row.errorMessage ? `${row.errorMessage}; ${message}` : message;
  };

  try {
    const rootCount = await chain.contract.getRootCount();
    row.warmUp = rootCount === 0;
    const { root, size } = syntheticRoot(DATASET_SIZE, salt);
    const batchId = tick.at;
    const calldata = registryAbi.encodeFunctionData("addMerkleRoot", [root, size, batchId]);
    try {
      const estimate = await chain.provider.estimateGas({ from: chain.wallet.address, to: net.contractAddress, data: calldata });
      row.testnetGasEstimate = estimate.toString();
    } catch (error) {
      note(`testnet estimate failed: ${mask(error)}`);
    }

    row.sentAt = new Date().toISOString();
    const start = performance.now();
    const result = await submitRoot(chain.contract, chain.provider, root, size, batchId, SUBMIT_OPTIONS);
    if (result.status === "already-on-chain") {
      row.errorMessage = "root already on chain";
      return row;
    }
    row.txHash = result.tx.hash;

    const receipt = await chain.provider.waitForTransaction(result.tx.hash, 1, INCLUSION_TIMEOUT_MS);
    row.inclusionMs = Math.round(performance.now() - start);
    markIncluded();
    if (!receipt || receipt.status === 0) {
      row.errorMessage = receipt ? "transaction reverted" : "not included before the timeout";
      return row;
    }
    row.status = "included";
    row.blockNumber = receipt.blockNumber;

    const raw = (await chain.provider.send("eth_getTransactionReceipt", [result.tx.hash])) as {
      gasUsedForL1?: string;
    };
    const gas = splitReceiptGas(receipt.gasUsed, raw);
    row.gasUsed = gas.totalGas.toString();
    row.l1GasUsed = gas.l1Gas.toString();
    row.l2GasUsed = gas.l2Gas.toString();
    row.effectiveGasPrice = receipt.gasPrice.toString();
    row.testnetFeeWei = (gas.totalGas * receipt.gasPrice).toString();

    if (net.runtimeBytecode) {
      try {
        const override = stateOverride(SIMULATED_REGISTRY, net.runtimeBytecode, chain.wallet.address, rootCount);
        const estimate = await estimateOnMainnet(mainnet, chain.wallet.address, SIMULATED_REGISTRY, calldata, override);
        row.mainnetGasEstimate = estimate.toString();
      } catch (error) {
        note(`mainnet estimate failed: ${mask(error)}`);
      }
    }

    try {
      const snap = await mainnetSnapshot(net.kind, mainnet, calldata);
      row.mainnetBaseFeeWei = snap.baseFeeWei.toString();
      row.mainnetTipWei = snap.tipWei.toString();
      row.mainnetL1GasUsed = snap.l1GasUsed === null ? null : snap.l1GasUsed.toString();
    } catch (error) {
      note(`mainnet snapshot failed: ${mask(error)}`);
    }

    // A transient RPC error while waiting counts as "not finalized yet".
    const finalizedNumber = async () => {
      try {
        return (await chain.provider.getBlock("finalized"))?.number ?? -1;
      } catch {
        return -1;
      }
    };
    const finalizedAt = await waitFinalized(finalizedNumber, receipt.blockNumber, net.finalityPollMs, FINALITY_TIMEOUT_MS);
    if (finalizedAt !== null) {
      row.status = "finalized";
      row.finalityMs = Math.round(finalizedAt - start);
    }
    return row;
  } catch (error) {
    note(mask(error));
    return row;
  } finally {
    markIncluded();
    row.sends = testnetCalls.method("eth_sendRawTransaction");
    row.rpcCallsTestnet = testnetCalls.total();
    row.rpcCallsMainnet = mainnetCalls.total();
    chain.provider.destroy();
    mainnet.destroy();
  }
}
