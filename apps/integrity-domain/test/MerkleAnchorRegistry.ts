import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { expect } from "chai";
import { toUtf8Bytes } from "ethers";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

async function deployRegistryFixture() {
  const [owner, nonOwner] = await ethers.getSigners();
  const MerkleAnchorRegistry = await ethers.deployContract(
    "MerkleAnchorRegistry",
  );
  return { MerkleAnchorRegistry, owner, nonOwner };
}

describe("MerkleAnchorRegistry", function () {
  let MerkleAnchorRegistry: Awaited<
    ReturnType<typeof deployRegistryFixture>
  >["MerkleAnchorRegistry"];
  let nonOwner: Awaited<ReturnType<typeof deployRegistryFixture>>["nonOwner"];

  // Deploy a fresh contract before each test
  beforeEach(async function () {
    const fixture = await networkHelpers.loadFixture(deployRegistryFixture);
    MerkleAnchorRegistry = fixture.MerkleAnchorRegistry;
    nonOwner = fixture.nonOwner;
  });

  describe("addMerkleRoot", function () {
    describe("Access Control", function () {
      it("should revert with OwnableUnauthorizedAccount when called by non-owner", async function () {
        const hashToBeAnchored = ethers.keccak256(toUtf8Bytes("testData"));

        await expect(
          MerkleAnchorRegistry.connect(nonOwner).addMerkleRoot(
            hashToBeAnchored,
            10,
            1,
          ),
        ).to.be.revertedWithCustomError(
          MerkleAnchorRegistry,
          "OwnableUnauthorizedAccount",
        );
      });
    });

    describe("Custom Errors", function () {
      it("should revert with ZeroRoot when root is zero", async function () {
        await expect(
          MerkleAnchorRegistry.addMerkleRoot(ethers.ZeroHash, 10, 1),
        ).to.be.revertedWithCustomError(MerkleAnchorRegistry, "ZeroRoot");
      });

      it("should revert with RootAlreadyExists when root already exists", async function () {
        const hashToBeAnchored = ethers.keccak256(toUtf8Bytes("testData"));

        await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored, 2, 1);
        await expect(
          MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored, 10, 2),
        ).to.be.revertedWithCustomError(
          MerkleAnchorRegistry,
          "RootAlreadyExists",
        );
      });

      it("should revert with RootAlreadyExists when batch id was already used for a successful submission", async function () {
        const hash1 = ethers.keccak256(toUtf8Bytes("testData1"));
        const hash2 = ethers.keccak256(toUtf8Bytes("testData2"));

        await MerkleAnchorRegistry.addMerkleRoot(hash1, 10, 1);
        await expect(
          MerkleAnchorRegistry.addMerkleRoot(hash2, 20, 1),
        ).to.be.revertedWithCustomError(
          MerkleAnchorRegistry,
          "RootAlreadyExists",
        );
      });

      it("should revert with ZeroBatchSize when batch size is zero", async function () {
        await expect(
          MerkleAnchorRegistry.addMerkleRoot(ethers.randomBytes(32), 0, 1),
        ).to.be.revertedWithCustomError(MerkleAnchorRegistry, "ZeroBatchSize");
      });
    });

    describe("Function Call", function () {
      it("should add a new merkle root successfully", async function () {
        const hashToBeAnchored = ethers.keccak256(toUtf8Bytes("testData"));
        const batchSize = 50;
        const index = await MerkleAnchorRegistry.getRootCount();

        await expect(
          MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored, batchSize, 1),
        )
          .to.emit(MerkleAnchorRegistry, "RootAdded")
          .withArgs(index, hashToBeAnchored, batchSize);

        const containsRoot =
          await MerkleAnchorRegistry.containsMerkleRoot(hashToBeAnchored);
        expect(containsRoot).to.be.true;
      });

      it("should add multiple merkle roots successfully", async function () {
        const hashToBeAnchored1 = ethers.keccak256(toUtf8Bytes("testData1"));
        const hashToBeAnchored2 = ethers.keccak256(toUtf8Bytes("testData2"));
        const batchSize1 = 10;
        const batchSize2 = 20;

        await expect(
          MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored1, batchSize1, 1),
        )
          .to.emit(MerkleAnchorRegistry, "RootAdded")
          .withArgs(0, hashToBeAnchored1, batchSize1);

        await expect(
          MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored2, batchSize2, 2),
        )
          .to.emit(MerkleAnchorRegistry, "RootAdded")
          .withArgs(1, hashToBeAnchored2, batchSize2);
      });

      it("should update the storage correctly after adding multiple roots", async function () {
        const hashToBeAnchored1 = ethers.keccak256(toUtf8Bytes("testData1"));
        const hashToBeAnchored2 = ethers.keccak256(toUtf8Bytes("testData2"));
        const batchSize1 = 10;
        const batchSize2 = 20;

        await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored1, batchSize1, 1);
        await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored2, batchSize2, 2);

        const rootCount = await MerkleAnchorRegistry.getRootCount();
        expect(rootCount).to.equal(2);

        const containsRoot1 =
          await MerkleAnchorRegistry.containsMerkleRoot(hashToBeAnchored1);
        const containsRoot2 =
          await MerkleAnchorRegistry.containsMerkleRoot(hashToBeAnchored2);
        expect(containsRoot1).to.be.true;
        expect(containsRoot2).to.be.true;

        const latestRoot = await MerkleAnchorRegistry.getLatestMerkleRoot();
        expect(latestRoot).to.equal(hashToBeAnchored2);

        const rootAtIndex0 = await MerkleAnchorRegistry.getMerkleRootAt(0);
        const rootAtIndex1 = await MerkleAnchorRegistry.getMerkleRootAt(1);
        expect(rootAtIndex0).to.equal(hashToBeAnchored1);
        expect(rootAtIndex1).to.equal(hashToBeAnchored2);

        const indexOfRoot1 =
          await MerkleAnchorRegistry.getMerkleRootIndex(hashToBeAnchored1);
        const indexOfRoot2 =
          await MerkleAnchorRegistry.getMerkleRootIndex(hashToBeAnchored2);
        expect(indexOfRoot1).to.equal(0);
        expect(indexOfRoot2).to.equal(1);
      });
    });
  });

  describe("containsMerkleRoot", function () {
    it("should return true for an existing merkle root", async function () {
      const hashToBeAnchored = ethers.keccak256(toUtf8Bytes("testData"));
      await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored, 10, 1);
      const containsRoot =
        await MerkleAnchorRegistry.containsMerkleRoot(hashToBeAnchored);
      expect(containsRoot).to.be.true;
    });

    it("should return false for a non-existing merkle root", async function () {
      const hashToBeAnchored = ethers.keccak256(toUtf8Bytes("testData"));
      const containsRoot =
        await MerkleAnchorRegistry.containsMerkleRoot(hashToBeAnchored);
      expect(containsRoot).to.be.false;
    });
  });

  describe("getMerkleRootAt", function () {
    describe("Custom Errors", function () {
      it("should revert with IndexOutOfBounds when index is out of bounds", async function () {
        await expect(
          MerkleAnchorRegistry.getMerkleRootAt(21000000),
        ).to.be.revertedWithCustomError(
          MerkleAnchorRegistry,
          "IndexOutOfBounds",
        );
      });
    });

    describe("Function Call", function () {
      it("should return the correct merkle root at a given index", async function () {
        const hashToBeAnchored1 = ethers.keccak256(toUtf8Bytes("testData1"));
        const hashToBeAnchored2 = ethers.keccak256(toUtf8Bytes("testData2"));

        await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored1, 10, 1);
        await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored2, 15, 2);

        expect(await MerkleAnchorRegistry.getMerkleRootAt(0)).to.equal(
          hashToBeAnchored1,
        );
        expect(await MerkleAnchorRegistry.getMerkleRootAt(1)).to.equal(
          hashToBeAnchored2,
        );
      });
    });
  });

  describe("getMerkleRootIndex", function () {
    describe("Custom Errors", function () {
      it("should revert with RootDoesNotExist when the merkle root is not found", async function () {
        const hashToBeAnchored = ethers.keccak256(toUtf8Bytes("testData"));

        await expect(
          MerkleAnchorRegistry.getMerkleRootIndex(hashToBeAnchored),
        ).to.be.revertedWithCustomError(
          MerkleAnchorRegistry,
          "RootDoesNotExist",
        );
      });
    });

    describe("Function Call", function () {
      it("should return the correct index for an existing merkle root", async function () {
        const hashToBeAnchored1 = ethers.keccak256(toUtf8Bytes("testData1"));
        const hashToBeAnchored2 = ethers.keccak256(toUtf8Bytes("testData2"));

        await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored1, 10, 1);
        await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored2, 15, 2);

        expect(
          await MerkleAnchorRegistry.getMerkleRootIndex(hashToBeAnchored1),
        ).to.equal(0);
        expect(
          await MerkleAnchorRegistry.getMerkleRootIndex(hashToBeAnchored2),
        ).to.equal(1);
      });
    });
  });

  describe("getLatestMerkleRoot", function () {
    describe("Custom Errors", function () {
      it("should revert with NoRootsStored when no merkle roots exist", async function () {
        await expect(
          MerkleAnchorRegistry.getLatestMerkleRoot(),
        ).to.be.revertedWithCustomError(MerkleAnchorRegistry, "NoRootsStored");
      });
    });

    describe("Function Call", function () {
      it("should return the latest merkle root after multiple additions", async function () {
        const hashToBeAnchored1 = ethers.keccak256(toUtf8Bytes("testData1"));
        const hashToBeAnchored2 = ethers.keccak256(toUtf8Bytes("testData2"));
        const hashToBeAnchored3 = ethers.keccak256(toUtf8Bytes("testData3"));

        await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored1, 10, 1);
        await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored2, 15, 2);
        await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored3, 20, 3);

        expect(await MerkleAnchorRegistry.getLatestMerkleRoot()).to.equal(
          hashToBeAnchored3,
        );
      });
    });
  });

  describe("getBatchInfo", function () {
    describe("Custom Errors", function () {
      it("should revert with RootDoesNotExist when the batch id is not found", async function () {
        await expect(
          MerkleAnchorRegistry.getBatchInfo(999),
        ).to.be.revertedWithCustomError(
          MerkleAnchorRegistry,
          "RootDoesNotExist",
        );
      });
    });

    describe("Function Call", function () {
      it("should return the root and size for a known batch id", async function () {
        const hashToBeAnchored = ethers.keccak256(toUtf8Bytes("testData"));
        const batchSize = 7;

        await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored, batchSize, 42);

        const [root, size] = await MerkleAnchorRegistry.getBatchInfo(42);
        expect(root).to.equal(hashToBeAnchored);
        expect(size).to.equal(batchSize);
      });

      it("should return independent info for multiple batch ids", async function () {
        const hash1 = ethers.keccak256(toUtf8Bytes("testData1"));
        const hash2 = ethers.keccak256(toUtf8Bytes("testData2"));

        await MerkleAnchorRegistry.addMerkleRoot(hash1, 10, 1);
        await MerkleAnchorRegistry.addMerkleRoot(hash2, 20, 2);

        const info1 = await MerkleAnchorRegistry.getBatchInfo(1);
        const info2 = await MerkleAnchorRegistry.getBatchInfo(2);
        expect(info1.root).to.equal(hash1);
        expect(info1.size).to.equal(10);
        expect(info2.root).to.equal(hash2);
        expect(info2.size).to.equal(20);
      });
    });
  });

  describe("getRootCount", function () {
    it("should return the count of stored merkle roots", async function () {
      expect(await MerkleAnchorRegistry.getRootCount()).to.equal(0);

      const hashToBeAnchored1 = ethers.keccak256(toUtf8Bytes("testData1"));
      const hashToBeAnchored2 = ethers.keccak256(toUtf8Bytes("testData2"));

      await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored1, 10, 1);
      await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored2, 15, 2);

      expect(await MerkleAnchorRegistry.getRootCount()).to.equal(2);
    });
  });

  describe("getMerkleRootsPaged", function () {
    it("should return the correct paged merkle roots", async function () {
      const hashToBeAnchored1 = ethers.keccak256(toUtf8Bytes("testData1"));
      const hashToBeAnchored2 = ethers.keccak256(toUtf8Bytes("testData2"));
      const hashToBeAnchored3 = ethers.keccak256(toUtf8Bytes("testData3"));
      const hashToBeAnchored4 = ethers.keccak256(toUtf8Bytes("testData4"));
      const hashToBeAnchored5 = ethers.keccak256(toUtf8Bytes("testData5"));
      const hashToBeAnchored6 = ethers.keccak256(toUtf8Bytes("testData6"));
      const hashToBeAnchored7 = ethers.keccak256(toUtf8Bytes("testData7"));
      const hashToBeAnchored8 = ethers.keccak256(toUtf8Bytes("testData8"));
      const hashToBeAnchored9 = ethers.keccak256(toUtf8Bytes("testData9"));
      const hashToBeAnchored10 = ethers.keccak256(toUtf8Bytes("testData10"));

      await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored1, 10, 1);
      await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored2, 15, 2);
      await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored3, 20, 3);
      await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored4, 20, 4);
      await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored5, 30, 5);
      await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored6, 31, 6);
      await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored7, 43, 7);
      await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored8, 21, 8);
      await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored9, 10, 9);
      await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored10, 5, 10);

      expect(
        await MerkleAnchorRegistry.getMerkleRootsPaged(5, 5),
      ).to.deep.equal([
        hashToBeAnchored6,
        hashToBeAnchored7,
        hashToBeAnchored8,
        hashToBeAnchored9,
        hashToBeAnchored10,
      ]);
    });

    it("should return an empty array when root count is zero", async function () {
      expect(
        await MerkleAnchorRegistry.getMerkleRootsPaged(0, 0),
      ).to.deep.equal([]);
    });

    it("should return an empty array when start index is out of bounds", async function () {
      const hashToBeAnchored1 = ethers.keccak256(toUtf8Bytes("testData1"));
      const hashToBeAnchored2 = ethers.keccak256(toUtf8Bytes("testData2"));

      await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored1, 10, 1);
      await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored2, 15, 2);

      expect(
        await MerkleAnchorRegistry.getMerkleRootsPaged(5, 5),
      ).to.deep.equal([]);
    });

    it("should return an empty array when limit is zero", async function () {
      const hashToBeAnchored1 = ethers.keccak256(toUtf8Bytes("testData1"));
      const hashToBeAnchored2 = ethers.keccak256(toUtf8Bytes("testData2"));

      await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored1, 10, 1);
      await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored2, 15, 2);

      expect(
        await MerkleAnchorRegistry.getMerkleRootsPaged(0, 0),
      ).to.deep.equal([]);
    });

    it("should truncate results correctly when limit exceeds remaining items", async function () {
      const hashToBeAnchored1 = ethers.keccak256(toUtf8Bytes("testData1"));
      const hashToBeAnchored2 = ethers.keccak256(toUtf8Bytes("testData2"));
      const hashToBeAnchored3 = ethers.keccak256(toUtf8Bytes("testData3"));

      await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored1, 10, 1);
      await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored2, 15, 2);
      await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored3, 20, 3);

      expect(
        await MerkleAnchorRegistry.getMerkleRootsPaged(1, 5),
      ).to.deep.equal([hashToBeAnchored2, hashToBeAnchored3]);
    });
  });

  describe("verifyMerkleProof", function () {
    describe("Custom Errors", function () {
      it("should revert with RootDoesNotExist when the merkle root is not found", async function () {
        const hashToBeAnchored = ethers.keccak256(toUtf8Bytes("testData"));
        const hashToBeVerified = ethers.keccak256(toUtf8Bytes("testData2"));

        await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored, 10, 1);
        await expect(
          MerkleAnchorRegistry.verifyMerkleProof(
            hashToBeVerified,
            [],
            hashToBeAnchored,
          ),
        ).to.be.revertedWithCustomError(
          MerkleAnchorRegistry,
          "RootDoesNotExist",
        );
      });
    });

    describe("Function Call", function () {
      // Helper: computes the leaf hash the same way OpenZeppelin's
      // StandardMerkleTree does internally: keccak256(keccak256(abi.encode(value)))
      function computeLeafHash(value: string): string {
        const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32"],
          [value],
        );
        return ethers.keccak256(ethers.keccak256(encoded));
      }

      // Shared tree setup used by all tests in this block
      function buildTestTree() {
        const leaves = [
          [ethers.keccak256(toUtf8Bytes("record1"))],
          [ethers.keccak256(toUtf8Bytes("record2"))],
          [ethers.keccak256(toUtf8Bytes("record3"))],
          [ethers.keccak256(toUtf8Bytes("record4"))],
          [ethers.keccak256(toUtf8Bytes("record5"))],
          [ethers.keccak256(toUtf8Bytes("record6"))],
        ];
        const tree = StandardMerkleTree.of(leaves, ["bytes32"]);
        return { tree, leaves };
      }

      it("should return true for a valid merkle proof", async function () {
        const { tree, leaves } = buildTestTree();

        await MerkleAnchorRegistry.addMerkleRoot(tree.root, leaves.length, 1);

        const proof = tree.getProof(0);
        const leafHash = computeLeafHash(leaves[0][0]);

        expect(
          await MerkleAnchorRegistry.verifyMerkleProof(
            tree.root,
            proof,
            leafHash,
          ),
        ).to.be.true;
      });

      it("should return false for a wrong leaf", async function () {
        const { tree, leaves } = buildTestTree();

        await MerkleAnchorRegistry.addMerkleRoot(tree.root, leaves.length, 1);

        const proof = tree.getProof(0);
        // Use a leaf that does NOT belong to the tree
        const wrongLeafHash = computeLeafHash(
          ethers.keccak256(toUtf8Bytes("tampered-record")),
        );

        expect(
          await MerkleAnchorRegistry.verifyMerkleProof(
            tree.root,
            proof,
            wrongLeafHash,
          ),
        ).to.be.false;
      });

      it("should return false for a corrupted proof", async function () {
        const { tree, leaves } = buildTestTree();

        await MerkleAnchorRegistry.addMerkleRoot(tree.root, leaves.length, 1);

        const proof = tree.getProof(0);
        const leafHash = computeLeafHash(leaves[0][0]);

        // Corrupt one hash in the proof
        const corruptedProof = [...proof];
        corruptedProof[0] = ethers.keccak256(toUtf8Bytes("corrupted"));

        expect(
          await MerkleAnchorRegistry.verifyMerkleProof(
            tree.root,
            corruptedProof,
            leafHash,
          ),
        ).to.be.false;
      });
    });
  });
});
