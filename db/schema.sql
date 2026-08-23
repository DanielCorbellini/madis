-- =============================================================================
-- Schema: Data Integrity System via Merkle Tree + Blockchain
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. records — Business data + authorship (append-only)
--
--    No row is modified after insertion. Updates and deletions are represented
--    as new records (replaces → previous record).
-- -----------------------------------------------------------------------------

CREATE TABLE "records" (
    "id"              BIGSERIAL       NOT NULL,
    "entity_id"       BIGINT          NOT NULL,
    "record_type"     VARCHAR(20)     NOT NULL,
    "payload"         JSONB           NOT NULL,
    "version"         INTEGER         NOT NULL DEFAULT 1,
    "is_deleted"      BOOLEAN         NOT NULL DEFAULT FALSE,
    "replaces"        BIGINT          NULL,
    "client_address"  CHAR(42)        NOT NULL,
    "signature"       TEXT            NOT NULL,
    "created_at"      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

ALTER TABLE "records"
    ADD CONSTRAINT "records_pkey"
        PRIMARY KEY ("id");

ALTER TABLE "records"
    ADD CONSTRAINT "records_replaces_fkey"
        FOREIGN KEY ("replaces") REFERENCES "records" ("id");

ALTER TABLE "records"
    ADD CONSTRAINT "records_no_self_reference"
        CHECK ("replaces" IS NULL OR "replaces" <> "id");

ALTER TABLE "records"
    ADD CONSTRAINT "records_replace_requires_version_gt1"
        CHECK ("replaces" IS NULL OR "version" > 1);

ALTER TABLE "records"
    ADD CONSTRAINT "records_original_requires_version_1"
        CHECK ("replaces" IS NOT NULL OR "version" = 1);

ALTER TABLE "records"
    ADD CONSTRAINT "records_record_type_check"
        CHECK ("record_type" IN ('prescription', 'emr_encounter'));

ALTER TABLE "records"
    ADD CONSTRAINT "records_type_entity_version_unique"
        UNIQUE ("record_type", "entity_id", "version");

CREATE INDEX "idx_records_replaces"
    ON "records" ("replaces");

CREATE INDEX "idx_records_created_at"
    ON "records" ("created_at");

CREATE INDEX "idx_records_record_type"
    ON "records" ("record_type");

-- -----------------------------------------------------------------------------
-- 2. batches — Anchoring lifecycle
--
--    Lifecycle: pending → submitted → confirmed / failed
--    Failed batches can be retried (failed → submitted).
-- -----------------------------------------------------------------------------

CREATE TABLE "batches" (
    "id"                BIGSERIAL       NOT NULL,
    "status"            VARCHAR(20)     NOT NULL DEFAULT 'pending',
    "merkle_root"       CHAR(66)        NOT NULL,
    "size"              INTEGER         NOT NULL,
    "transaction_hash"  CHAR(66)        NULL,
    "block_number"      BIGINT          NULL,
    "block_timestamp"   TIMESTAMPTZ     NULL,
    "retry_count"       INTEGER         NOT NULL DEFAULT 0,
    "error_message"     TEXT            NULL,
    "created_at"        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    "confirmed_at"      TIMESTAMPTZ     NULL
);

ALTER TABLE "batches"
    ADD CONSTRAINT "batches_pkey"
        PRIMARY KEY ("id");

ALTER TABLE "batches"
    ADD CONSTRAINT "batches_status_check"
        CHECK ("status" IN ('pending', 'submitted', 'confirmed', 'failed'));

ALTER TABLE "batches"
    ADD CONSTRAINT "batches_retry_count_check"
        CHECK ("retry_count" >= 0);

CREATE INDEX "idx_batches_status"
    ON "batches" ("status");

CREATE INDEX "idx_batches_created_at"
    ON "batches" ("created_at");

-- -----------------------------------------------------------------------------
-- 3. anchor_records — Bridge between records and batches
--
--    Links each record to the batch that anchored it. Each record is anchored
--    exactly once (UNIQUE on record_id).
-- -----------------------------------------------------------------------------

CREATE TABLE "anchor_records" (
    "id"            BIGSERIAL       NOT NULL,
    "record_id"     BIGINT          NOT NULL,
    "batch_id"      BIGINT          NOT NULL,
    "merkle_proof"  JSONB           NOT NULL,
    "anchored_at"   TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

ALTER TABLE "anchor_records"
    ADD CONSTRAINT "anchor_records_pkey"
        PRIMARY KEY ("id");

ALTER TABLE "anchor_records"
    ADD CONSTRAINT "anchor_records_record_id_fkey"
        FOREIGN KEY ("record_id") REFERENCES "records" ("id");

ALTER TABLE "anchor_records"
    ADD CONSTRAINT "anchor_records_batch_id_fkey"
        FOREIGN KEY ("batch_id") REFERENCES "batches" ("id");

ALTER TABLE "anchor_records"
    ADD CONSTRAINT "anchor_records_record_id_unique"
        UNIQUE ("record_id");

CREATE INDEX "idx_anchor_records_batch"
    ON "anchor_records" ("batch_id");

-- -----------------------------------------------------------------------------
-- 4. integrity_alerts — Incident log
--
--    Immutable log of anomalies detected by the anchoring and monitoring jobs.
--    alert_type: 'signature_mismatch' | 'root_divergence' | 'record_tampered'
--    source:     'anchor' | 'monitor'
-- -----------------------------------------------------------------------------

CREATE TABLE "integrity_alerts" (
    "id"              BIGSERIAL       NOT NULL,
    "alert_type"      VARCHAR(30)     NOT NULL,
    "source"          VARCHAR(20)     NOT NULL,
    "batch_id"        BIGINT          NULL,
    "record_id"       BIGINT          NULL,
    "expected_root"   TEXT            NULL,
    "actual_root"     TEXT            NULL,
    "details"         TEXT            NULL,
    "detected_at"     TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

ALTER TABLE "integrity_alerts"
    ADD CONSTRAINT "integrity_alerts_pkey"
        PRIMARY KEY ("id");

ALTER TABLE "integrity_alerts"
    ADD CONSTRAINT "integrity_alerts_batch_id_fkey"
        FOREIGN KEY ("batch_id") REFERENCES "batches" ("id");

ALTER TABLE "integrity_alerts"
    ADD CONSTRAINT "integrity_alerts_record_id_fkey"
        FOREIGN KEY ("record_id") REFERENCES "records" ("id");

ALTER TABLE "integrity_alerts"
    ADD CONSTRAINT "integrity_alerts_source_check"
        CHECK ("source" IN ('anchor', 'monitor'));

CREATE INDEX "idx_alerts_batch"
    ON "integrity_alerts" ("batch_id");

CREATE INDEX "idx_alerts_type"
    ON "integrity_alerts" ("alert_type");

CREATE INDEX "idx_alerts_detected_at"
    ON "integrity_alerts" ("detected_at");
