-- ============================================================================
-- AutoSharePics — Schema Hardening Migration (additive, non-destructive)
-- ============================================================================
-- Runs after 001_schema.sql on first boot, OR can be applied to an existing
-- DB by piping it through psql:
--   docker compose exec -T app-postgres \
--     psql -U $APP_DB_USER -d $APP_DB_NAME < db/init/002_migrations.sql
--
-- This file is idempotent — safe to re-run.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. Migration tracking
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     VARCHAR(50)  PRIMARY KEY,
    applied_at  TIMESTAMPTZ  DEFAULT NOW(),
    description TEXT
);

INSERT INTO schema_migrations (version, description)
VALUES ('002_hardening', 'Constraints, soft delete, GDPR, idempotency, FK behavior')
ON CONFLICT (version) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 1. friends_contacts: enums via CHECK, soft delete, GDPR fields
-- ----------------------------------------------------------------------------
ALTER TABLE friends_contacts
    DROP CONSTRAINT IF EXISTS friends_contacts_send_preference_check;
ALTER TABLE friends_contacts
    ADD CONSTRAINT friends_contacts_send_preference_check
    CHECK (send_preference IN ('dm_only', 'group_only', 'both', 'none'));

ALTER TABLE friends_contacts
    DROP CONSTRAINT IF EXISTS friends_contacts_phone_format_check;
ALTER TABLE friends_contacts
    ADD CONSTRAINT friends_contacts_phone_format_check
    CHECK (phone_number ~ '^\+?[0-9]{8,20}$');

-- subject_name should be normalized lowercase. The CompreFace upload script
-- already lowercases on bulk; enforce here to guarantee the join works.
ALTER TABLE friends_contacts
    DROP CONSTRAINT IF EXISTS friends_contacts_subject_lowercase_check;
ALTER TABLE friends_contacts
    ADD CONSTRAINT friends_contacts_subject_lowercase_check
    CHECK (subject_name = lower(subject_name));

-- Soft delete + GDPR right-to-erasure pointers
ALTER TABLE friends_contacts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE friends_contacts ADD COLUMN IF NOT EXISTS erasure_requested_at TIMESTAMPTZ;
ALTER TABLE friends_contacts ADD COLUMN IF NOT EXISTS data_retention_days INTEGER DEFAULT 365;

CREATE INDEX IF NOT EXISTS idx_friends_active
    ON friends_contacts (is_active, consent_given)
    WHERE deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- 2. hangout_sessions: timezone-safe windowing & integrity
-- ----------------------------------------------------------------------------
ALTER TABLE hangout_sessions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE hangout_sessions ADD COLUMN IF NOT EXISTS session_window_hours INTEGER DEFAULT 6;
ALTER TABLE hangout_sessions ADD COLUMN IF NOT EXISTS local_tz TEXT DEFAULT 'Asia/Kolkata';

ALTER TABLE hangout_sessions
    DROP CONSTRAINT IF EXISTS hangout_sessions_time_order_check;
ALTER TABLE hangout_sessions
    ADD CONSTRAINT hangout_sessions_time_order_check
    CHECK (ended_at IS NULL OR ended_at >= started_at);

CREATE INDEX IF NOT EXISTS idx_sessions_active
    ON hangout_sessions (started_at DESC)
    WHERE deleted_at IS NULL;

-- Index supporting the "latest session within window" lookup that 02-process
-- runs on every photo. Without this we full-scan as the table grows.
CREATE INDEX IF NOT EXISTS idx_sessions_ended_at
    ON hangout_sessions (ended_at DESC NULLS LAST)
    WHERE deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- 3. media_files: status enum, FK ON DELETE, partial indexes, JSONB GIN
-- ----------------------------------------------------------------------------
ALTER TABLE media_files
    DROP CONSTRAINT IF EXISTS media_files_status_check;
ALTER TABLE media_files
    ADD CONSTRAINT media_files_status_check
    CHECK (status IN ('pending', 'processing', 'processed',
                      'delivered', 'failed', 'skipped', 'erased'));

ALTER TABLE media_files
    DROP CONSTRAINT IF EXISTS media_files_size_positive_check;
ALTER TABLE media_files
    ADD CONSTRAINT media_files_size_positive_check
    CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0);

-- Re-point the session FK so deleting a session sets the column NULL instead
-- of failing the delete.
ALTER TABLE media_files
    DROP CONSTRAINT IF EXISTS media_files_session_id_fkey;
ALTER TABLE media_files
    ADD CONSTRAINT media_files_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES hangout_sessions(id) ON DELETE SET NULL;

-- Faster dispatch of pending work
CREATE INDEX IF NOT EXISTS idx_media_pending
    ON media_files (ingested_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_media_processed_undelivered
    ON media_files (taken_at)
    WHERE status = 'processed';

-- JSONB GIN for ad-hoc queries against face metadata (e.g. find low-confidence)
CREATE INDEX IF NOT EXISTS idx_media_faces_recognized_gin
    ON media_files USING GIN (faces_recognized jsonb_path_ops);

-- ----------------------------------------------------------------------------
-- 4. delivery_logs: dedup that allows retries, cascade behavior, idempotency
-- ----------------------------------------------------------------------------
ALTER TABLE delivery_logs
    DROP CONSTRAINT IF EXISTS delivery_logs_status_check;
ALTER TABLE delivery_logs
    ADD CONSTRAINT delivery_logs_status_check
    CHECK (status IN ('pending', 'sent', 'delivered', 'read',
                      'failed', 'cancelled', 'retrying'));

ALTER TABLE delivery_logs
    DROP CONSTRAINT IF EXISTS delivery_logs_recipient_type_check;
ALTER TABLE delivery_logs
    ADD CONSTRAINT delivery_logs_recipient_type_check
    CHECK (recipient_type IN ('group', 'dm'));

ALTER TABLE delivery_logs
    DROP CONSTRAINT IF EXISTS delivery_logs_sent_as_check;
ALTER TABLE delivery_logs
    ADD CONSTRAINT delivery_logs_sent_as_check
    CHECK (sent_as IN ('document', 'media', 'image'));

ALTER TABLE delivery_logs
    DROP CONSTRAINT IF EXISTS delivery_logs_media_file_id_fkey;
ALTER TABLE delivery_logs
    ADD CONSTRAINT delivery_logs_media_file_id_fkey
    FOREIGN KEY (media_file_id) REFERENCES media_files(id) ON DELETE CASCADE;

ALTER TABLE delivery_logs
    DROP CONSTRAINT IF EXISTS delivery_logs_session_id_fkey;
ALTER TABLE delivery_logs
    ADD CONSTRAINT delivery_logs_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES hangout_sessions(id) ON DELETE SET NULL;

-- The original UNIQUE (media_file_id, recipient_jid) blocks legitimate retries
-- when the first attempt failed. Replace with a *partial* unique index that
-- only constrains successful sends — failed/cancelled rows are free to be
-- retried via new inserts.
DROP INDEX IF EXISTS idx_delivery_dedup;
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_dedup_success
    ON delivery_logs (media_file_id, recipient_jid)
    WHERE status IN ('sent', 'delivered', 'read');

-- Idempotency for the sender. The workflow generates a deterministic key
-- (media_file_id || ':' || recipient_jid || ':' || attempt_n) and Postgres
-- enforces uniqueness so two parallel runs cannot double-send.
ALTER TABLE delivery_logs
    ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(200);
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_idempotency
    ON delivery_logs (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_delivery_recent
    ON delivery_logs (created_at DESC);

-- ----------------------------------------------------------------------------
-- 5. Helper views: rebuild with deleted_at filters
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS v_ready_to_deliver CASCADE;
CREATE OR REPLACE VIEW v_ready_to_deliver AS
SELECT
    m.id                                        AS media_id,
    m.original_filename,
    m.local_path,
    m.processed_path,
    m.is_video,
    m.friends_identified,
    m.faces_recognized,
    m.session_id,
    m.taken_at,
    s.session_name,
    COALESCE(array_length(m.friends_identified, 1), 0) AS friend_count
FROM media_files m
LEFT JOIN hangout_sessions s
    ON s.id = m.session_id AND s.deleted_at IS NULL
WHERE m.status = 'processed'
  AND NOT EXISTS (
      SELECT 1 FROM delivery_logs d
      WHERE d.media_file_id = m.id
        AND d.status IN ('sent', 'delivered', 'read')
  )
ORDER BY m.taken_at ASC NULLS LAST;

DROP VIEW IF EXISTS v_session_summary CASCADE;
CREATE OR REPLACE VIEW v_session_summary AS
SELECT
    s.id,
    s.session_name,
    s.started_at,
    s.ended_at,
    s.media_count,
    s.friends_present,
    s.is_delivered,
    COUNT(m.id)                                  AS actual_media_count,
    COUNT(*) FILTER (WHERE m.is_video)           AS video_count,
    COUNT(*) FILTER (WHERE NOT m.is_video)       AS photo_count,
    COUNT(*) FILTER (WHERE m.status = 'failed')  AS failed_count
FROM hangout_sessions s
LEFT JOIN media_files m ON m.session_id = s.id
WHERE s.deleted_at IS NULL
GROUP BY s.id;

-- ----------------------------------------------------------------------------
-- 6. Atomic session attachment (prevents 02-process race)
-- ----------------------------------------------------------------------------
-- Two photos arriving at the same time can both miss the "current session"
-- lookup and create duplicate sessions. This SQL function does the lookup +
-- create + attach in a single transaction with a lock, so concurrent callers
-- serialize correctly.
CREATE OR REPLACE FUNCTION attach_to_session(
    p_media_id      UUID,
    p_taken_at      TIMESTAMPTZ,
    p_window_hours  INTEGER DEFAULT 6,
    p_friends       TEXT[]  DEFAULT '{}'
) RETURNS UUID AS $$
DECLARE
    v_session_id UUID;
BEGIN
    -- Serialize concurrent callers on a single advisory lock; cheap and
    -- bounded since session creation is rare relative to other work.
    PERFORM pg_advisory_xact_lock(hashtext('attach_to_session'));

    SELECT id INTO v_session_id
    FROM hangout_sessions
    WHERE deleted_at IS NULL
      AND started_at <= p_taken_at
      AND COALESCE(ended_at, started_at) + (p_window_hours || ' hours')::INTERVAL >= p_taken_at
    ORDER BY started_at DESC
    LIMIT 1;

    IF v_session_id IS NULL THEN
        INSERT INTO hangout_sessions
            (started_at, ended_at, friends_present, session_window_hours)
        VALUES
            (p_taken_at, p_taken_at, p_friends, p_window_hours)
        RETURNING id INTO v_session_id;
    ELSE
        UPDATE hangout_sessions
        SET ended_at = GREATEST(COALESCE(ended_at, started_at), p_taken_at),
            started_at = LEAST(started_at, p_taken_at),
            friends_present = (
                SELECT ARRAY(
                    SELECT DISTINCT unnest(COALESCE(friends_present, '{}') || p_friends)
                )
            ),
            updated_at = NOW()
        WHERE id = v_session_id;
    END IF;

    UPDATE media_files
    SET session_id = v_session_id, updated_at = NOW()
    WHERE id = p_media_id;

    -- Refresh denormalized count
    UPDATE hangout_sessions
    SET media_count = (SELECT COUNT(*) FROM media_files WHERE session_id = v_session_id)
    WHERE id = v_session_id;

    RETURN v_session_id;
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 7. GDPR — right-to-erasure helper
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION erase_friend(p_subject_name TEXT)
RETURNS TABLE(media_files_marked INTEGER, delivery_logs_marked INTEGER) AS $$
DECLARE
    v_media_count INTEGER;
    v_delivery_count INTEGER;
BEGIN
    UPDATE friends_contacts
    SET is_active = false,
        consent_given = false,
        deleted_at = NOW(),
        erasure_requested_at = NOW(),
        notes = COALESCE(notes, '') || E'\n[GDPR erasure on ' || NOW()::text || ']',
        phone_number = '0',
        whatsapp_jid = NULL
    WHERE subject_name = lower(p_subject_name);

    -- Strip identifiable face data; keep media files for owner history
    UPDATE media_files
    SET friends_identified = array_remove(friends_identified, lower(p_subject_name)),
        faces_recognized = '[]'::jsonb,
        status = CASE WHEN status = 'pending' THEN 'erased' ELSE status END
    WHERE lower(p_subject_name) = ANY(friends_identified)
    RETURNING 1 INTO v_media_count;

    UPDATE delivery_logs d
    SET recipient_name = '[erased]',
        error_message = NULL
    FROM friends_contacts f
    WHERE f.subject_name = lower(p_subject_name)
      AND d.recipient_jid = f.whatsapp_jid
    RETURNING 1 INTO v_delivery_count;

    RETURN QUERY SELECT COALESCE(v_media_count, 0), COALESCE(v_delivery_count, 0);
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 8. Retention sweeper — call from cron / n8n schedule
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sweep_retention()
RETURNS TABLE(media_purged INTEGER, sessions_purged INTEGER) AS $$
DECLARE
    v_media INTEGER;
    v_sessions INTEGER;
BEGIN
    -- Soft-delete media older than the longest configured friend retention
    UPDATE media_files
    SET status = 'erased',
        local_path = NULL,
        processed_path = NULL,
        faces_recognized = '[]'::jsonb,
        friends_identified = '{}'
    WHERE ingested_at < NOW() - INTERVAL '365 days'
      AND status NOT IN ('erased')
    RETURNING 1 INTO v_media;

    UPDATE hangout_sessions
    SET deleted_at = NOW()
    WHERE deleted_at IS NULL
      AND COALESCE(ended_at, started_at) < NOW() - INTERVAL '365 days'
    RETURNING 1 INTO v_sessions;

    RETURN QUERY SELECT COALESCE(v_media, 0), COALESCE(v_sessions, 0);
END;
$$ LANGUAGE plpgsql;

COMMIT;
