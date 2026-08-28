-- =============================================================================
-- Sample data for local development and demos
-- =============================================================================
--
-- Loaded automatically by docker-entrypoint-initdb.d (see docker-compose.yml),
-- which only runs its scripts against a genuinely empty Postgres data volume.
-- So this file re-populates automatically every time the postgres container
-- is recreated from scratch (e.g. after `docker compose down -v`) — no
-- manual step needed.
--
-- Only "records" is seeded. "batches"/"anchor_records"/"integrity_alerts"
-- stay empty on purpose: nothing has actually anchored these rows to the
-- blockchain, so pretending otherwise here would be misleading — that data
-- belongs to anchor-service's domain once it exists, not this file's.
--
-- These rows are inserted directly via SQL, bypassing the data-domain API
-- entirely, so every "signature" value below is a placeholder string — it
-- does NOT cryptographically verify against its "payload" the way a real
-- client-signed request's signature would. Don't use this file as a
-- signature-verification fixture.
--
-- Shape: for each record_type (prescription, emr_encounter) —
--   20 entities with a single version (the common case)
--    3 entities with a 2-version correction history
--    1 entity  with a 3-version correction history
--    1 entity  with 2 versions, the second a soft-delete
-- => 25 entities / 31 rows per type, 50 entities / 62 rows total.

-- -----------------------------------------------------------------------------
-- Prescriptions — 20 single-version entities
-- -----------------------------------------------------------------------------

INSERT INTO "records" (id, entity_id, record_type, payload, version, client_address, signature)
SELECT
    minted.id,
    minted.id,
    'prescription',
    jsonb_build_object(
        'patientId', 'PAT-' || lpad((10000 + minted.n)::text, 5, '0'),
        'medication', (ARRAY['Amoxicillin 500mg', 'Ibuprofen 400mg', 'Metformin 850mg', 'Losartan 50mg', 'Omeprazole 20mg'])[1 + (minted.n % 5)],
        'dosage', (ARRAY['1 capsule every 8 hours', '1 tablet twice daily', '1 tablet once daily'])[1 + (minted.n % 3)],
        'durationDays', 5 + (minted.n % 10),
        'prescribingPhysician', (ARRAY['Dr. Ana Souza', 'Dr. Carlos Lima', 'Dr. Beatriz Rocha', 'Dr. Felipe Alves'])[1 + (minted.n % 4)],
        'issuedAt', (DATE '2026-01-01' + (minted.n || ' days')::interval)::date
    ),
    1,
    '0x1111111111111111111111111111111111111111',
    'seed-data-unsigned-signature'
FROM (
    SELECT nextval('records_id_seq') AS id, n
    FROM generate_series(1, 20) AS n
) minted;

-- -----------------------------------------------------------------------------
-- Prescriptions — 3 entities with a 2-version correction history
-- -----------------------------------------------------------------------------

-- PAT-20001: dosage corrected after the patient reported side effects.
WITH next_id AS (
    SELECT nextval('records_id_seq') AS id
), v1 AS (
    INSERT INTO "records" (id, entity_id, record_type, payload, version, client_address, signature)
    SELECT
        id, id, 'prescription',
        jsonb_build_object('patientId', 'PAT-20001', 'medication', 'Ibuprofen 400mg', 'dosage', '1 tablet three times daily', 'durationDays', 5, 'prescribingPhysician', 'Dr. Ana Souza', 'issuedAt', DATE '2026-02-01'),
        1, '0x1111111111111111111111111111111111111111', 'seed-data-unsigned-signature'
    FROM next_id
    RETURNING id, entity_id
)
INSERT INTO "records" (entity_id, record_type, payload, version, replaces, client_address, signature)
SELECT
    entity_id, 'prescription',
    jsonb_build_object('patientId', 'PAT-20001', 'medication', 'Ibuprofen 400mg', 'dosage', '1 tablet twice daily', 'durationDays', 5, 'prescribingPhysician', 'Dr. Ana Souza', 'issuedAt', DATE '2026-02-01'),
    2, id, '0x1111111111111111111111111111111111111111', 'seed-data-unsigned-signature'
FROM v1;

-- PAT-20002: reassigned to a different physician.
WITH next_id AS (
    SELECT nextval('records_id_seq') AS id
), v1 AS (
    INSERT INTO "records" (id, entity_id, record_type, payload, version, client_address, signature)
    SELECT
        id, id, 'prescription',
        jsonb_build_object('patientId', 'PAT-20002', 'medication', 'Metformin 850mg', 'dosage', '1 tablet twice daily', 'durationDays', 30, 'prescribingPhysician', 'Dr. Carlos Lima', 'issuedAt', DATE '2026-02-03'),
        1, '0x1111111111111111111111111111111111111111', 'seed-data-unsigned-signature'
    FROM next_id
    RETURNING id, entity_id
)
INSERT INTO "records" (entity_id, record_type, payload, version, replaces, client_address, signature)
SELECT
    entity_id, 'prescription',
    jsonb_build_object('patientId', 'PAT-20002', 'medication', 'Metformin 850mg', 'dosage', '1 tablet twice daily', 'durationDays', 30, 'prescribingPhysician', 'Dr. Beatriz Rocha', 'issuedAt', DATE '2026-02-03'),
    2, id, '0x1111111111111111111111111111111111111111', 'seed-data-unsigned-signature'
FROM v1;

-- PAT-20003: treatment extended by two weeks.
WITH next_id AS (
    SELECT nextval('records_id_seq') AS id
), v1 AS (
    INSERT INTO "records" (id, entity_id, record_type, payload, version, client_address, signature)
    SELECT
        id, id, 'prescription',
        jsonb_build_object('patientId', 'PAT-20003', 'medication', 'Losartan 50mg', 'dosage', '1 tablet once daily', 'durationDays', 14, 'prescribingPhysician', 'Dr. Felipe Alves', 'issuedAt', DATE '2026-02-05'),
        1, '0x1111111111111111111111111111111111111111', 'seed-data-unsigned-signature'
    FROM next_id
    RETURNING id, entity_id
)
INSERT INTO "records" (entity_id, record_type, payload, version, replaces, client_address, signature)
SELECT
    entity_id, 'prescription',
    jsonb_build_object('patientId', 'PAT-20003', 'medication', 'Losartan 50mg', 'dosage', '1 tablet once daily', 'durationDays', 28, 'prescribingPhysician', 'Dr. Felipe Alves', 'issuedAt', DATE '2026-02-05'),
    2, id, '0x1111111111111111111111111111111111111111', 'seed-data-unsigned-signature'
FROM v1;

-- -----------------------------------------------------------------------------
-- Prescriptions — 1 entity with a 3-version correction history
-- -----------------------------------------------------------------------------

-- PAT-20004: dosage escalated twice across follow-up visits.
WITH next_id AS (
    SELECT nextval('records_id_seq') AS id
), v1 AS (
    INSERT INTO "records" (id, entity_id, record_type, payload, version, client_address, signature)
    SELECT
        id, id, 'prescription',
        jsonb_build_object('patientId', 'PAT-20004', 'medication', 'Omeprazole 20mg', 'dosage', '1 capsule once daily', 'durationDays', 30, 'prescribingPhysician', 'Dr. Ana Souza', 'issuedAt', DATE '2026-02-10'),
        1, '0x1111111111111111111111111111111111111111', 'seed-data-unsigned-signature'
    FROM next_id
    RETURNING id, entity_id
), v2 AS (
    INSERT INTO "records" (entity_id, record_type, payload, version, replaces, client_address, signature)
    SELECT
        entity_id, 'prescription',
        jsonb_build_object('patientId', 'PAT-20004', 'medication', 'Omeprazole 40mg', 'dosage', '1 capsule once daily', 'durationDays', 30, 'prescribingPhysician', 'Dr. Ana Souza', 'issuedAt', DATE '2026-02-10'),
        2, id, '0x1111111111111111111111111111111111111111', 'seed-data-unsigned-signature'
    FROM v1
    RETURNING id, entity_id
)
INSERT INTO "records" (entity_id, record_type, payload, version, replaces, client_address, signature)
SELECT
    entity_id, 'prescription',
    jsonb_build_object('patientId', 'PAT-20004', 'medication', 'Omeprazole 40mg', 'dosage', '1 capsule twice daily', 'durationDays', 30, 'prescribingPhysician', 'Dr. Ana Souza', 'issuedAt', DATE '2026-02-10'),
    3, id, '0x1111111111111111111111111111111111111111', 'seed-data-unsigned-signature'
FROM v2;

-- -----------------------------------------------------------------------------
-- Prescriptions — 1 entity with a 2-version history, soft-deleted
-- -----------------------------------------------------------------------------

-- PAT-20005: prescription voided after being issued in error.
WITH next_id AS (
    SELECT nextval('records_id_seq') AS id
), v1 AS (
    INSERT INTO "records" (id, entity_id, record_type, payload, version, client_address, signature)
    SELECT
        id, id, 'prescription',
        jsonb_build_object('patientId', 'PAT-20005', 'medication', 'Amoxicillin 500mg', 'dosage', '1 capsule every 8 hours', 'durationDays', 7, 'prescribingPhysician', 'Dr. Carlos Lima', 'issuedAt', DATE '2026-02-12'),
        1, '0x1111111111111111111111111111111111111111', 'seed-data-unsigned-signature'
    FROM next_id
    RETURNING id, entity_id
)
INSERT INTO "records" (entity_id, record_type, payload, version, replaces, is_deleted, client_address, signature)
SELECT
    entity_id, 'prescription',
    jsonb_build_object('reason', 'Issued to the wrong patient record'),
    2, id, TRUE, '0x1111111111111111111111111111111111111111', 'seed-data-unsigned-signature'
FROM v1;

-- -----------------------------------------------------------------------------
-- EMR encounters — 20 single-version entities
-- -----------------------------------------------------------------------------

INSERT INTO "records" (id, entity_id, record_type, payload, version, client_address, signature)
SELECT
    minted.id,
    minted.id,
    'emr_encounter',
    jsonb_build_object(
        'patientId', 'PAT-' || lpad((30000 + minted.n)::text, 5, '0'),
        'encounterType', (ARRAY['outpatient_visit', 'emergency_visit', 'follow_up', 'telemedicine'])[1 + (minted.n % 4)],
        'chiefComplaint', (ARRAY['Persistent cough', 'Lower back pain', 'Headache', 'Shortness of breath', 'Abdominal pain'])[1 + (minted.n % 5)],
        'diagnosis', (ARRAY['Acute bronchitis', 'Lumbar strain', 'Tension headache', 'Mild asthma exacerbation', 'Gastritis'])[1 + (minted.n % 5)],
        'physician', (ARRAY['Dr. Carlos Lima', 'Dr. Beatriz Rocha', 'Dr. Felipe Alves', 'Dr. Ana Souza'])[1 + (minted.n % 4)],
        'visitDate', (DATE '2026-01-01' + (minted.n || ' days')::interval)::date
    ),
    1,
    '0x2222222222222222222222222222222222222222',
    'seed-data-unsigned-signature'
FROM (
    SELECT nextval('records_id_seq') AS id, n
    FROM generate_series(1, 20) AS n
) minted;

-- -----------------------------------------------------------------------------
-- EMR encounters — 3 entities with a 2-version correction history
-- -----------------------------------------------------------------------------

-- PAT-40001: diagnosis refined after lab results came back.
WITH next_id AS (
    SELECT nextval('records_id_seq') AS id
), v1 AS (
    INSERT INTO "records" (id, entity_id, record_type, payload, version, client_address, signature)
    SELECT
        id, id, 'emr_encounter',
        jsonb_build_object('patientId', 'PAT-40001', 'encounterType', 'outpatient_visit', 'chiefComplaint', 'Persistent cough', 'diagnosis', 'Suspected bronchitis (pending labs)', 'physician', 'Dr. Carlos Lima', 'visitDate', DATE '2026-02-01'),
        1, '0x2222222222222222222222222222222222222222', 'seed-data-unsigned-signature'
    FROM next_id
    RETURNING id, entity_id
)
INSERT INTO "records" (entity_id, record_type, payload, version, replaces, client_address, signature)
SELECT
    entity_id, 'emr_encounter',
    jsonb_build_object('patientId', 'PAT-40001', 'encounterType', 'outpatient_visit', 'chiefComplaint', 'Persistent cough', 'diagnosis', 'Acute bronchitis', 'physician', 'Dr. Carlos Lima', 'visitDate', DATE '2026-02-01'),
    2, id, '0x2222222222222222222222222222222222222222', 'seed-data-unsigned-signature'
FROM v1;

-- PAT-40002: reassigned to a different physician after referral.
WITH next_id AS (
    SELECT nextval('records_id_seq') AS id
), v1 AS (
    INSERT INTO "records" (id, entity_id, record_type, payload, version, client_address, signature)
    SELECT
        id, id, 'emr_encounter',
        jsonb_build_object('patientId', 'PAT-40002', 'encounterType', 'follow_up', 'chiefComplaint', 'Lower back pain', 'diagnosis', 'Lumbar strain', 'physician', 'Dr. Beatriz Rocha', 'visitDate', DATE '2026-02-03'),
        1, '0x2222222222222222222222222222222222222222', 'seed-data-unsigned-signature'
    FROM next_id
    RETURNING id, entity_id
)
INSERT INTO "records" (entity_id, record_type, payload, version, replaces, client_address, signature)
SELECT
    entity_id, 'emr_encounter',
    jsonb_build_object('patientId', 'PAT-40002', 'encounterType', 'follow_up', 'chiefComplaint', 'Lower back pain', 'diagnosis', 'Lumbar strain', 'physician', 'Dr. Felipe Alves', 'visitDate', DATE '2026-02-03'),
    2, id, '0x2222222222222222222222222222222222222222', 'seed-data-unsigned-signature'
FROM v1;

-- PAT-40003: encounter type corrected (was logged as in-person, was actually telemedicine).
WITH next_id AS (
    SELECT nextval('records_id_seq') AS id
), v1 AS (
    INSERT INTO "records" (id, entity_id, record_type, payload, version, client_address, signature)
    SELECT
        id, id, 'emr_encounter',
        jsonb_build_object('patientId', 'PAT-40003', 'encounterType', 'outpatient_visit', 'chiefComplaint', 'Headache', 'diagnosis', 'Tension headache', 'physician', 'Dr. Ana Souza', 'visitDate', DATE '2026-02-05'),
        1, '0x2222222222222222222222222222222222222222', 'seed-data-unsigned-signature'
    FROM next_id
    RETURNING id, entity_id
)
INSERT INTO "records" (entity_id, record_type, payload, version, replaces, client_address, signature)
SELECT
    entity_id, 'emr_encounter',
    jsonb_build_object('patientId', 'PAT-40003', 'encounterType', 'telemedicine', 'chiefComplaint', 'Headache', 'diagnosis', 'Tension headache', 'physician', 'Dr. Ana Souza', 'visitDate', DATE '2026-02-05'),
    2, id, '0x2222222222222222222222222222222222222222', 'seed-data-unsigned-signature'
FROM v1;

-- -----------------------------------------------------------------------------
-- EMR encounters — 1 entity with a 3-version correction history
-- -----------------------------------------------------------------------------

-- PAT-40004: diagnosis escalated as symptoms were reassessed across visits.
WITH next_id AS (
    SELECT nextval('records_id_seq') AS id
), v1 AS (
    INSERT INTO "records" (id, entity_id, record_type, payload, version, client_address, signature)
    SELECT
        id, id, 'emr_encounter',
        jsonb_build_object('patientId', 'PAT-40004', 'encounterType', 'emergency_visit', 'chiefComplaint', 'Shortness of breath', 'diagnosis', 'Under evaluation', 'physician', 'Dr. Carlos Lima', 'visitDate', DATE '2026-02-10'),
        1, '0x2222222222222222222222222222222222222222', 'seed-data-unsigned-signature'
    FROM next_id
    RETURNING id, entity_id
), v2 AS (
    INSERT INTO "records" (entity_id, record_type, payload, version, replaces, client_address, signature)
    SELECT
        entity_id, 'emr_encounter',
        jsonb_build_object('patientId', 'PAT-40004', 'encounterType', 'emergency_visit', 'chiefComplaint', 'Shortness of breath', 'diagnosis', 'Mild asthma exacerbation', 'physician', 'Dr. Carlos Lima', 'visitDate', DATE '2026-02-10'),
        2, id, '0x2222222222222222222222222222222222222222', 'seed-data-unsigned-signature'
    FROM v1
    RETURNING id, entity_id
)
INSERT INTO "records" (entity_id, record_type, payload, version, replaces, client_address, signature)
SELECT
    entity_id, 'emr_encounter',
    jsonb_build_object('patientId', 'PAT-40004', 'encounterType', 'emergency_visit', 'chiefComplaint', 'Shortness of breath', 'diagnosis', 'Moderate asthma exacerbation, admitted for observation', 'physician', 'Dr. Carlos Lima', 'visitDate', DATE '2026-02-10'),
    3, id, '0x2222222222222222222222222222222222222222', 'seed-data-unsigned-signature'
FROM v2;

-- -----------------------------------------------------------------------------
-- EMR encounters — 1 entity with a 2-version history, soft-deleted
-- -----------------------------------------------------------------------------

-- PAT-40005: encounter logged for the wrong patient, then voided.
WITH next_id AS (
    SELECT nextval('records_id_seq') AS id
), v1 AS (
    INSERT INTO "records" (id, entity_id, record_type, payload, version, client_address, signature)
    SELECT
        id, id, 'emr_encounter',
        jsonb_build_object('patientId', 'PAT-40005', 'encounterType', 'outpatient_visit', 'chiefComplaint', 'Abdominal pain', 'diagnosis', 'Gastritis', 'physician', 'Dr. Felipe Alves', 'visitDate', DATE '2026-02-12'),
        1, '0x2222222222222222222222222222222222222222', 'seed-data-unsigned-signature'
    FROM next_id
    RETURNING id, entity_id
)
INSERT INTO "records" (entity_id, record_type, payload, version, replaces, is_deleted, client_address, signature)
SELECT
    entity_id, 'emr_encounter',
    jsonb_build_object('reason', 'Logged under the wrong patient record'),
    2, id, TRUE, '0x2222222222222222222222222222222222222222', 'seed-data-unsigned-signature'
FROM v1;
