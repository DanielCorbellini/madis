import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Interface, JsonRpcProvider, id, toQuantity } from "ethers";
import { collectRunMetadata, writeResults } from "service-runtime";
import { parseBenchChains, type CrossChainNetwork } from "./cross-chain/config.ts";
import { priceFromFeeHistory, type FeeHistoryResult } from "./cross-chain/fees.ts";
import {
  buildHistoryDays,
  fillForward,
  findBlockAtTime,
  parseCoinGecko,
  parsePtax,
  sampleTimes,
  type HistorySample,
} from "./cross-chain/history.ts";
import { mainnetSnapshot, maskSecrets } from "./cross-chain/measure.ts";
import type { NetworkKind } from "./cross-chain/types.ts";

const RESULTS_DIR = path.join(import.meta.dirname, "results");
const ARBITRUM_ARTIFACT = path.join(
  import.meta.dirname,
  "../../integrity-domain/ignition/deployments/chain-421614/artifacts/MerkleAnchorRegistry#MerkleAnchorRegistry.json",
);
const DEFAULT_DAYS = 183;
// Infura's free tier allows 500 credits/s; most reads cost ~80, so ≤5 calls/s.
const MIN_CALL_GAP_MS = 200;
const RETRIES = 3;
const SLACK_DAYS = 10;
const COINGECKO_IDS = { eth: "ethereum", pol: "polygon-ecosystem-token" } as const;

// A representative anchoring calldata for Arbitrum's L1 part: a random-looking root (incompressible), like a real one.
const ANCHOR_CALLDATA = new Interface([
  "function addMerkleRoot(bytes32 root, uint256 batchSize, uint256 batchId) returns (uint256)",
]).encodeFunctionData("addMerkleRoot", [id("cross-chain-history"), 1000, 1_800_000_000_000]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let nextCallAt = 0;
/** Spaces every RPC call by MIN_CALL_GAP_MS and retries transient failures with backoff. */
async function rpc<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const wait = Math.max(0, nextCallAt - Date.now());
    nextCallAt = Math.max(Date.now(), nextCallAt) + MIN_CALL_GAP_MS;
    await sleep(wait);
    try {
      return await fn();
    } catch (error) {
      if (attempt >= RETRIES) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

function parseCliArgs(argv: string[]): { end: string; days: number } {
  const { values } = parseArgs({
    args: argv,
    options: { end: { type: "string" }, days: { type: "string" }, run: { type: "string" } },
  });
  const days = values.days === undefined ? DEFAULT_DAYS : Number(values.days);
  if (!Number.isInteger(days) || days <= 0) throw new Error("--days must be a positive integer");
  // The window ends where the collection started: --end, else the --run id's date, else today.
  const end = values.end ?? values.run?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error("--end must be YYYY-MM-DD");
  return { end, days };
}

/** Samples one mainnet at every sample time, resuming from (and saving to) `progress`. */
async function sampleNetwork(
  net: CrossChainNetwork,
  times: number[],
  deployBytecode: string,
  progress: Record<string, SavedSample>,
  save: () => Promise<void>,
): Promise<void> {
  const provider = new JsonRpcProvider(net.mainnetRpcUrl, net.mainnetChainId, { staticNetwork: true });
  const timestamps = new Map<number, number>();
  const getTimestamp = async (block: number) => {
    const cached = timestamps.get(block);
    if (cached !== undefined) return cached;
    const header = await rpc(() => provider.getBlock(block));
    if (!header) throw new Error(`block ${block} not found`);
    timestamps.set(block, header.timestamp);
    return header.timestamp;
  };
  try {
    const latest = await rpc(() => provider.getBlockNumber());
    let previousBlock = 0;
    for (const [i, time] of times.entries()) {
      const key = `${net.kind}:${time}`;
      if (progress[key]) continue;
      const block = await findBlockAtTime(getTimestamp, latest, time, previousBlock);
      previousBlock = block;
      let sample: SavedSample;
      if (net.kind === "arbitrum") {
        const anchoring = await rpc(() => mainnetSnapshot("arbitrum", provider, ANCHOR_CALLDATA, false, block));
        const deploy = await rpc(() => mainnetSnapshot("arbitrum", provider, deployBytecode, true, block));
        sample = {
          kind: net.kind, time, gasPriceWei: anchoring.baseFeeWei.toString(), blobBaseFeeWei: null,
          l1GasUsed: String(anchoring.l1GasUsed), l1GasUsedDeploy: String(deploy.l1GasUsed),
        };
      } else {
        const history = (await rpc(() =>
          provider.send("eth_feeHistory", ["0x400", toQuantity(block), [50]]),
        )) as FeeHistoryResult;
        const price = priceFromFeeHistory(history);
        sample = {
          kind: net.kind, time, gasPriceWei: (price.baseFeeWei + price.tipWei).toString(),
          // Blobs are Ethereum's; Polygon reports the field as zero.
          blobBaseFeeWei: net.kind === "ethereum" && price.blobBaseFeeWei !== null ? price.blobBaseFeeWei.toString() : null,
          l1GasUsed: null, l1GasUsedDeploy: null,
        };
      }
      progress[key] = sample;
      await save();
      if (i % 20 === 0 || i === times.length - 1) {
        console.log(`${net.name}: ${i + 1}/${times.length} samples (${new Date(time * 1000).toISOString().slice(0, 16)})`);
      }
    }
  } finally {
    provider.destroy();
  }
}

interface SavedSample {
  kind: NetworkKind;
  time: number;
  gasPriceWei: string;
  blobBaseFeeWei: string | null;
  l1GasUsed: string | null;
  l1GasUsedDeploy: string | null;
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  return rpc(async () => {
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`);
    return response.json();
  });
}

async function fetchCoinGecko(coin: string, from: number, to: number): Promise<Map<string, number>> {
  const key = process.env.COINGECKO_API_KEY;
  const url = `https://api.coingecko.com/api/v3/coins/${coin}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`;
  return parseCoinGecko((await fetchJson(url, key ? { "x-cg-demo-api-key": key } : {})) as { prices: [number, number][] });
}

async function fetchPtax(fromDate: string, toDate: string): Promise<Map<string, number>> {
  const mdy = (d: string) => `${d.slice(5, 7)}-${d.slice(8, 10)}-${d.slice(0, 4)}`;
  const url =
    "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)" +
    `?@dataInicial='${mdy(fromDate)}'&@dataFinalCotacao='${mdy(toDate)}'&$format=json`;
  return parsePtax((await fetchJson(url)) as { value: { cotacaoVenda: number; dataHoraCotacao: string }[] });
}

/**
 * Fetches, once, the mainnet price history the projection needs: 4 samples a
 * day over the window before the collection (fee history on Ethereum and
 * Polygon, NodeInterface on Arbitrum), ETH/POL in USD and the PTAX. Progress
 * is saved after every sample, so an interrupted fetch resumes where it stopped.
 */
async function main(): Promise<void> {
  const startedAt = new Date();
  const { end, days } = parseCliArgs(process.argv.slice(2));
  const raw = process.env.BENCH_CHAINS;
  if (!raw) throw new Error("BENCH_CHAINS environment variable is required (its mainnetRpcUrl entries are used)");
  const nets = parseBenchChains(raw);
  const deployBytecode = (JSON.parse(await readFile(ARBITRUM_ARTIFACT, "utf8")) as { bytecode: string }).bytecode;

  const times = sampleTimes(end, days);
  const dates = [...new Set(times.map((t) => new Date(t * 1000).toISOString().slice(0, 10)))];
  await mkdir(RESULTS_DIR, { recursive: true });
  const progressPath = path.join(RESULTS_DIR, `cross-chain-history-progress-${end}-${days}d.json`);
  let progress: Record<string, SavedSample> = {};
  try {
    progress = JSON.parse(await readFile(progressPath, "utf8"));
    console.log(`Resuming: ${Object.keys(progress).length} samples already fetched`);
  } catch {
    // first run
  }
  const save = () => writeFile(progressPath, JSON.stringify(progress));

  console.log(`History ${dates[0]}..${dates.at(-1)} (${days} days × 4 samples) for ${nets.map((n) => n.name).join(", ")}`);
  for (const net of nets) {
    await sampleNetwork(net, times, deployBytecode, progress, save);
  }

  const first = dates[0];
  const slackStart = new Date(Date.parse(`${first}T00:00:00Z`) - SLACK_DAYS * 86_400_000);
  const from = Math.floor(slackStart.getTime() / 1000);
  const to = Date.parse(`${end}T00:00:00Z`) / 1000;
  const eth = fillForward(dates, await fetchCoinGecko(COINGECKO_IDS.eth, from, to));
  const pol = fillForward(dates, await fetchCoinGecko(COINGECKO_IDS.pol, from, to));
  const ptax = fillForward(dates, await fetchPtax(slackStart.toISOString().slice(0, 10), end));

  const samples: HistorySample[] = Object.values(progress).map((s) => ({
    kind: s.kind,
    time: s.time,
    gasPriceWei: BigInt(s.gasPriceWei),
    blobBaseFeeWei: s.blobBaseFeeWei === null ? null : BigInt(s.blobBaseFeeWei),
    l1GasUsed: s.l1GasUsed === null ? null : BigInt(s.l1GasUsed),
    l1GasUsedDeploy: s.l1GasUsedDeploy === null ? null : BigInt(s.l1GasUsedDeploy),
  })).filter((s) => times.includes(s.time));
  const { days: rows, droppedDays } = buildHistoryDays(samples, dates, { eth: eth.values, pol: pol.values }, ptax.values);

  const { jsonPath } = await writeResults("cross-chain-history", rows, RESULTS_DIR, {
    ...collectRunMetadata({ end, days }, startedAt),
    window: { from: dates[0], to: dates.at(-1) },
    sampleHoursUtc: [0, 6, 12, 18],
    sources: {
      gasPrice: "eth_feeHistory (1,024 blocks, base fee + p50 tip) on Ethereum and Polygon mainnet; NodeInterface.gasEstimateL1Component base fee on Arbitrum One",
      arbitrumL1: "NodeInterface.gasEstimateL1Component at each sample block (anchoring calldata and deploy init code)",
      tokens: "CoinGecko market_chart/range (ethereum, polygon-ecosystem-token), USD, last price of each UTC day",
      ptax: "Banco Central do Brasil, Olinda CotacaoDolarPeriodo, cotacaoVenda, last quote of each day",
    },
    networks: nets.map(({ name, kind, mainnetChainId }) => ({ name, kind, mainnetChainId })),
    droppedDays,
    filled: { eth: eth.filled, pol: pol.filled, ptax: ptax.filled },
  });
  console.log(`Wrote ${jsonPath} (${rows.length} rows, ${droppedDays} dropped days)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(maskSecrets(error instanceof Error ? (error.stack ?? error.message) : String(error), []));
    process.exit(1);
  });
}
