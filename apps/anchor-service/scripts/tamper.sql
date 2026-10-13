-- =============================================================================
-- Raw SQL reference for apps/anchor-service/scripts/tamper.ts
-- =============================================================================
-- Same statements the CLI runs, as copy-pasteable psql. Connect as admin_user
-- (see db/setup-users.sql) before running any of these:
--
--   psql "$ADMIN_DATABASE_URL"
--
-- Replace the bracketed placeholders before running.
-- =============================================================================
-- --- Scenario 1/2: edit a records column (payload shown; swap the column and
-- --- cast for client_address/version/replaces/is_deleted/signature/created_at) ---
UPDATE records
SET
    payload = '[JSON payload]'::jsonb
WHERE
    id = [record id];

UPDATE records
SET
    client_address = '[0x + 40 hex chars]'
WHERE
    id = [record id];

-- Forge version / replaces (replaces: pick any other existing record id)
UPDATE records
SET
    version = [version]
WHERE
    id = [record id];

UPDATE records
SET
    replaces = [other record id]
WHERE
    id = [record id];

-- --- Scenario 3: delete an already-anchored record (pin first: the
-- --- anchor_records FK to records is RESTRICT) ---
DELETE FROM anchor_records
WHERE
    record_id = [record id];

DELETE FROM records
WHERE
    id = [record id];

-- --- Scenario 4: delete only the anchor_records pin, record untouched ---
DELETE FROM anchor_records
WHERE
    record_id = [record id];

-- --- Scenario 5: delete an entire batch (children first, FK-safe order) ---
DELETE FROM anchor_records
WHERE
    batch_id = [batch id];

DELETE FROM batches
WHERE
    id = [batch id];

-- --- Scenario 6: corrupt batches.merkle_root only (expected: no alert — monitor
-- --- never reads this column after confirmation, see audit.ts) ---
UPDATE batches
SET
    merkle_root = '[fake 0x + 64 hex chars]'
WHERE
    id = [batch id];

-- --- Scenario 7: corrupt a stored merkle_proof, record data untouched ---
UPDATE anchor_records
SET
    merkle_proof = '[JSON array of 0x-hex strings]'::jsonb
WHERE
    record_id = [record id];

-- --- Scenario 8: forge a fake 'submitted' batch, no real transaction ever sent ---
INSERT INTO
    batches (status, merkle_root, size, transaction_hash)
VALUES
    (
        'submitted',
        '[fake 0x + 64 hex chars]',
        [record count],
        '[fake 0x + 64 hex chars]'
    )
RETURNING
    id;

-- --- Scenario 9: delete a record BEFORE it's ever anchored (expected: not
-- --- detected — acknowledged blind spot, anchor-service Phase 1 only scans
-- --- rows that still exist) ---
DELETE FROM records
WHERE
    id = [record id]
    AND id NOT IN (
        SELECT
            record_id
        FROM
            anchor_records
    );

-- --- Scenario 11: signature/whitelist rejection at anchor time — seed a record
-- --- signed by a non-whitelisted address, or corrupt its signature before its
-- --- first anchor-service scan (i.e. before it has any anchor_records pin) ---
UPDATE records
SET
    signature = '[garbage signature]'
WHERE
    id = [record id]
    AND id NOT IN (
        SELECT
            record_id
        FROM
            anchor_records
    );

-- --- Scenario 12: inject a forged record AND a forged pin into a confirmed batch
-- --- (the "extra member" direction: pin count ends one above the on-chain size).
-- --- One transaction, so anchor-service never sees the forged record unpinned.
-- --- app_user already has INSERT on both tables; no admin privilege needed. ---
BEGIN;

WITH next_id AS (
    SELECT
        nextval('records_id_seq') AS id
),
new_record AS (
    INSERT INTO
        records (id, entity_id, record_type, payload, version, client_address, signature)
    SELECT
        id,
        id,
        'prescription',
        '{"forged": true}'::jsonb,
        1,
        '[0x + 40 hex chars, e.g. the whitelisted address]',
        '[any signature text]'
    FROM
        next_id
    RETURNING
        id
)
INSERT INTO
    anchor_records (record_id, batch_id, merkle_proof)
SELECT
    id,
    [batch id],
    '["0x[64 hex chars]"]'::jsonb
FROM
    new_record
RETURNING
    record_id;

COMMIT;

-- --- Scenario 13: flip a confirmed batch to 'submitted' and delete one of its
-- --- records (note the batch's merkle_root and transaction_hash first) ---
BEGIN;

UPDATE batches
SET
    status = 'submitted'
WHERE
    id = [batch id];

DELETE FROM anchor_records
WHERE
    record_id = [record id];

DELETE FROM records
WHERE
    id = [record id];

COMMIT;

-- 13b (transaction_hash alone does NOT stop the heal: Phase 0 finds the root
-- on-chain via merkle_root first). 13c: also corrupt merkle_root so
-- anchor-service can neither find the root nor reach a transaction to inspect.
UPDATE batches
SET
    transaction_hash = NULL,
    merkle_root = '[fake 0x + 64 hex chars]'
WHERE
    id = [batch id];

-- --- Read-only: check what fired ---
SELECT
    *
FROM
    integrity_alerts
ORDER BY
    detected_at DESC
LIMIT
    5;

SELECT
    id,
    status,
    merkle_root,
    size
FROM
    batches
ORDER BY
    created_at DESC
LIMIT
    5;