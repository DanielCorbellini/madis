import fs from "node:fs/promises";
import path from "node:path";
import { overrideTask } from "hardhat/config";

/**
 * Extends the default build task to automatically export ABI to shared package
 */
export const buildAndExportTask = overrideTask("build")
  .setInlineAction(async (args, hre, runSuper) => {
    const result = await runSuper(args);

    const outDir = path.resolve(
      hre.config.paths.root,
      "../../packages/contracts-shared/src/abi",
    );
    await fs.mkdir(outDir, { recursive: true });

    const fqNames = await hre.artifacts.getAllFullyQualifiedNames();

    for (const fqName of fqNames) {
      const artifact = await hre.artifacts.readArtifact(fqName);
      const filePath = path.join(outDir, `${artifact.contractName}.json`);
      await fs.writeFile(filePath, JSON.stringify(artifact.abi, null, 2));
    }

    return result;
  })
  .build();
