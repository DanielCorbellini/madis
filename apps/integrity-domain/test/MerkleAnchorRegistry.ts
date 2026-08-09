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
      it("It should revert with OwnableUnauthorizedAccount when called by non-owner", async function () {
        const hashToBeAnchored = ethers.keccak256(toUtf8Bytes("testData"));

        await expect(
          MerkleAnchorRegistry.connect(nonOwner).addMerkleRoot(
            hashToBeAnchored,
            10,
          ),
        ).to.be.revertedWithCustomError(
          MerkleAnchorRegistry,
          "OwnableUnauthorizedAccount",
        );
      });
    });

    describe("Custom Errors", function () {
      it("It should revert with ZeroRoot when root is zero", async function () {
        await expect(
          MerkleAnchorRegistry.addMerkleRoot(ethers.ZeroHash, 10),
        ).to.be.revertedWithCustomError(MerkleAnchorRegistry, "ZeroRoot");
      });

      it("It should revert with RootAlreadyExists when root already exists", async function () {
        const hashToBeAnchored = ethers.keccak256(toUtf8Bytes("testData"));

        await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored, 2);
        await expect(
          MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored, 10),
        ).to.be.revertedWithCustomError(
          MerkleAnchorRegistry,
          "RootAlreadyExists",
        );
      });

      it("It should revert with ZeroBatchSize when batch size is zero", async function () {
        await expect(
          MerkleAnchorRegistry.addMerkleRoot(ethers.randomBytes(32), 0),
        ).to.be.revertedWithCustomError(MerkleAnchorRegistry, "ZeroBatchSize");
      });
    });

    describe("Function Call", function () {
      it("It should add a new merkle root successfully", async function () {
        const hashToBeAnchored = ethers.keccak256(toUtf8Bytes("testData"));
        const batchSize = 50;
        const index = await MerkleAnchorRegistry.getRootCount();

        await expect(
          MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored, batchSize),
        )
          .to.emit(MerkleAnchorRegistry, "RootAdded")
          .withArgs(index, hashToBeAnchored, batchSize);

        const containsRoot =
          await MerkleAnchorRegistry.containsMerkleRoot(hashToBeAnchored);
        expect(containsRoot).to.be.true;
      });

      it("It should add multiple merkle roots successfully", async function () {
        const hashToBeAnchored1 = ethers.keccak256(toUtf8Bytes("testData1"));
        const hashToBeAnchored2 = ethers.keccak256(toUtf8Bytes("testData2"));
        const batchSize1 = 10;
        const batchSize2 = 20;

        await expect(
          MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored1, batchSize1),
        )
          .to.emit(MerkleAnchorRegistry, "RootAdded")
          .withArgs(0, hashToBeAnchored1, batchSize1);

        await expect(
          MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored2, batchSize2),
        )
          .to.emit(MerkleAnchorRegistry, "RootAdded")
          .withArgs(1, hashToBeAnchored2, batchSize2);
      });

      it("It should update the storage correctly after adding multiple roots", async function () {
        const hashToBeAnchored1 = ethers.keccak256(toUtf8Bytes("testData1"));
        const hashToBeAnchored2 = ethers.keccak256(toUtf8Bytes("testData2"));
        const batchSize1 = 10;
        const batchSize2 = 20;

        await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored1, batchSize1);
        await MerkleAnchorRegistry.addMerkleRoot(hashToBeAnchored2, batchSize2);

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
    it("", async function () {
      // TODO
    });
  });

  describe("getMerkleRootAt", function () {
    it("", async function () {
      // TODO
    });
  });

  describe("getMerkleRootIndex", function () {
    it("", async function () {
      // TODO
    });
  });

  describe("getLatestMerkleRoot", function () {
    it("", async function () {
      // TODO
    });
  });

  describe("getRootCount", function () {
    it("", async function () {
      // TODO
    });
  });

  describe("getMerkleRootsPaged", function () {
    it("", async function () {
      // TODO
    });
  });

  describe("verifyMerkleProof", function () {
    it("", async function () {
      // TODO
    });
  });
});
