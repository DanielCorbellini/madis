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
3. Periodically, the **Anchor Service** ([`apps/anchor-service`](../../apps/anchor-service)) scans for records that have not yet been anchored, re-validates every signature, computes the leaves, and builds the Merkle Tree.
4. If any record's signature is found to be inconsistent, the Anchor emits a `signature_mismatch` alert in the `integrity_alerts` table and excludes the record from the batch.
5. The resulting Merkle Root is sent to the [`MerkleAnchorRegistry.sol`](../../apps/integrity-domain/contracts/MerkleAnchorRegistry.sol) smart contract via a write transaction signed by the Anchor's wallet.
6. Once the block is confirmed on the blockchain, the batch's status in `batches` is updated to `confirmed`, and each record's individual proof (_Merkle Proof_) is saved in `anchor_records`.

### Flow 2: Continuous Auditing and Fraud Detection

1. The **Monitor Service** ([`apps/monitor-service`](../../apps/monitor-service)) runs cyclically, independently of the Anchor.
2. For each already-confirmed batch, the Monitor retrieves the original data from the relational database and recomputes the leaves and the Merkle Root using the same cryptographic logic.
3. The Monitor performs a gas-free read query (`eth_call`) against the smart contract's `containsMerkleRoot` method.
4. If the locally recomputed root **does not exist** on the blockchain, it is concluded that at least one record in the batch was tampered with after anchoring. The Monitor emits a `root_divergence` alert and triggers the **Drill-Down** procedure.
5. In the Drill-Down, the Monitor uses each record's individual `merkle_proof` saved in `anchor_records` to test each record in isolation against the legitimate root on the blockchain, emitting `record_tampered` alerts and pinpointing exactly which record was violated.

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
- `alert_type` (`VARCHAR(30) NOT NULL`): Incident type: `'signature_mismatch'` | `'root_divergence'` | `'record_tampered'`.
- `source` (`VARCHAR(20) NOT NULL`): Detection source: `'anchor'` | `'monitor'`.
- `batch_id` (`BIGINT NULL FK -> batches.id`): Affected batch (if applicable).
- `record_id` (`BIGINT NULL FK -> records.id`): Identified tampered record (in the case of _drill-down_).
- `expected_root` (`TEXT NULL`): Legitimate root registered on the blockchain.
- `actual_root` (`TEXT NULL`): Spurious root recomputed locally.
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

To guarantee collision resistance and interoperability with Solidity and the EVM ABI standard, the tree's leaf is computed via `AbiCoder.defaultAbiCoder().encode(["string", "bytes32", "string"], [id, dataHash, signature])`:

$$L_i = \text{Keccak256}\Big(\text{abi.encode}\big([\text{"string"}, \text{"bytes32"}, \text{"string"}], [id_i, \text{dataHash}_i, \text{signature}_i]\big)\Big)$$

### 5.3. Merkle Tree with Sorted Pairs

Tree construction follows the OpenZeppelin ecosystem's standard specification (`@openzeppelin/merkle-tree` and `MerkleProof.sol`):

- When combining two child nodes $A$ and $B$, the hashes are sorted lexicographically before concatenation:
  $$H(A, B) = \text{Keccak256}\big(\min(A, B) \parallel \max(A, B)\big)$$
- **Advantage:** Proof verification becomes completely independent of the leaf's original position in the tree, dispensing with metadata such as `leaf_index`.

---

## 6. Background Services (Jobs)

### 6.1. Anchoring Daemon (`apps/anchor-service`)

Batch process executed periodically (e.g. every 1 to 3 hours):

1. **Scan:** Fetches records in `records` that do not yet have an associated entry in `anchor_records`.
2. **Prior Validation:** Checks whether the digital signature matches the signer and the data. If invalid, emits a `signature_mismatch` alert and discards the record from the batch.
3. **Tree Construction:** Generates the leaves $L_i$, computes the Merkle Root, and extracts the `merkle_proof` for each leaf.
4. **On-Chain Transaction:** Invokes `MerkleAnchorRegistry.addMerkleRoot(root, batchSize)` on the decentralized network.
5. **Batch Persistence:** Inserts the batch's records into the `batches` table and persists the individual proofs in `anchor_records`.

### 6.2. Integrity Monitor (`apps/monitor-service`)

Continuous audit process executed at high frequency (e.g. every 5 to 15 minutes):

1. **Retrieval:** Selects confirmed batches from the `batches` table.
2. **Independent Reconstruction:** Retrieves the raw records in `records` and rebuilds the Merkle Root from the database's data.
3. **On-Chain Integrity Check:** Performs a zero-gas-cost `eth_call` against the `containsMerkleRoot(reconstructedRoot)` method.
4. **Inconsistency Handling:** If the root diverges from the blockchain:
   - Emits a `root_divergence` alert for the batch in `integrity_alerts`.
   - Executes the individual **Drill-Down** procedure.

---

## 7. Alerting Strategy and Drill-Down Procedure

When a divergence is detected at the batch level, the Monitor doesn't just flag the batch as fraudulent — it individually identifies which records were tampered with:

```text
[Divergent Batch Detected]
         │
         ▼
[1. Emits Alert: root_divergence (batch_id)]
         │
         ▼
[2. Runs Drill-Down record by record]
   For each record in the batch:
     a. Recomputes leaf Li from the current data in records
     b. Retrieves the merkle_proof saved in anchor_records
     c. Validates: verifyMerkleProof(merkle_proof, blockchainRoot, Li)
     d. If it FAILS ──> [Emits Alert: record_tampered (batch_id, record_id)]
```

### Adversarial Security Property of the Drill-Down:

Even if the attacker has altered the `merkle_proof` or the batch's data in the relational database, the reference root used in the verification test is always the immutable root obtained from the **Blockchain**, making it computationally infeasible for the attacker to forge a false proof that validates tampered data.

---

## 8. Smart Contract ([`MerkleAnchorRegistry.sol`](../../apps/integrity-domain/contracts/MerkleAnchorRegistry.sol))

The smart contract acts as the system's public integrity anchor. It is developed in Solidity (^0.8.28) using OpenZeppelin's reference libraries (`Ownable`, `MerkleProof`).

### Main Methods:

- `addMerkleRoot(bytes32 _root, uint256 _batchSize) external onlyOwner returns (uint256)`: Registers a new Merkle Root and emits the `RootAdded` event. Guarantees uniqueness and prevents registering null roots.
- `containsMerkleRoot(bytes32 _root) public view returns (bool)`: $O(1)$ existence check with no gas cost.
- `getMerkleRootAt(uint256 _index) external view returns (bytes32)`: Historical lookup by sequential index.
- `getLatestMerkleRoot() external view returns (bytes32)`: Returns the most recently registered root.
- `getRootCount() external view returns (uint256)`: Returns the total number of anchored batches.
- `getMerkleRootsPaged(uint256 _offset, uint256 _limit) external view returns (bytes32[] memory)`: Enables efficient pagination of the root history for off-chain synchronization.
- `verifyMerkleProof(bytes32 _root, bytes32[] calldata _proof, bytes32 _leaf) external view returns (bool)`: Validates a cryptographic proof directly against a root registered on the contract.
