import { task } from "hardhat/config";
import fs from "node:fs/promises";
import path from "node:path";

const CONTRACT_NAME = "MerkleAnchorRegistry";

/**
 * Regenerates `packages/contracts-shared/src/deployments.ts` from the Ignition
 * deployment artifacts under `ignition/deployments/chain-<id>/`.
 *
 * @param integrityRoot - absolute path to `apps/integrity-domain`
 * @returns the chain ids that were written
 */
export async function writeDeploymentsFile(
  integrityRoot: string,
): Promise<string[]> {
  const deploymentsDir = path.join(integrityRoot, "ignition", "deployments");
  const targetFile = path.resolve(
    integrityRoot,
    "../../packages/contracts-shared/src/deployments.ts",
  );

  let dirEntries: string[];
  try {
    dirEntries = await fs.readdir(deploymentsDir);
  } catch {
    return [];
  }

  const addressByChain: Record<string, string> = {};
  for (const entry of dirEntries) {
    const match = /^chain-(\d+)$/.exec(entry);
    if (!match) continue;

    const addressesPath = path.join(
      deploymentsDir,
      entry,
      "deployed_addresses.json",
    );
    let raw: string;
    try {
      raw = await fs.readFile(addressesPath, "utf8");
    } catch {
      continue;
    }

    const addresses = JSON.parse(raw) as Record<string, string>;
    const key = Object.keys(addresses).find((k) =>
      k.endsWith(`#${CONTRACT_NAME}`),
    );

    if (key) addressByChain[match[1]] = addresses[key];
  }

  const chainIds = Object.keys(addressByChain).sort(
    (a, b) => Number(a) - Number(b),
  );

  if (chainIds.length === 0) return [];

  const body = chainIds
    .map((id) => `  "${id}": { ${CONTRACT_NAME}: "${addressByChain[id]}" },`)
    .join("\n");

  const contents = `/**
 * On-chain deployments of the integrity contracts, keyed by chain id.
 *
 * GENERATED from \`apps/integrity-domain/ignition/deployments/\` by
 * \`hardhat export-deployments\` (also run during \`hardhat build\`).
 * Do not edit by hand.
 */
export const deployments: Record<string, { ${CONTRACT_NAME}: string }> = {
${body}
};

export function merkleAnchorRegistryAddress(
  chainId: number,
): string | undefined {
  return deployments[String(chainId)]?.${CONTRACT_NAME};
}
`;

  await fs.writeFile(targetFile, contents);
  return chainIds;
}

export const exportDeploymentsTask = task(
  "export-deployments",
  "Regenerate contracts-shared/src/deployments.ts from Ignition deployment artifacts",
)
  .setInlineAction(async (_args, hre) => {
    const chainIds = await writeDeploymentsFile(hre.config.paths.root);
    console.log(
      chainIds.length === 0
        ? "No Ignition deployments found; deployments.ts left unchanged."
        : `Synced ${CONTRACT_NAME} addresses for chains: ${chainIds.join(", ")}`,
    );
  })
  .build();
