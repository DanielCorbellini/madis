import { merkleAnchorRegistryAddress } from "contracts-shared";
import type { NetworkKind } from "./types.ts";

/** One testnet of the cross-chain run, paired with the mainnet whose prices project its cost. */
export interface CrossChainNetwork {
  name: string;
  kind: NetworkKind;
  rpcUrl: string;
  chainId: number;
  contractAddress: string;
  privateKey: string;
  mainnetRpcUrl: string;
  mainnetChainId: number;
  finalityPollMs: number;
  /** The registry's runtime bytecode, for mainnet gas estimates; set by the collector from the Ignition artifact. */
  runtimeBytecode?: string;
}

const KINDS: NetworkKind[] = ["ethereum", "polygon", "arbitrum"];

// Polygon PoS finalizes in seconds; Ethereum and Arbitrum take ~15+ minutes.
const DEFAULT_FINALITY_POLL_MS: Record<NetworkKind, number> = {
  ethereum: 30_000,
  polygon: 500,
  arbitrum: 30_000,
};

/**
 * Parses `BENCH_CHAINS`: a JSON array with one entry per testnet. A missing
 * `contractAddress` falls back to the deployment registry for that chain id.
 */
export function parseBenchChains(
  raw: string,
  lookupAddress: (chainId: number) => string | undefined = merkleAnchorRegistryAddress,
): CrossChainNetwork[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("BENCH_CHAINS is not valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("BENCH_CHAINS must be a non-empty JSON array");
  }

  const names = new Set<string>();
  return parsed.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`BENCH_CHAINS[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;

    for (const key of ["name", "rpcUrl", "privateKey", "mainnetRpcUrl"]) {
      if (typeof e[key] !== "string" || e[key] === "") {
        throw new Error(`BENCH_CHAINS[${i}].${key} must be a non-empty string`);
      }
    }
    for (const key of ["chainId", "mainnetChainId"]) {
      if (typeof e[key] !== "number" || !Number.isInteger(e[key])) {
        throw new Error(`BENCH_CHAINS[${i}].${key} must be an integer`);
      }
    }
    if (!KINDS.includes(e.kind as NetworkKind)) {
      throw new Error(`BENCH_CHAINS[${i}].kind must be one of ${KINDS.join(", ")}`);
    }
    const name = e.name as string;
    if (names.has(name)) {
      throw new Error(`BENCH_CHAINS has a duplicate name: ${name}`);
    }
    names.add(name);

    const kind = e.kind as NetworkKind;
    const chainId = e.chainId as number;
    const contractAddress =
      typeof e.contractAddress === "string" && e.contractAddress !== ""
        ? e.contractAddress
        : lookupAddress(chainId);
    if (!contractAddress) {
      throw new Error(
        `BENCH_CHAINS[${i}].contractAddress is missing and chain ${chainId} is not in the deployment registry`,
      );
    }
    const finalityPollMs = e.finalityPollMs ?? DEFAULT_FINALITY_POLL_MS[kind];
    if (typeof finalityPollMs !== "number" || !Number.isInteger(finalityPollMs) || finalityPollMs <= 0) {
      throw new Error(`BENCH_CHAINS[${i}].finalityPollMs must be a positive integer`);
    }

    return {
      name,
      kind,
      rpcUrl: e.rpcUrl as string,
      chainId,
      contractAddress,
      privateKey: e.privateKey as string,
      mainnetRpcUrl: e.mainnetRpcUrl as string,
      mainnetChainId: e.mainnetChainId as number,
      finalityPollMs,
    };
  });
}
