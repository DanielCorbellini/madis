import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { assertContractDeployed, assertNetworkMatches, collectRunMetadata, type RunMetadata } from "service-runtime";
import { JsonRpcProvider } from "ethers";
import { assertWalletIsOwner, createChainClient } from "../src/chain.ts";
import { runTick } from "./cross-chain/collect.ts";
import { parseBenchChains, type CrossChainNetwork } from "./cross-chain/config.ts";
import { deployGas, readDeployTxHash, type DeployGas } from "./cross-chain/deploy.ts";
import { anchorOnce, emptyRow, estimateOnMainnet, mainnetSnapshot, maskSecrets } from "./cross-chain/measure.ts";
import { loadRun, saveRun } from "./cross-chain/run-store.ts";
import { buildSchedule, classifyTicks, isOverdue, resumePlan, runIdFromDate } from "./cross-chain/schedule.ts";
import type { CrossChainRow, Tick } from "./cross-chain/types.ts";

const RESULTS_DIR = path.join(import.meta.dirname, "results");
const DEPLOYMENTS_DIR = path.join(import.meta.dirname, "../../integrity-domain/ignition/deployments");
const GRACE_MS = 5 * 60_000;

interface RunOptions {
  intervalMin: number;
  durationH: number;
}

function parseCliArgs(argv: string[]): RunOptions & { run: string | undefined } {
  const { values } = parseArgs({
    args: argv,
    options: {
      run: { type: "string" },
      "interval-min": { type: "string", default: "45" },
      "duration-h": { type: "string", default: "24" },
    },
  });
  const intervalMin = Number(values["interval-min"]);
  const durationH = Number(values["duration-h"]);
  if (!(intervalMin > 0) || !(durationH > 0)) {
    throw new Error("--interval-min and --duration-h must be positive numbers");
  }
  return { run: values.run, intervalMin, durationH };
}

const ARTIFACT = "artifacts/MerkleAnchorRegistry#MerkleAnchorRegistry.json";

/**
 * Startup checks; loads the registry's bytecode from the network's Ignition
 * artifact (mainnet gas estimates need it, so a missing artifact stops the
 * run); then the deploy's testnet gas and its mainnet estimate (null with a
 * warning when the journal or receipt cannot be read).
 */
async function prepareNetwork(net: CrossChainNetwork): Promise<DeployGas | null> {
  const chain = createChainClient({
    rpcUrl: net.rpcUrl,
    contractAddress: net.contractAddress,
    anchorPrivateKey: net.privateKey,
  });
  const mainnet = new JsonRpcProvider(net.mainnetRpcUrl, net.mainnetChainId, { staticNetwork: true });
  const deploymentDir = path.join(DEPLOYMENTS_DIR, `chain-${net.chainId}`);
  try {
    await assertNetworkMatches(chain.provider, net.chainId);
    await assertNetworkMatches(mainnet, net.mainnetChainId);
    await assertContractDeployed(chain.provider, net.contractAddress);
    await assertWalletIsOwner(chain.contract, chain.wallet.address);

    const artifact = JSON.parse(await readFile(path.join(deploymentDir, ARTIFACT), "utf8")) as {
      bytecode: string;
      deployedBytecode: string;
    };
    net.runtimeBytecode = artifact.deployedBytecode;

    try {
      const journal = await readFile(path.join(deploymentDir, "journal.jsonl"), "utf8");
      const txHash = readDeployTxHash(journal);
      const receipt = await chain.provider.getTransactionReceipt(txHash);
      if (!receipt) throw new Error(`deploy transaction ${txHash} not found on chain`);
      const raw = (await chain.provider.send("eth_getTransactionReceipt", [txHash])) as { gasUsedForL1?: string };
      const estimate = await estimateOnMainnet(mainnet, chain.wallet.address, undefined, artifact.bytecode);
      const l1 = net.kind === "arbitrum"
        ? (await mainnetSnapshot(net.kind, mainnet, artifact.bytecode, true)).l1GasUsed
        : null;
      return deployGas(txHash, receipt, raw, estimate, l1);
    } catch (error) {
      console.warn(`${net.name}: deploy cost unavailable (${maskSecrets(String(error), [net.privateKey])})`);
      return null;
    }
  } finally {
    chain.provider.destroy();
    mainnet.destroy();
  }
}

/**
 * The cross-chain collection: one anchoring per network every `intervalMin`
 * for `durationH`, all networks in the same tick. Every row is saved as soon
 * as it settles; `--run <runId>` resumes an interrupted run inside its
 * original window, recording the ticks it missed.
 */
async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const raw = process.env.BENCH_CHAINS;
  if (!raw) throw new Error("BENCH_CHAINS environment variable is required");
  const nets = parseBenchChains(raw);

  let runId: string;
  let options: RunOptions;
  let windowStart: number;
  let startedAt: Date;
  let rows: CrossChainRow[];
  if (cli.run) {
    runId = cli.run;
    const loaded = await loadRun(RESULTS_DIR, runId);
    if (!loaded) throw new Error(`no run cross-chain-${runId} in ${RESULTS_DIR}`);
    const saved = JSON.parse(
      await readFile(path.join(RESULTS_DIR, `cross-chain-${runId}.meta.json`), "utf8"),
    ) as RunMetadata;
    const { intervalMin, durationH } = saved.options as unknown as RunOptions;
    options = { intervalMin, durationH };
    windowStart = Date.parse(saved.windowStart as string);
    startedAt = new Date(saved.startedAt);
    rows = loaded;
    console.log(`Resuming run ${runId} (${rows.length} rows so far)`);
  } else {
    startedAt = new Date();
    runId = runIdFromDate(startedAt);
    options = { intervalMin: cli.intervalMin, durationH: cli.durationH };
    windowStart = startedAt.getTime();
    rows = [];
  }

  const deploys: Record<string, DeployGas | null> = {};
  for (const net of nets) {
    deploys[net.name] = await prepareNetwork(net);
  }

  const durationMs = options.durationH * 3_600_000;
  const schedule = buildSchedule(windowStart, options.intervalMin * 60_000, durationMs);
  const meta = (): RunMetadata => ({
    ...collectRunMetadata(
      {
        ...options,
        networks: nets.map(({ name, kind, chainId, mainnetChainId, contractAddress }) => ({
          name, kind, chainId, mainnetChainId, contractAddress,
        })),
      },
      startedAt,
    ),
    deploys,
    windowStart: new Date(windowStart).toISOString(),
    windowEnd: new Date(windowStart + durationMs).toISOString(),
  });

  // Rows settle concurrently; saves are chained so two never write the files at once.
  // A row arrives twice (provisional at inclusion, final after finality): the later replaces the earlier.
  let saving = Promise.resolve();
  const record = (row: CrossChainRow) => {
    const at = rows.findIndex((r) => r.tick === row.tick && r.network === row.network);
    if (at >= 0) rows[at] = row;
    else rows.push(row);
    console.log(`tick ${row.tick} ${row.network}: ${row.status}${row.errorMessage ? ` (${row.errorMessage})` : ""}`);
    saving = saving.then(() => saveRun(RESULTS_DIR, runId, rows, meta()));
  };

  const missed = (tick: Tick, network: CrossChainNetwork) => record(emptyRow(network, tick, runId, "missed"));
  let upcoming: Tick[];
  if (cli.run) {
    const plan = resumePlan(schedule, rows, nets.map((net) => net.name), Date.now());
    for (const pair of plan.missed) {
      const net = nets.find((n) => n.name === pair.network);
      if (net) missed(schedule[pair.tick], net);
    }
    upcoming = plan.upcoming;
  } else {
    upcoming = classifyTicks(schedule, new Set(), Date.now(), GRACE_MS).upcoming;
  }
  await saving;
  console.log(`Run ${runId}: ${upcoming.length} tick(s) to go, every ${options.intervalMin} min. Results in ${RESULTS_DIR}`);

  const busy = new Map<string, boolean>();
  const anchor = (net: CrossChainNetwork, tick: Tick, onIncluded: (provisional?: CrossChainRow) => void) =>
    anchorOnce(net, tick, runId, `${runId}-${tick.index}-${net.name}`, onIncluded);
  const ticks: Promise<void>[] = [];
  for (const tick of upcoming) {
    const delay = tick.at - Date.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    // After a suspend the timer fires late: the tick's moment has passed, so it is missed, not run.
    if (isOverdue(tick, Date.now(), GRACE_MS)) {
      for (const net of nets) missed(tick, net);
      continue;
    }
    ticks.push(runTick(nets, tick, runId, busy, anchor, record));
  }
  await Promise.all(ticks);
  await saving;
  console.log(`Run ${runId} finished: ${rows.length} rows`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  console.log(
    'Tip: run under systemd-inhibit --what=sleep:idle:handle-lid-switch --why="cross-chain bench" so the machine does not suspend.',
  );
  main().catch((error) => {
    console.error(maskSecrets(error instanceof Error ? (error.stack ?? error.message) : String(error), []));
    process.exit(1);
  });
}
