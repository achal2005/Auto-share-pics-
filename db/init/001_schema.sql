-- ============================================================================
-- AutoSharePics - Database Schema
-- ============================================================================
-- This file runs automatically on first `docker-compose up` via the
-- docker-entrypoint-initdb.d mount.
--
-- Tables:
--   1. friends_contacts  - Friend registry with phone numbers
--   2. hangout_sessions   - Time-windowed grouping of media
--   3. media_files        - Every photo/video ingested
--   4. delivery_logs      - Record of every WhatsApp send
-- ============================================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. FRIENDS / CONTACTS
-- ─────────────────────────────────────────────────────────────────────────────
-- Maps CompreFace "subject" names to WhatsApp numbers.
-- The `subject_name` MUST exactly match the name used when uploading faces
-- to CompreFace (case-sensitive).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS friends_contacts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    subject_name    VARCHAR(100) NOT NULL UNIQUE,  -- Must match CompreFace subject
    display_name    VARCHAR(100) NOT NULL,          -- Human-friendly name
    phone_number    VARCHAR(20)  NOT NULL,          -- With country code: 919876543210
    whatsapp_jid    VARCHAR(50),                    -- Auto-populated: 919876543210@s.whatsapp.net
    send_preference VARCHAR(20)  DEFAULT 'both',    -- 'dm_only', 'group_only', 'both'
    is_active       BOOLEAN      DEFAULT true,      -- Soft-disable without deleting
    consent_given   BOOLEAN      DEFAULT false,     -- GDPR: did they consent to face recognition?
    consent_date    TIMESTAMPTZ,
    notes           TEXT,
    created_at      TIMESTAMPTZ  DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

-- Auto-generate WhatsApp JID from phone number
CREATE OR REPLACE FUNCTION set_whatsapp_jid()
RETURNS TRIGGER AS $$
BEGIN
    -- Strip any non-numeric characters and append WhatsApp suffix
    NEW.whatsapp_jid := regexp_replace(NEW.phone_number, '[^0-9]', '', 'g') || '@s.whatsapp.net';
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_set_whatsapp_jid
    BEFORE INSERT OR UPDATE OF phone_number ON friends_contacts
    FOR EACH ROW
    EXECUTE FUNCTION set_whatsapp_jid();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. HANGOUT SESSIONS
-- ─────────────────────────────────────────────────────────────────────────────
-- Groups media into sessions using a 6-hour time window.
-- A new session is created whenever there's a 6+ hour gap between photos.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hangout_sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_name    VARCHAR(200),                    -- Auto-generated or user-named
    started_at      TIMESTAMPTZ  NOT NULL,           -- Earliest photo timestamp
    ended_at        TIMESTAMPTZ,                     -- Latest photo timestamp
    media_count     INTEGER      DEFAULT 0,
    friends_present TEXT[],                           -- Array of subject_names detected
    is_delivered    BOOLEAN      DEFAULT false,       -- Has this session been sent?
    delivery_date   TIMESTAMPTZ,
    location_label  VARCHAR(200),                    -- Optional: "Cafe Mocha", "Beach trip"
    metadata        JSONB        DEFAULT '{}',       -- Flexible extra data
    created_at      TIMESTAMPTZ  DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX idx_sessions_started_at ON hangout_sessions(started_at DESC);
CREATE INDEX idx_sessions_is_delivered ON hangout_sessions(is_delivered);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. MEDIA FILES
-- ─────────────────────────────────────────────────────────────────────────────
-- Every photo/video that passes through the system.
-- Status flow: pending → processing → processed → delivered / failed
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS media_files (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- Source info
    gdrive_file_id      VARCHAR(200) NOT NULL UNIQUE,   -- Google Drive file ID (dedup key)
    original_filename   VARCHAR(500) NOT NULL,
    mime_type           VARCHAR(100),                    -- image/jpeg, video/mp4, image/heic
    file_size_bytes     BIGINT,
    -- Local storage
    local_path          VARCHAR(500),                    -- Path in media_cache volume
    processed_path      VARCHAR(500),                    -- Converted version (HEIC→JPEG)
    -- Media metadata (from EXIF)
    taken_at            TIMESTAMPTZ,                     -- EXIF DateTimeOriginal
    camera_model        VARCHAR(100),
    gps_latitude        DOUBLE PRECISION,
    gps_longitude       DOUBLE PRECISION,
    -- Face recognition results
    faces_detected      INTEGER      DEFAULT 0,
    faces_recognized    JSONB        DEFAULT '[]',       -- [{subject, similarity, box}, ...]
    friends_identified  TEXT[]       DEFAULT '{}',       -- Simple array of subject_names
    -- Session assignment
    session_id          UUID REFERENCES hangout_sessions(id),
    -- Processing state
    -- FIX #10: Enforce valid status values via CHECK constraint
    status              VARCHAR(20)  DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'processed', 'delivered', 'failed', 'skipped')),  -- pending, processing, processed, delivered, failed, skipped
    process_attempts    INTEGER      DEFAULT 0,
    last_error          TEXT,
    -- Media type
    is_video            BOOLEAN      DEFAULT false,
    video_keyframes     INTEGER,                         -- Number of keyframes extracted
    -- Deduplication
    -- FIX #5: Add DEFAULT uuid_generate_v4()
    idempotency_key     VARCHAR(100) UNIQUE DEFAULT uuid_generate_v4(),             -- Prevents duplicate processing
    -- Timestamps
    ingested_at         TIMESTAMPTZ  DEFAULT NOW(),
    processed_at        TIMESTAMPTZ,
    delivered_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ  DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX idx_media_status ON media_files(status);
CREATE INDEX idx_media_session ON media_files(session_id);
CREATE INDEX idx_media_taken_at ON media_files(taken_at DESC);
CREATE INDEX idx_media_gdrive_id ON media_files(gdrive_file_id);
CREATE INDEX idx_media_friends ON media_files USING GIN(friends_identified);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. DELIVERY LOGS
-- ─────────────────────────────────────────────────────────────────────────────
-- Records every WhatsApp message sent. Used for:
--   - Preventing duplicate sends
--   - Analytics (who got what, when)
--   - Debugging delivery failures
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS delivery_logs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    media_file_id   UUID NOT NULL REFERENCES media_files(id),
    session_id      UUID REFERENCES hangout_sessions(id),
    -- Recipient info
    recipient_type  VARCHAR(10)  NOT NULL,            -- 'group' or 'dm'
    recipient_jid   VARCHAR(50)  NOT NULL,            -- WhatsApp JID
    recipient_name  VARCHAR(100),                     -- Human-readable
    -- Send details
    sent_as         VARCHAR(20)  NOT NULL,            -- 'document' (photos) or 'media' (videos)
    -- Status
    status          VARCHAR(20)  DEFAULT 'pending',   -- pending, sent, delivered, read, failed
    whatsapp_msg_id VARCHAR(100),                     -- Message ID from Evolution API
    error_message   TEXT,
    retry_count     INTEGER      DEFAULT 0,
    -- Timestamps
    sent_at         TIMESTAMPTZ,
    delivered_at    TIMESTAMPTZ,
    read_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX idx_delivery_media ON delivery_logs(media_file_id);
CREATE INDEX idx_delivery_session ON delivery_logs(session_id);
CREATE INDEX idx_delivery_status ON delivery_logs(status);
-- Composite index to prevent duplicate sends
-- FIX #2: Make it partial to not block retries
CREATE UNIQUE INDEX idx_delivery_dedup ON delivery_logs(media_file_id, recipient_jid) WHERE status IN ('pending', 'sent', 'delivered', 'read');

-- ─────────────────────────────────────────────────────────────────────────────
-- HELPER VIEWS
-- ─────────────────────────────────────────────────────────────────────────────

-- View: Undelivered media ready for sending
CREATE OR REPLACE VIEW v_ready_to_deliver AS
SELECT
    m.id AS media_id,
    m.original_filename,
    m.local_path,
    m.is_video,
    m.friends_identified,
    m.faces_recognized,
    m.session_id,
    s.session_name,
    array_length(m.friends_identified, 1) AS friend_count
FROM media_files m
LEFT JOIN hangout_sessions s ON m.session_id = s.id
WHERE m.status = 'processed'
  -- FIX #3: Replace slow NOT IN with NOT EXISTS
  AND NOT EXISTS (
    SELECT 1 FROM delivery_logs dl 
    WHERE dl.media_file_id = m.id 
    AND dl.status IN ('sent', 'delivered', 'read')
  )
ORDER BY m.taken_at ASC;

-- View: Session summary with friend stats
CREATE OR REPLACE VIEW v_session_summary AS
SELECT
    s.id,
    s.session_name,
    s.started_at,
    s.ended_at,
    s.media_count,
    s.friends_present,
    s.is_delivered,
    COUNT(m.id) AS actual_media_count,
    COUNT(CASE WHEN m.is_video THEN 1 END) AS video_count,
    COUNT(CASE WHEN NOT m.is_video THEN 1 END) AS photo_count
FROM hangout_sessions s
LEFT JOIN media_files m ON m.session_id = s.id
GROUP BY s.id;

-- ─────────────────────────────────────────────────────────────────────────────
-- FIX #9: TRIGGERS
-- ─────────────────────────────────────────────────────────────────────────────

-- Auto-populate hangout_sessions.friends_present from media_files.friends_identified
CREATE OR REPLACE FUNCTION update_session_friends()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.session_id IS NOT NULL AND NEW.friends_identified IS NOT NULL THEN
        UPDATE hangout_sessions
        SET friends_present = ARRAY(
            SELECT DISTINCT unnest(COALESCE(friends_present, '{}'::text[]) || NEW.friends_identified)
        )
        WHERE id = NEW.session_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_session_friends
    AFTER INSERT OR UPDATE OF friends_identified, session_id ON media_files
    FOR EACH ROW
    EXECUTE FUNCTION update_session_friends();

-- ─────────────────────────────────────────────────────────────────────────────
-- SAMPLE DATA (for testing - remove or comment out for production)
-- ─────────────────────────────────────────────────────────────────────────────

-- Insert sample friends (replace with your actual friends)
-- INSERT INTO friends_contacts (subject_name, display_name, phone_number, consent_given, consent_date)
-- VALUES
--     ('alice',   'Alice Sharma',    '919876543210', true, NOW()),
--     ('bob',     'Bob Kumar',       '919876543211', true, NOW()),
--     ('charlie', 'Charlie Singh',   '919876543212', true, NOW()),
--     ('diana',   'Diana Patel',     '919876543213', true, NOW()),
--     ('eve',     'Eve Gupta',       '919876543214', true, NOW());
