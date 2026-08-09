// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @dev Contract responsible for storing and verifying Merkle Roots on the blockchain.
 *
 * Acts as the system's Anchor of Trust against RDBMS data tampering.
 */
contract MerkleAnchorRegistry is Ownable {
    error ZeroRoot();
    error RootAlreadyExists(bytes32 root);
    error RootDoesNotExist(bytes32 root);
    error ZeroBatchSize();
    error IndexOutOfBounds(uint256 index, uint256 total);
    error NoRootsStored();

    bytes32[] private merkleRoots;
    mapping(bytes32 => uint256) private rootToIndexPlusOne;

    event RootAdded(
        uint256 indexed index,
        bytes32 indexed root,
        uint256 batchSize
    );

    /**
     * @dev Sets the deployer as the contract owner.
     */
    constructor() Ownable(msg.sender) {}

    /**
     * @dev Anchors a new Merkle Root to the immutable on-chain history.
     */
    function addMerkleRoot(
        bytes32 _root,
        uint256 _batchSize
    ) external onlyOwner returns (uint256) {
        if (_root == bytes32(0)) revert ZeroRoot();
        if (_batchSize == 0) revert ZeroBatchSize();
        if (rootToIndexPlusOne[_root] != 0) revert RootAlreadyExists(_root);

        uint256 index = merkleRoots.length;
        merkleRoots.push(_root);
        rootToIndexPlusOne[_root] = index + 1;

        emit RootAdded(index, _root, _batchSize);

        return index;
    }

    /**
     * @dev Checks if a Merkle Root exists in the on-chain history O(1).
     */
    function containsMerkleRoot(bytes32 _root) public view returns (bool) {
        return rootToIndexPlusOne[_root] != 0;
    }

    /**
     * @dev Returns the Merkle Root stored at a given positional index.
     */
    function getMerkleRootAt(uint256 _index) external view returns (bytes32) {
        if (_index >= merkleRoots.length) {
            revert IndexOutOfBounds(_index, merkleRoots.length);
        }

        return merkleRoots[_index];
    }

    /**
     * @dev Returns the positional index of a Merkle Root in history.
     */
    function getMerkleRootIndex(bytes32 _root) external view returns (uint256) {
        uint256 indexPlusOne = rootToIndexPlusOne[_root];
        if (indexPlusOne == 0) revert RootDoesNotExist(_root);

        return indexPlusOne - 1;
    }

    /**
     * @dev Returns the last anchored Merkle Root.
     */
    function getLatestMerkleRoot() external view returns (bytes32) {
        if (merkleRoots.length == 0) revert NoRootsStored();
        return merkleRoots[merkleRoots.length - 1];
    }

    /**
     * @dev Returns the total number of anchored Merkle Roots.
     */
    function getRootCount() external view returns (uint256) {
        return merkleRoots.length;
    }

    /**
     * @dev Returns a paginated slice of anchored Merkle Roots.
     * Returns an empty array if offset is out of bounds or if no roots are stored.
     */
    function getMerkleRootsPaged(
        uint256 _offset,
        uint256 _limit
    ) external view returns (bytes32[] memory) {
        uint256 total = merkleRoots.length;
        if (total == 0 || _offset >= total) {
            return new bytes32[](0);
        }

        uint256 remaining = total - _offset;
        uint256 size = _limit < remaining ? _limit : remaining;
        bytes32[] memory result = new bytes32[](size);

        for (uint256 i = 0; i < size; i++) {
            result[i] = merkleRoots[_offset + i];
        }

        return result;
    }

    /**
     * @dev Verifies a Merkle Proof against a registered root.
     */
    function verifyMerkleProof(
        bytes32 _root,
        bytes32[] calldata _proof,
        bytes32 _leaf
    ) external view returns (bool) {
        if (!containsMerkleRoot(_root)) revert RootDoesNotExist(_root);
        return MerkleProof.verify(_proof, _root, _leaf);
    }
}
