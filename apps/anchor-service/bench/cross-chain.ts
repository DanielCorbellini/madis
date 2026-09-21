import { computeLeafHash } from "crypto-utils";
import { formatEther } from "ethers";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  assertContractDeployed,
  assertNetworkMatches,
  assertWalletIsOwner,
  createChainClient,
} from "../src/chain.ts";
import { submitRoot } from "../src/chain-submit.ts";
import { buildAnchorTree, type LeafEntry } from "../src/tree.ts";
import { writeResults } from "./report.ts";

const DEFAULT_COUNT = 1000;
const SUBMIT_RETRIES = 2;
const SUBMIT_MAX_FEE_GWEI = 100;
const CONFIRMATION_TIMEOUT_MS = 300_000;

export interface BenchChainConfig {
  name: string;
  rpcUrl: string;
  chainId: number;
  contractAddress: string;
  privateKey: string;
  confirmations: number;
}

/**
 * Parses and validates `BENCH_CHAINS`: a JSON array of per-network configs
 * (one entry per testnet to compare — Sepolia + Amoy per the design doc,
 * §14).
 */
export function parseBenchChains(raw: string): BenchChainConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("BENCH_CHAINS is not valid JSON");
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("BENCH_CHAINS must be a non-empty JSON array");
  }

  return parsed.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`BENCH_CHAINS[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;

    for (const key of ["name", "rpcUrl", "contractAddress", "privateKey"]) {
      if (typeof e[key] !== "string" || e[key] === "") {
        throw new Error(`BENCH_CHAINS[${i}].${key} must be a non-empty string`);
      }
    }
    for (const key of ["chainId", "confirmations"]) {
      if (typeof e[key] !== "number" || !Number.isInteger(e[key])) {
        throw new Error(`BENCH_CHAINS[${i}].${key} must be an integer`);
      }
    }

    return {
      name: e.name as string,
      rpcUrl: e.rpcUrl as string,
      chainId: e.chainId as number,
      contractAddress: e.contractAddress as string,
      privateKey: e.privateKey as string,
      confirmations: e.confirmations as number,
    };
  });
}

function parseCliArgs(argv: string[]): { count: number; fresh: boolean } {
  const { values } = parseArgs({
    args: argv,
    options: {
      count: { type: "string" },
      fresh: { type: "boolean", default: false },
    },
  });

  const count = values.count === undefined ? DEFAULT_COUNT : Number(values.count);
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("--count must be a positive integer");
  }

  return { count, fresh: values.fresh === true };
}

/**
 * Builds a synthetic dataset of `count` leaves and returns its Merkle
 * root/size — no database involved. This experiment only measures
 * submission cost/latency per network, so the underlying data's realism
 * doesn't matter, only that the root is a real Merkle root computed
 * through the same crypto-utils/tree.ts path production uses. `salt` makes
 * a `--fresh` run's leaves (and therefore its root) differ from a previous
 * run's, avoiding `RootAlreadyExists` on every network at once.
 */
const SYNTHETIC_CREATED_AT = new Date("2026-01-01T00:00:00.000Z");

function buildDataset(count: number, salt: string): { root: string; size: number } {
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

interface CrossChainRow {
  runId: string;
  chain: string;
  status: "confirmed" | "already-on-chain" | "failed";
  txHash: string | null;
  gasUsed: string | null;
  effectiveGasPrice: string | null;
  feeWei: string | null;
  feeNative: string | null;
  submitToMinedMs: number | null;
  blockNumber: number | null;
  errorMessage: string | null;
  // Every field above is a string, number, or null — this index signature
  // just makes that explicit to TypeScript so CrossChainRow[] can be passed
  // to writeResults's Array<Record<string, unknown>> parameter without a cast.
  [key: string]: string | number | null;
}

/**
 * Submits the given root to one chain and measures its cost/latency.
 * Reuses `chain-submit.ts`'s `submitRoot` for the actual send (the real
 * production fee-bump/revert path), but reads the confirmed receipt
 * directly off `chain.provider` (the real `JsonRpcProvider`, not the
 * narrower `ChainProvider` interface `chain-confirm.ts` uses) specifically
 * to get `gasUsed`/`gasPrice`. Never throws: every failure is reported as a
 * `"failed"` row instead.
 */
async function benchmarkChain(
  chainConfig: BenchChainConfig,
  root: string,
  size: number,
  runId: string,
): Promise<CrossChainRow> {
  const base = {
    runId,
    chain: chainConfig.name,
    txHash: null,
    gasUsed: null,
    effectiveGasPrice: null,
    feeWei: null,
    feeNative: null,
    submitToMinedMs: null,
    blockNumber: null,
    errorMessage: null,
  } as const;

  const chain = createChainClient({
    rpcUrl: chainConfig.rpcUrl,
    contractAddress: chainConfig.contractAddress,
    anchorPrivateKey: chainConfig.privateKey,
  });

  try {
    await assertNetworkMatches(chain.provider, chainConfig.chainId);
    await assertContractDeployed(chain.provider, chainConfig.contractAddress);
    await assertWalletIsOwner(chain.contract, chain.wallet.address);

    const submitStart = performance.now();
    const result = await submitRoot(chain.contract, chain.provider, root, size, {
      retries: SUBMIT_RETRIES,
      maxFeeGwei: SUBMIT_MAX_FEE_GWEI,
    });

    if (result.status === "already-on-chain") {
      console.log(`${chainConfig.name}: already anchored, skipped`);
      return { ...base, status: "already-on-chain" };
    }

    const receipt = await chain.provider.waitForTransaction(
      result.tx.hash,
      chainConfig.confirmations,
      CONFIRMATION_TIMEOUT_MS,
    );
    const submitToMinedMs = performance.now() - submitStart;

    if (!receipt || receipt.status === 0) {
      return {
        ...base,
        status: "failed",
        txHash: result.tx.hash,
        errorMessage: receipt
          ? "transaction reverted"
          : "no receipt after waiting for confirmations",
      };
    }

    const feeWei = receipt.gasUsed * receipt.gasPrice;

    return {
      ...base,
      status: "confirmed",
      txHash: result.tx.hash,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.gasPrice.toString(),
      feeWei: feeWei.toString(),
      feeNative: formatEther(feeWei),
      submitToMinedMs: Math.round(submitToMinedMs),
      blockNumber: receipt.blockNumber,
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    chain.provider.destroy();
  }
}

async function main(): Promise<void> {
  const { count, fresh } = parseCliArgs(process.argv.slice(2));

  const benchChainsRaw = process.env.BENCH_CHAINS;
  if (!benchChainsRaw) {
    throw new Error("BENCH_CHAINS environment variable is required");
  }
  const chains = parseBenchChains(benchChainsRaw);

  const salt = fresh ? `${Date.now()}` : "fixed";
  const { root, size } = buildDataset(count, salt);
  const runId = new Date().toISOString();

  console.log(`Submitting root ${root} (size ${size}) to ${chains.length} chain(s)...`);

  const rows = await Promise.all(
    chains.map((chainConfig) => benchmarkChain(chainConfig, root, size, runId)),
  );

  for (const row of rows) {
    console.log(row);
  }

  const { jsonPath, csvPath } = await writeResults("cross-chain", rows);
  console.log(`Wrote ${jsonPath} and ${csvPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
