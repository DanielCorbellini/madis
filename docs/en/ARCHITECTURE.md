# Architecture of the Merkle-Anchored Data Integrity System (MADIS)

MADIS — Merkle-Anchored Data Integrity System

The proposed architecture aims to mitigate the vulnerability of silent data tampering in relational DBMSs. The solution decentralizes the trust domain by using a public blockchain as an immutable anchor for cryptographic proofs of the data's state via Merkle Trees.

The scope of the solution does not lie in preventing low-level access (such as a privileged DBA or an attacker with root access), but rather in **guaranteeing detectability**: should any arbitrary alteration occur directly in the database, the fraud is exposed and cryptographically provable.

---

## 1. Fundamental Principles and Trust Model

- **The Blockchain as the Anchor of Truth:** The system's trust anchor is the public blockchain, never the relational database.
- **Strict Adversarial Model:** If an attacker has the privileges to tamper with records in the `records` table, they would also have the power to tamper with auxiliary columns or precomputed hashes persisted in the database. For this reason, the audit service (**Monitor**) never trusts hashes derived and saved in the DBMS; it always recomputes the leaves and the Merkle Tree from the raw data and compares the result directly against the blockchain.
- **Security Objective:** Detect unauthorized data manipulation by an insider or an attacker with direct database access (a malicious DBA), by anchoring Merkle Roots on an immutable public network with timestamping.

---

## 2. Domain Division and Monorepo Structure

The system is structured as a monorepo organized around single-responsibility domains:

```text
madis/
├── apps/
│   ├── data-domain/          # REST API for data ingestion and persistence (PostgreSQL)
│   ├── integrity-domain/     # Hardhat / Solidity smart contracts (EVM)
│   ├── anchor-service/       # Periodic anchoring daemon (writes to the blockchain + DB)
│   └── monitor-service/      # Continuous audit daemon (reads from the blockchain + DB)
├── packages/
│   ├── contracts-shared/     # Compiled ABIs, addresses and TypeScript typings for the contract
│   └── crypto-utils/         # Single library for hashing, canonicalization, ABI encoding and the Merkle Tree
└── db/
    ├── schema.sql            # PostgreSQL DDL schema (4 tables)
    └── setup-users.sql       # PostgreSQL RBAC permission configuration
```

### Domain Descriptions:

1. **Client Domain:**
   - The end user's or origin system's point of interaction.
   - Responsible for entering the business data and generating local digital signatures via a cryptographic wallet (private keys held in custody by the client, EVM / ECDSA compatible).
2. **Data Domain ([`apps/data-domain`](../../apps/data-domain)):**
   - Backend API that centralizes operations on the relational DBMS under the _append-only_ model.
   - Validates the authenticity of the digital signature and the client address's permission before persisting the data.
3. **Background Services ([`apps/anchor-service`](../../apps/anchor-service) and [`apps/monitor-service`](../../apps/monitor-service)):**
   - Decoupled processes that run scheduled, autonomous tasks:
     - **Anchor Service:** Collects pending records, validates signatures, builds the Merkle Tree and anchors the root on the blockchain.
     - **Monitor Service:** Periodically rebuilds the trees of already-anchored batches, queries the blockchain, and triggers alerts and _drill-down_ in case of an anomaly.
   - Further job architecture details are in [`docs/overview/jobs/JOBS_ARCHITECTURE.md`](../overview/jobs/JOBS_ARCHITECTURE.md).
4. **Integrity Proof Domain ([`apps/integrity-domain`](../../apps/integrity-domain)):**
   - Decentralized layer on public EVM networks (Polygon / Ethereum).
   - Hosts the [`MerkleAnchorRegistry.sol`](../../apps/integrity-domain/contracts/MerkleAnchorRegistry.sol) smart contract, responsible for the immutable, timestamped registration of Merkle roots.
5. **Shared Libraries ([`packages/`](../../packages)):**
   - Guarantees a **Single Source of Truth** for cryptographic algorithms ([`packages/crypto-utils`](../../packages/crypto-utils)) and contract artifacts ([`packages/contracts-shared`](../../packages/contracts-shared)), preventing implementation discrepancies between the API, the Anchor, and the Monitor.

---

## 3. Diagram and Operational Flows

![Overall Architecture](../ArchitectureV6.png)

The system operates through two main, complementary flows:

### Flow 1: Ingestion and Anchoring

1. The client signs the business data with their private key (ECDSA) and submits the package to the API ([`apps/data-domain`](../../apps/data-domain)).
2. The API cryptographically validates the signature and the signer's permission, persisting the record in the `records` table.
3. Periodically, the **Anchor Service** ([`apps/anchor-service`](../../apps/anchor-service)) scans for records that have not yet been anchored, re-validates every one of them (the signature over the record's full signable content, and the signer's presence in the whitelist), computes the leaves, and builds the Merkle Tree.
4. If any record fails that re-validation, the Anchor emits a `signature_mismatch` alert in the `integrity_alerts` table and excludes the record from the batch.
5. If the resulting Merkle Root already exists on the blockchain (the same records looking "un-anchored" again after someone deleted their pins or their batch), the Anchor persists nothing and emits a `duplicate_root` alert instead of creating a phantom batch.
6. Otherwise, the batch (status `pending`) and each record's individual proof (_Merkle Proof_) are persisted in `batches` / `anchor_records` in one transaction, and only then is the Merkle Root sent to the [`MerkleAnchorRegistry.sol`](../../apps/integrity-domain/contracts/MerkleAnchorRegistry.sol) smart contract via a write transaction signed by the Anchor's wallet.
7. Once the block is confirmed on the blockchain, the batch's status in `batches` is updated to `confirmed`. A batch left in flight by a crash or a slow chain is reconciled at the start of the next cycle.

### Flow 2: Continuous Auditing and Fraud Detection

1. The **Monitor Service** ([`apps/monitor-service`](../../apps/monitor-service)) runs cyclically, independently of the Anchor.
2. The Monitor reads the list of every batch the contract has accepted (batch id and root, straight from the contract's stored state) and compares it with what Postgres says about the same ids. A batch the chain accepted but Postgres lost track of (row deleted, or status changed to one that cannot be true) raises a `root_divergence` alert.
3. For each batch it audits (every `confirmed` row plus every on-chain batch that still has a row, whatever status that row claims), the Monitor takes the batch's root and size from the chain (`getBatchInfo`) — never from Postgres — and checks that the number of records pinned in `anchor_records` equals the on-chain size. It then retrieves the original data from the relational database, recomputes every leaf with the same cryptographic logic, rebuilds the Merkle Root and compares it with the on-chain root (batches above a configurable size are verified record by record instead, streaming, to bound memory).
4. A count mismatch emits a `root_divergence` alert for the batch. If the rebuilt root does not match the on-chain root, at least one record was tampered with after anchoring, and the Monitor triggers the **Drill-Down** procedure.
5. In the Drill-Down, the Monitor uses each record's individual `merkle_proof` saved in `anchor_records` to test each record in isolation against the legitimate root on the blockchain, emitting `record_tampered` alerts and pinpointing exactly which record was violated.
6. Finally, it checks that every batch Postgres claims is still `submitted` actually lands on-chain within a configurable time, using its own clock, to expose forged padding rows.

---

## 4. Data Modeling and Append-Only Control

The data model combines the _append-only_ mechanism with a separation between the business domain and the cryptographic infrastructure across 4 relational tables ([`db/schema.sql`](../../db/schema.sql)):

{ An updated diagram image is still to be made }

### 4.1. `records` Table (Business Data and Authorship — Append-Only)

Stores the sensitive records protected by the system. No row is altered or removed via `UPDATE` or `DELETE`. Logical updates and deletions generate new records instead.

- `id` (`BIGSERIAL PK`): Unique row identifier.
- `entity_id` (`BIGINT NOT NULL`): Stable identifier of the business entity. Groups every version of the same entity (version 1, 2, 3...), making it easy to retrieve the historical lineage via `WHERE entity_id = X`. Scoped by `record_type` (`UNIQUE(record_type, entity_id, version)`), not globally unique.
- `record_type` (`VARCHAR(20) NOT NULL`): Discriminator for the business record type: `'prescription'` (electronic prescription) or `'emr_encounter'` (electronic medical record encounter). Domain chosen: Electronic Medical Records and Prescriptions (Healthcare) — see `docs/DOMINIOS_PROPOSTOS.md`.
- `payload` (`JSONB NOT NULL`): Raw business data signed by the client — exactly the `data` used by `hashPayloadData`/`computeLeafHash` (`packages/crypto-utils`). The Monitor always recomputes the leaves from this column, never from a precomputed hash, preserving the trust model of the blockchain as the sole anchor. The table remains domain-agnostic: the shape of `payload` varies by `record_type` and is validated at the API's edge (`data-domain`), not by the DBMS.
- `version` (`INTEGER NOT NULL DEFAULT 1`): Sequential version number of the entity.
- `is_deleted` (`BOOLEAN NOT NULL DEFAULT FALSE`): Logical deletion marker.
- `replaces` (`BIGINT NULL FK -> records.id`): Self-referencing pointer to the previous version being replaced.
- `client_address` (`CHAR(42) NOT NULL`): Ethereum address of the original signer.
- `signature` (`TEXT NOT NULL`): ECDSA digital signature over the application data.
- `created_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`): Creation timestamp.

### 4.2. `batches` Table (Anchoring Lifecycle)

Records each execution cycle of the anchoring service and the state of its blockchain transaction.

- `id` (`BIGSERIAL PK`): Unique batch identifier.
- `status` (`VARCHAR(20) NOT NULL`): Lifecycle state: `pending` $\to$ `submitted` $\to$ `confirmed` or `failed`.
- `merkle_root` (`CHAR(66) NOT NULL`): Merkle Root computed for the batch (`0x` + 64 hex characters).
- `size` (`INTEGER NOT NULL`): Number of records that make up the batch.
- `transaction_hash` (`CHAR(66) NULL`): Hash of the transaction submitted to the blockchain network.
- `block_number` (`BIGINT NULL`): Number of the block the transaction was included in on the decentralized network.
- `block_timestamp` (`TIMESTAMPTZ NULL`): Official timestamp of the mined block.
- `retry_count` (`INTEGER NOT NULL DEFAULT 0`): Counter of resend attempts in case of transient failures.
- `error_message` (`TEXT NULL`): Description of the error in case of failure/reversion.
- `created_at` / `confirmed_at` (`TIMESTAMPTZ`): Start and completion timestamps of the cycle.

### 4.3. `anchor_records` Table (Record–Batch Bridge and Individual Proofs)

Uniquely links (`UNIQUE(record_id)`) each record to the batch that anchored it.

- `id` (`BIGSERIAL PK`): Unique identifier.
- `record_id` (`BIGINT NOT NULL FK -> records.id`): The anchored record.
- `batch_id` (`BIGINT NOT NULL FK -> batches.id`): The anchoring batch.
- `merkle_proof` (`JSONB NOT NULL`): Ordered array of sibling hashes needed to validate the leaf's inclusion in the root. Thanks to the OpenZeppelin standard (_Sorted Pairs_), verification requires no positional indices (`leaf_index`).
- `anchored_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`): Linking timestamp.

### 4.4. `integrity_alerts` Table (Incident and Audit Log)

Immutable log for persisting detected divergences and fraud.

- `id` (`BIGSERIAL PK`): Alert identifier.
- `alert_type` (`VARCHAR(30) NOT NULL`): Incident type: `'signature_mismatch'` | `'root_divergence'` | `'record_tampered'` | `'duplicate_root'`.
- `source` (`VARCHAR(20) NOT NULL`): Detection source: `'anchor'` | `'monitor'`.
- `batch_id` (`BIGINT NULL FK -> batches.id`): Affected batch (if applicable).
- `record_id` (`BIGINT NULL FK -> records.id`): Identified tampered record (in the case of _drill-down_).
- `expected_root` (`TEXT NULL`): Legitimate root registered on the blockchain (or, for an anchor-side `root_divergence`, the root stored for the batch).
- `actual_root` (`TEXT NULL`): The root that disagrees with it: the root rebuilt locally, or, for `duplicate_root`, the root that already exists on-chain.
- `details` (`TEXT NULL`): Additional technical context about the occurrence.
- `detected_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`): Detection timestamp.

### 4.5. PostgreSQL Permission Model ([`db/setup-users.sql`](../../db/setup-users.sql))

To enforce the _append-only_ property at the infrastructure layer, the database operates with two user roles:

- **`app_user` (Principle of Least Privilege):** Used in production by the API, the Anchor, and the Monitor. Has only `SELECT` and `INSERT` permission on the `records` table, guaranteeing that any attempted `UPDATE` or `DELETE` is blocked by the DBMS itself.
- **`admin_user` (Adversarial Scenario):** User with unrestricted administrative privileges, used exclusively for empirical tampering tests (simulating an attacker or malicious DBA with direct database access).

---

## 5. Cryptographic Specification and Tree Construction

All hashing logic and Merkle Tree manipulation is centralized in the shared library [`packages/crypto-utils`](../../packages/crypto-utils).

### 5.1. Data Canonicalization (RFC 8785)

To guarantee strict determinism when serializing business attributes to JSON before hashing, the RFC 8785 standard (JSON Canonicalization Scheme) is used, ensuring stable key ordering and uniform formatting:

$$\text{dataHash} = \text{Keccak256}(\text{toUtf8Bytes}(\text{canonicalize}(\text{data})))$$

### 5.2. Merkle Leaf Computation ($L_i$)

To guarantee collision resistance and interoperability with Solidity and the EVM ABI standard, the tree's leaf binds every column of the record's `records` row — not just its payload and signature — via `AbiCoder.defaultAbiCoder().encode(["uint256", "uint256", "string", "bytes32", "uint256", "bool", "uint256", "address", "string", "uint256"], [id, entityId, recordType, dataHash, version, isDeleted, replaces, clientAddress, signature, createdAt])`:

$$L_i = \text{Keccak256}\Big(\text{abi.encode}\big([\text{"uint256"}, \text{"uint256"}, \text{"string"}, \text{"bytes32"}, \text{"uint256"}, \text{"bool"}, \text{"uint256"}, \text{"address"}, \text{"string"}, \text{"uint256"}], [id_i, \text{entityId}_i, \text{recordType}_i, \text{dataHash}_i, \text{version}_i, \text{isDeleted}_i, \text{replaces}_i, \text{clientAddress}_i, \text{signature}_i, \text{createdAt}_i]\big)\Big)$$

Binding all ten fields — not just `id`/`dataHash`/`signature` — means tampering with any single column after a record is anchored (e.g. rewriting `version` or `replaces` to hide a version, or `client_address` to forge authorship) changes $L_i$ and is therefore caught by the Monitor's root comparison, the same way tampering with the payload itself is. `replaces` is encoded as `0` when `NULL` (an original row has no previous version), and `clientAddress` is EIP-55 checksum-normalized via `getAddress()` before encoding as `"address"`. This field order is permanent — it matches `db/schema.sql`'s `records` column declaration order — and must never change once records are anchored against it.

### 5.3. Merkle Tree with Sorted Pairs

Tree construction follows the OpenZeppelin ecosystem's standard specification (`@openzeppelin/merkle-tree` and `MerkleProof.sol`):

- When combining two child nodes $A$ and $B$, the hashes are sorted lexicographically before concatenation:
  $$H(A, B) = \text{Keccak256}\big(\min(A, B) \parallel \max(A, B)\big)$$
- **Advantage:** Proof verification becomes completely independent of the leaf's original position in the tree, dispensing with metadata such as `leaf_index`.

---

## 6. Background Services (Jobs)

### 6.1. Anchoring Daemon (`apps/anchor-service`)

Batch process executed periodically (e.g. every 1 to 3 hours). Each cycle (full detail in [`ANCHOR_SERVICE_EXECUTION_CYCLE.md`](ANCHOR_SERVICE_EXECUTION_CYCLE.md)):

1. **Reconciliation:** Resolves batches a previous cycle left in flight (`pending`, `submitted`, `failed`) before any new work.
2. **Scan:** Fetches records in `records` that do not yet have an associated entry in `anchor_records`.
3. **Prior Validation:** Checks that the digital signature (over the record's full signable content) matches the signer and that the signer is whitelisted. If not, emits a `signature_mismatch` alert and discards the record from the batch.
4. **Tree Construction:** Generates the leaves $L_i$, computes the Merkle Root, and extracts the `merkle_proof` for each leaf. A large backlog is split into batches of at most `ANCHOR_MAX_BATCH_SIZE` records (default 100,000), each anchored as its own batch in the same cycle (steps 5-7 repeat per batch).
5. **Duplicate-Root Guard:** If the root already exists on-chain, persists nothing and emits a `duplicate_root` alert.
6. **Batch Persistence:** In one transaction, inserts the batch (status `pending`) into `batches` and persists the individual proofs in `anchor_records`.
7. **On-Chain Transaction:** Invokes `MerkleAnchorRegistry.addMerkleRoot(root, size, batchId)` on the decentralized network and waits for confirmation, after which the batch becomes `confirmed`.

### 6.2. Integrity Monitor (`apps/monitor-service`)

Continuous audit process executed at high frequency (e.g. every 5 to 15 minutes). Each cycle (full detail in [`MONITOR_SERVICE_EXECUTION_CYCLE.md`](MONITOR_SERVICE_EXECUTION_CYCLE.md)):

1. **Chain-Driven Retrieval:** Lists every batch the contract has accepted (`getBatchIdsPaged` / `getMerkleRootsPaged`) and asks Postgres about those same ids. Batches Postgres lost track of (or labels with an impossible status) raise a `root_divergence` alert; the audit set is every `confirmed` row plus every on-chain batch that has a row, so changing a `status` cannot hide a batch.
2. **Ground Truth From the Chain:** For each batch, reads the root and size from `getBatchInfo` and compares the size with the number of pinned records in `anchor_records`.
3. **Independent Reconstruction:** Retrieves the raw records in `records` and rebuilds the Merkle Root from the database's data (for batches above `ANCHOR_MAX_BATCH_SIZE`, verifies each record's stored proof instead).
4. **Inconsistency Handling:** If the rebuilt root diverges from the blockchain's, executes the individual **Drill-Down** procedure, emitting `record_tampered` for each violated record.
5. **Staleness Check:** Flags `submitted` batches that never land on-chain within `MONITOR_SUBMITTED_STALE_MS`.

---

## 7. Alerting Strategy and Drill-Down Procedure

When a divergence is detected at the batch level, the Monitor doesn't just flag the batch as fraudulent — it individually identifies which records were tampered with:

```text
[Divergent Batch Detected]
  (rebuilt root ≠ on-chain root, or the batch is too large to rebuild)
         │
         ▼
[1. Runs Drill-Down record by record]
   For each record pinned to the batch:
     a. Recomputes leaf Li from the current data in records
     b. Retrieves the merkle_proof saved in anchor_records
     c. Validates: verifyMerkleProof(merkle_proof, blockchainRoot, Li)
     d. If it FAILS ──> [Emits Alert: record_tampered (batch_id, record_id)]

(A pin count different from the on-chain size is reported separately,
 as root_divergence (batch_id), before this procedure.)
```

### Adversarial Security Property of the Drill-Down:

Even if the attacker has altered the `merkle_proof` or the batch's data in the relational database, the reference root used in the verification test is always the immutable root obtained from the **Blockchain**, making it computationally infeasible for the attacker to forge a false proof that validates tampered data.

---

## 8. Smart Contract ([`MerkleAnchorRegistry.sol`](../../apps/integrity-domain/contracts/MerkleAnchorRegistry.sol))

The smart contract acts as the system's public integrity anchor. It is developed in Solidity (^0.8.28) using OpenZeppelin's reference libraries (`Ownable`, `MerkleProof`).

### Main Methods:

- `addMerkleRoot(bytes32 _root, uint256 _batchSize, uint256 _batchId) external onlyOwner returns (uint256)`: Registers a new Merkle Root under a batch id and emits `RootAdded(index, root, batchSize, batchId)`. Guarantees that a root can be registered only once and a batch id used only once, and prevents null roots and empty batches.
- `containsMerkleRoot(bytes32 _root) public view returns (bool)`: $O(1)$ existence check with no gas cost.
- `getMerkleRootAt(uint256 _index) external view returns (bytes32)`: Historical lookup by sequential index.
- `getBatchInfo(uint256 _batchId) external view returns (bytes32 root, uint256 size)`: The root and size anchored under a batch id — the ground truth the Monitor audits each batch against.
- `getBatchIdByRoot(bytes32 _root) external view returns (uint256)`: Reverse lookup — which batch id a root was registered under (reverts if it was never registered).
- `getLatestMerkleRoot() external view returns (bytes32)`: Returns the most recently registered root.
- `getRootCount() external view returns (uint256)`: Returns the total number of anchored batches.
- `getMerkleRootsPaged(uint256 _offset, uint256 _limit) external view returns (bytes32[] memory)`: Enables efficient pagination of the root history for off-chain synchronization.
- `getBatchIdsPaged(uint256 _offset, uint256 _limit) external view returns (uint256[] memory)`: The matching batch ids, in the same order, so the Monitor can enumerate every anchored batch from the contract's stored state without scanning event logs.
- `verifyMerkleProof(bytes32 _root, bytes32[] calldata _proof, bytes32 _leaf) external view returns (bool)`: Validates a cryptographic proof directly against a root registered on the contract.
