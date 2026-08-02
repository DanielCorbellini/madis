-- =============================================================================
-- PostgreSQL user setup for append-only enforcement
-- =============================================================================
--
-- The system uses two database users with distinct permissions:
--
--   app_user   → Used by the API and jobs in production.
--                Can only INSERT and SELECT on records, anchor_records,
--                and integrity_alerts. Can UPDATE on batches (required
--                to transition lifecycle status).
--                This enforces append-only at the database level: even if
--                a bug in the application attempts UPDATE/DELETE on records,
--                Postgres rejects the operation.
--
--   admin_user → Full access. Used in two scenarios:
--                1. Tamper testing — simulates a privileged attacker who
--                   performs UPDATE/DELETE directly on records, which is
--                   exactly the scenario the system must detect.
--                2. Maintenance — migrations, fixes, DDL.
--
-- To run this script, connect as superuser (e.g., postgres).
-- Replace passwords before executing.
-- =============================================================================

-- ---------------------
-- 1. Create users
-- ---------------------

CREATE USER app_user WITH PASSWORD 'CHANGE_APP_PASSWORD';
CREATE USER admin_user WITH PASSWORD 'CHANGE_ADMIN_PASSWORD';

-- ---------------------
-- 2. app_user — restricted access (append-only for records)
-- ---------------------

-- records: INSERT and SELECT only (append-only)
GRANT SELECT, INSERT ON "records" TO app_user;

-- batches: INSERT, SELECT and UPDATE (needs to transition status)
GRANT SELECT, INSERT, UPDATE ON "batches" TO app_user;

-- anchor_records: INSERT and SELECT only
GRANT SELECT, INSERT ON "anchor_records" TO app_user;

-- integrity_alerts: INSERT and SELECT only
GRANT SELECT, INSERT ON "integrity_alerts" TO app_user;

-- Sequences: required for BIGSERIAL INSERT to work
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- ---------------------
-- 3. admin_user — full access (tamper testing + maintenance)
-- ---------------------

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO admin_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO admin_user;
