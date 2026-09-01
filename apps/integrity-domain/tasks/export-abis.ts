import { overrideTask } from "hardhat/config";
import fs from "node:fs/promises";
import path from "node:path";
import { writeDeploymentsFile } from "./export-deployments.js";

/**
 * Extends the default build task to automatically export the compiled contract
 * artifacts to `packages/contracts-shared`
 */
export const buildAndExportTask = overrideTask("build")
  .setInlineAction(async (args, hre, runSuper) => {
    const result = await runSuper(args);

    const sharedSrcDir = path.resolve(
      hre.config.paths.root,
      "../../packages/contracts-shared/src",
    );

    // 1. Raw ABIs
    const abiDir = path.join(sharedSrcDir, "abi");
    await fs.mkdir(abiDir, { recursive: true });

    const fqNames = await hre.artifacts.getAllFullyQualifiedNames();

    for (const fqName of fqNames) {
      const artifact = await hre.artifacts.readArtifact(fqName);
      const filePath = path.join(abiDir, `${artifact.contractName}.json`);
      await fs.writeFile(filePath, JSON.stringify(artifact.abi, null, 2));
    }

    // 2. Generated TypeChain bindings
    const typechainSrcDir = path.join(
      hre.config.paths.root,
      "types",
      "ethers-contracts",
    );
    const typechainDestDir = path.join(sharedSrcDir, "generated");

    await fs.rm(typechainDestDir, { recursive: true, force: true });
    await fs.cp(typechainSrcDir, typechainDestDir, {
      recursive: true,
      filter: (source) => path.basename(source) !== "hardhat.d.ts",
    });

    // 3. Deployment address registry (from Ignition artifacts)
    await writeDeploymentsFile(hre.config.paths.root);

    return result;
  })
  .build();
