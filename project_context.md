# Project Context: AutoSharePics

This document contains the entire project context for the "AutoSharePics" application. It is designed to be fed into a Large Language Model (LLM) to provide a complete understanding of the architecture, database schema, infrastructure, and workflows for debugging and finding errors.

## Table of Contents
1. [README.md](#readmemd)
2. [docker-compose.yml](#docker-composeyml)
3. [Environment Configuration (.env.example)](#environment-configuration)
4. [Database Schema (001_schema.sql)](#database-schema)
5. [Scripts (setup-compreface.js)](#scripts)
6. [n8n Workflows](#n8n-workflows)
   - [01-ingest.json](#workflow-01-ingestjson)
   - [02-process.json](#workflow-02-processjson)
   - [03-deliver.json](#workflow-03-deliverjson)

---

## README.md

```markdown
# 📸 AutoSharePics

**Automatically distribute hangout photos to friends via WhatsApp using AI face recognition.**

Photos with 2+ friends → Group chat (as documents, full quality)
Photos with 1 friend → DM (as document, full quality)
Videos → Sent as normal media

## Architecture

iPhone Camera → Google Drive → n8n (Ingest → Process → Deliver) → WhatsApp
                                      ↕              ↕
                                  PostgreSQL    CompreFace (Face AI)

## Quick Start

# 1. Configure
copy .env.example .env
# Edit .env with your values

# 2. Launch
docker-compose up -d

# 3. Setup services (see docs/SETUP_GUIDE.md)
# - Connect WhatsApp via QR code
# - Create CompreFace recognition service
# - Upload friend reference photos
# - Import n8n workflows
# - Add friends to database

# 4. Test
# Upload a photo to your Google Drive folder and watch the magic

## Project Structure

auto share pics/
├── docker-compose.yml          # All services
├── .env.example                # Environment template
├── .gitignore
├── db/
│   ├── init/001_schema.sql     # Auto-runs on first start
│   └── sample_queries.sql      # Useful SQL queries
├── workflows/
│   ├── 01-ingest.json          # Google Drive → Download → Store
│   ├── 02-process.json         # Face Recognition → Session Clustering
│   └── 03-deliver.json         # Routing → WhatsApp Sending
├── scripts/
│   ├── setup-compreface.js     # Upload reference photos
│   └── package.json
├── reference_photos/           # (gitignored) Friend face photos
│   ├── alice/
│   ├── bob/
│   └── ...
└── docs/
    ├── SETUP_GUIDE.md
    └── SECURITY_TESTING_DEPLOYMENT.md

## Tech Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Orchestration | n8n | Workflow automation |
| Face Recognition | CompreFace | Self-hosted AI face detection |
| WhatsApp | Evolution API | Message gateway |
| Database | PostgreSQL | Media tracking & delivery logs |
| Storage | Google Drive | Cloud photo sync |

## Cost: ~$3-5/month (electricity only, all self-hosted)

## Docs
- [Setup Guide](docs/SETUP_GUIDE.md) — Step-by-step installation
- [Security & Deployment](docs/SECURITY_TESTING_DEPLOYMENT.md) — Security, testing, roadmap
```

---

## docker-compose.yml

```yaml
# ============================================================================
# AutoSharePics - Docker Compose Stack
# ============================================================================
# Components:
#   - n8n (workflow automation)
#   - CompreFace (face recognition - API, Admin, PostgreSQL)
#   - Evolution API (WhatsApp gateway)
#   - PostgreSQL (application database)
#   - Caddy (reverse proxy + auto SSL) [optional for local]
#
# Usage:
#   docker-compose up -d
#   docker-compose logs -f n8n
#
# ⚠️  First run: CompreFace takes 2-3 minutes to download ML models
# ============================================================================

# --------------------------------------------------------------------------
# Named volumes for persistent data
# --------------------------------------------------------------------------
volumes:
  n8n_data:
    driver: local
  app_postgres_data:
    driver: local
  compreface_postgres_data:
    driver: local
  evolution_instances:
    driver: local
  evolution_store:
    driver: local
  media_cache:
    driver: local

# --------------------------------------------------------------------------
# Internal networks - services only talk to what they need
# --------------------------------------------------------------------------
networks:
  # Main network for n8n <-> services communication
  autoshare_net:
    driver: bridge
  # Isolated network for CompreFace internal comms
  compreface_net:
    driver: bridge

services:
  # ========================================================================
  # APPLICATION DATABASE (PostgreSQL)
  # Stores: media_files, hangout_sessions, friends_contacts, delivery_logs
  # Also used by n8n as its internal database
  # ========================================================================
  app-postgres:
    image: postgres:16-alpine
    container_name: autoshare-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${APP_DB_USER:-autoshare}
      POSTGRES_PASSWORD: ${APP_DB_PASSWORD:?Set APP_DB_PASSWORD in .env}
      POSTGRES_DB: ${APP_DB_NAME:-autosharepics}
    volumes:
      - app_postgres_data:/var/lib/postgresql/data
      # Auto-run schema migration on first start
      - ./db/init:/docker-entrypoint-initdb.d:ro
    ports:
      # Expose to host for debugging only - remove in production
      - "${APP_DB_PORT:-5433}:5432"
    networks:
      - autoshare_net
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${APP_DB_USER:-autoshare} -d ${APP_DB_NAME:-autosharepics}"]
      interval: 10s
      timeout: 5s
      retries: 5

  # ========================================================================
  # n8n - WORKFLOW ENGINE
  # The brain of the operation - orchestrates everything
  # Access at: http://localhost:5678
  # ========================================================================
  n8n:
    image: docker.n8n.io/n8nio/n8n:latest
    container_name: autoshare-n8n
    restart: unless-stopped
    depends_on:
      app-postgres:
        condition: service_healthy
    environment:
      # --- Database (use PostgreSQL instead of SQLite for reliability) ---
      DB_TYPE: postgresdb
      DB_POSTGRESDB_HOST: app-postgres
      DB_POSTGRESDB_PORT: 5432
      DB_POSTGRESDB_DATABASE: ${APP_DB_NAME:-autosharepics}
      DB_POSTGRESDB_USER: ${APP_DB_USER:-autoshare}
      DB_POSTGRESDB_PASSWORD: ${APP_DB_PASSWORD:?Set APP_DB_PASSWORD in .env}
      # --- n8n config ---
      N8N_HOST: ${N8N_HOST:-localhost}
      N8N_PORT: 5678
      N8N_PROTOCOL: ${N8N_PROTOCOL:-http}
      WEBHOOK_URL: ${WEBHOOK_URL:-http://localhost:5678/}
      # --- Security (owner account created via n8n setup wizard) ---
      # --- Execution settings ---
      EXECUTIONS_MODE: regular
      EXECUTIONS_TIMEOUT: 600
      EXECUTIONS_TIMEOUT_MAX: 1200
      # --- Allow local file access for media cache ---
      N8N_USER_FOLDER: /home/node
      GENERIC_TIMEZONE: ${TIMEZONE:-Asia/Kolkata}
      # --- Allow calling local Docker services ---
      NODE_FUNCTION_ALLOW_EXTERNAL: "axios"
    volumes:
      - n8n_data:/home/node/.n8n
      - media_cache:/home/node/media_cache
    ports:
      - "${N8N_PORT:-5678}:5678"
    networks:
      - autoshare_net

  # ========================================================================
  # COMPREFACE - FACE RECOGNITION ENGINE
  # Self-hosted AI face recognition with REST API
  # Admin UI: http://localhost:8000
  # ========================================================================

  # CompreFace's own PostgreSQL (DO NOT share with app DB)
  compreface-postgres:
    image: postgres:11.5
    container_name: autoshare-compreface-db
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${CF_DB_USER:-compreface}
      POSTGRES_PASSWORD: ${CF_DB_PASSWORD:-compreface_secret}
      POSTGRES_DB: frs
    volumes:
      - compreface_postgres_data:/var/lib/postgresql/data
    networks:
      - compreface_net
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${CF_DB_USER:-compreface}"]
      interval: 10s
      timeout: 5s
      retries: 5

  # CompreFace core API server
  compreface-core:
    image: exadel/compreface-core:1.2.0
    container_name: autoshare-compreface-core
    restart: unless-stopped
    environment:
      ML_PORT: 3000
      IMG_LENGTH_LIMIT: ${CF_IMG_LIMIT:-640}
    networks:
      - compreface_net

  # CompreFace API gateway
  compreface-api:
    image: exadel/compreface-api:1.2.0
    container_name: autoshare-compreface-api
    restart: unless-stopped
    depends_on:
      compreface-postgres:
        condition: service_healthy
      compreface-core:
        condition: service_started
    environment:
      POSTGRES_URL: jdbc:postgresql://compreface-postgres:5432/frs
      POSTGRES_USER: ${CF_DB_USER:-compreface}
      POSTGRES_PASSWORD: ${CF_DB_PASSWORD:-compreface_secret}
      SPRING_PROFILES_ACTIVE: dev
      API_JAVA_OPTS: "-Xmx512m"
      SAVE_IMAGES_TO_DB: "true"
      CONNECTION_TIMEOUT: 10000
      READ_TIMEOUT: 60000
    networks:
      - compreface_net

  # CompreFace admin portal
  compreface-admin:
    image: exadel/compreface-admin:1.2.0
    container_name: autoshare-compreface-admin
    restart: unless-stopped
    depends_on:
      compreface-api:
        condition: service_started
    environment:
      POSTGRES_URL: jdbc:postgresql://compreface-postgres:5432/frs
      POSTGRES_USER: ${CF_DB_USER:-compreface}
      POSTGRES_PASSWORD: ${CF_DB_PASSWORD:-compreface_secret}
      SPRING_PROFILES_ACTIVE: dev
      ADMIN_JAVA_OPTS: "-Xmx256m"
    networks:
      - compreface_net
      - autoshare_net

  # CompreFace Frontend (UI + Nginx proxy)
  compreface-fe:
    image: exadel/compreface-fe:1.2.0
    container_name: autoshare-compreface-fe
    restart: unless-stopped
    depends_on:
      - compreface-api
      - compreface-admin
    ports:
      - "${CF_API_PORT:-8000}:80"
    environment:
      - PROXY_READ_TIMEOUT=60000
      - PROXY_CONNECT_TIMEOUT=60000
      - CLIENT_MAX_BODY_SIZE=5m
    networks:
      - compreface_net
      - autoshare_net

  # ========================================================================
  # EVOLUTION API - WHATSAPP GATEWAY
  # Connects to WhatsApp via multi-device web protocol
  # API docs: http://localhost:8080/docs
  # ========================================================================
  evolution-api:
    image: atendai/evolution-api:v2.2.0
    container_name: autoshare-evolution
    restart: unless-stopped
    command: ["sh", "-c", "find /evolution/dist -name '*.js' -exec sed -i 's/os\\.release()/\"10.0\"/g' {} + && npm run start:prod"]
    environment:
      # --- Server ---
      SERVER_URL: ${EVOLUTION_SERVER_URL:-http://localhost:8080}
      SERVER_TYPE: http
      SERVER_PORT: 8080
      # --- Authentication ---
      AUTHENTICATION_API_KEY: ${EVOLUTION_API_KEY:?Set EVOLUTION_API_KEY in .env}
      AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES: "true"
      LOG_LEVEL: "ERROR,WARN,DEBUG,INFO,LOG,VERBOSE,DARK,WEBHOOKS"
      # --- Database (uses app PostgreSQL) ---
      DATABASE_ENABLED: "true"
      DATABASE_PROVIDER: postgresql
      DATABASE_CONNECTION_URI: postgresql://${APP_DB_USER:-autoshare}:${APP_DB_PASSWORD}@app-postgres:5432/${EVOLUTION_DB_NAME:-evolution_api}
      # --- Instance management ---
      DEL_INSTANCE: "false"
      # --- WhatsApp settings ---
      CONFIG_SESSION_PHONE_VERSION: "1.0.0"
      QRCODE_LIMIT: 6
      # --- Rate limiting (ban prevention!) ---
      # ⚠️ These are critical for avoiding WhatsApp bans
      SEND_MESSAGE_TIMEOUT: 3000
      # --- Cache (no Redis, use local) ---
      CACHE_REDIS_ENABLED: "false"
      CACHE_REDIS_URI: ""
      CACHE_LOCAL_ENABLED: "false"
    volumes:
      - evolution_instances:/evolution/instances
      - evolution_store:/evolution/store
      # Mount media cache so Evolution can send local files
      - media_cache:/evolution/media_cache:ro
    ports:
      - "${EVOLUTION_PORT:-8080}:8080"
    networks:
      - autoshare_net
    depends_on:
      app-postgres:
        condition: service_healthy
```

---

## Environment Configuration

This is based on `.env.example`. Actual secrets have been redacted.

```env
# ============================================================================
# AutoSharePics - Environment Variables
# ============================================================================
# Copy this file to .env and fill in your values:
#   cp .env.example .env
#
# ⚠️ NEVER commit the .env file to version control!
# ============================================================================

# --- General ---
TIMEZONE=Asia/Kolkata

# --- Application Database (PostgreSQL) ---
APP_DB_USER=autoshare
APP_DB_PASSWORD=CHANGE_ME_to_a_strong_password_123
APP_DB_NAME=autosharepics
APP_DB_PORT=5433

# --- n8n Configuration ---
N8N_HOST=localhost
N8N_PORT=5678
N8N_PROTOCOL=http
WEBHOOK_URL=http://localhost:5678/
N8N_AUTH_USER=admin
N8N_AUTH_PASSWORD=CHANGE_ME_n8n_password_456
WORKFLOW_PROCESS_ID=

# --- CompreFace ---
# These are for CompreFace's internal PostgreSQL (separate from app DB)
CF_DB_USER=compreface
CF_DB_PASSWORD=compreface_secret_789
CF_API_PORT=8000
# Max image dimension for processing (640 is good balance of speed/accuracy)
CF_IMG_LIMIT=640

# --- CompreFace API Keys ---
# You'll get these AFTER creating a recognition service in CompreFace admin UI
# 1. Open http://localhost:8000
# 2. Create an account (first run only)
# 3. Create an "Application" called "AutoSharePics"
# 4. Copy the API key from the Recognition service
CF_RECOGNITION_API_KEY=your_recognition_api_key_here

# --- Evolution API (WhatsApp) ---
EVOLUTION_PORT=8080
EVOLUTION_SERVER_URL=http://localhost:8080
# Generate a strong random key: openssl rand -hex 32
EVOLUTION_API_KEY=CHANGE_ME_evolution_api_key_abc
EVOLUTION_DB_NAME=evolution_api
EVOLUTION_INSTANCE_NAME=autoshare

# --- Google Drive ---
# n8n handles Google Drive OAuth internally via its credential system
# You'll set this up in n8n UI: Settings > Credentials > Google Drive
# The folder ID to watch (get from Google Drive URL when viewing the folder)
GDRIVE_FOLDER_ID=your_google_drive_folder_id_here

# --- WhatsApp Configuration ---
# Your main WhatsApp number (with country code, no + sign)
# Example for India: 919876543210
MY_WHATSAPP_NUMBER=91XXXXXXXXXX
# Group chat JID (you'll get this from Evolution API after connecting)
# Format: XXXXXXXXXXX@g.us
WHATSAPP_GROUP_JID=your_group_jid_here

# --- Geofence Webhook ---
# Secret token for the geofence webhook (iOS Shortcuts will send this)
# Generate: openssl rand -hex 16
GEOFENCE_WEBHOOK_SECRET=CHANGE_ME_geofence_secret_xyz

# --- Face Recognition Tuning ---
# Minimum confidence to consider a face match (0.0 to 1.0)
# 0.90 = very strict (fewer false positives, might miss some)
# 0.85 = balanced (recommended starting point)
# 0.80 = lenient (more matches, higher false positive risk)
FACE_CONFIDENCE_THRESHOLD=0.85
# Maximum faces to detect per image
FACE_DETECT_LIMIT=10

# --- Rate Limiting (WhatsApp ban prevention) ---
# Minimum delay between messages in milliseconds
WA_MIN_DELAY_MS=3000
# Maximum delay (random delay between min and max feels more human)
WA_MAX_DELAY_MS=8000
# Maximum messages per batch before a longer cooldown
WA_BATCH_SIZE=10
# Cooldown after a batch in milliseconds (2 minutes)
WA_BATCH_COOLDOWN_MS=120000
```

---

## Database Schema

```sql
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
    status              VARCHAR(20)  DEFAULT 'pending',  -- pending, processing, processed, delivered, failed, skipped
    process_attempts    INTEGER      DEFAULT 0,
    last_error          TEXT,
    -- Media type
    is_video            BOOLEAN      DEFAULT false,
    video_keyframes     INTEGER,                         -- Number of keyframes extracted
    -- Deduplication
    idempotency_key     VARCHAR(100) UNIQUE,             -- Prevents duplicate processing
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
CREATE UNIQUE INDEX idx_delivery_dedup ON delivery_logs(media_file_id, recipient_jid);

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
  AND m.id NOT IN (SELECT media_file_id FROM delivery_logs WHERE status IN ('sent', 'delivered', 'read'))
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
```

---

## Scripts

### `setup-compreface.js`

```javascript
#!/usr/bin/env node
// ============================================================================
// AutoSharePics - CompreFace Setup Script
// ============================================================================
// This script:
//   1. Creates a recognition service in CompreFace (if not exists)
//   2. Uploads reference photos for each friend ("subject")
//   3. Tests recognition accuracy
//
// Usage:
//   node scripts/setup-compreface.js --action=upload --friend=alice --photos=./reference_photos/alice/
//   node scripts/setup-compreface.js --action=test --photo=./test_photo.jpg
//   node scripts/setup-compreface.js --action=list
//
// Prerequisites:
//   npm install axios form-data fs-extra glob yargs
// ============================================================================

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs-extra');
const path = require('path');
const { glob } = require('glob');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const CONFIG = {
    // CompreFace API endpoint (admin portal serves the recognition API too)
    apiUrl: process.env.CF_API_URL || 'http://localhost:8000',
    // Recognition API key (get from CompreFace admin UI after creating a service)
    apiKey: process.env.CF_RECOGNITION_API_KEY || '',
    // Supported image formats
    supportedFormats: ['.jpg', '.jpeg', '.png', '.bmp', '.tiff'],
    // Face detection parameters
    detProbThreshold: 0.8,    // Minimum face detection confidence
    facePlugins: 'landmarks,gender,age',  // Extra data to extract
};

// ---------------------------------------------------------------------------
// Helper: Make API request to CompreFace
// ---------------------------------------------------------------------------
async function compreRequest(method, endpoint, data = null, isFormData = false) {
    const url = `${CONFIG.apiUrl}/api/v1/recognition${endpoint}`;
    const headers = {
        'x-api-key': CONFIG.apiKey,
    };

    if (isFormData) {
        Object.assign(headers, data.getHeaders());
    }

    try {
        const response = await axios({
            method,
            url,
            data,
            headers,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });
        return response.data;
    } catch (error) {
        if (error.response) {
            console.error(`❌ API Error (${error.response.status}):`, error.response.data);
        } else {
            console.error(`❌ Network Error:`, error.message);
        }
        throw error;
    }
}

// ---------------------------------------------------------------------------
// ACTION: List all registered subjects (friends)
// ---------------------------------------------------------------------------
async function listSubjects() {
    console.log('\n📋 Listing all registered subjects...\n');

    const result = await compreRequest('GET', '/subjects');
    const subjects = result.subjects || [];

    if (subjects.length === 0) {
        console.log('  (none) — No subjects registered yet.');
        console.log('  Run with --action=upload to add friends.\n');
        return;
    }

    console.log(`  Found ${subjects.length} subject(s):\n`);

    for (const subject of subjects) {
        // Get face count for each subject
        try {
            const faces = await compreRequest('GET', `/faces?subject=${encodeURIComponent(subject)}`);
            const count = faces.faces ? faces.faces.length : 0;
            console.log(`  👤 ${subject} — ${count} reference photo(s)`);
        } catch {
            console.log(`  👤 ${subject} — (couldn't fetch face count)`);
        }
    }
    console.log('');
}

// ---------------------------------------------------------------------------
// ACTION: Upload reference photos for a friend
// ---------------------------------------------------------------------------
async function uploadFaces(friendName, photosDir) {
    console.log(`\n📸 Uploading reference photos for "${friendName}"...`);
    console.log(`   Source directory: ${photosDir}\n`);

    // Verify directory exists
    if (!await fs.pathExists(photosDir)) {
        console.error(`❌ Directory not found: ${photosDir}`);
        console.error(`   Create it and add 5-15 clear photos of ${friendName}'s face.`);
        process.exit(1);
    }

    // Find all image files
    const patterns = CONFIG.supportedFormats.map(ext => path.join(photosDir, `*${ext}`));
    let imageFiles = [];
    for (const pattern of patterns) {
        const matches = await glob(pattern, { nocase: true, windowsPathsNoEscape: true });
        imageFiles.push(...matches);
    }

    if (imageFiles.length === 0) {
        console.error(`❌ No image files found in ${photosDir}`);
        console.error(`   Supported formats: ${CONFIG.supportedFormats.join(', ')}`);
        process.exit(1);
    }

    console.log(`   Found ${imageFiles.length} image(s) to upload.\n`);

    // Quality recommendations
    if (imageFiles.length < 5) {
        console.log('   ⚠️  Recommendation: Use at least 5 reference photos for good accuracy.');
        console.log('       Include different angles, lighting, and expressions.\n');
    }
    if (imageFiles.length > 20) {
        console.log('   💡 Tip: More than 20 photos may not improve accuracy significantly.');
        console.log('       Quality > quantity. Diverse angles matter more.\n');
    }

    // Upload each photo
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < imageFiles.length; i++) {
        const filePath = imageFiles[i];
        const fileName = path.basename(filePath);

        process.stdout.write(`   [${i + 1}/${imageFiles.length}] ${fileName}... `);

        try {
            const form = new FormData();
            form.append('file', fs.createReadStream(filePath));

            const result = await compreRequest(
                'POST',
                `/faces?subject=${encodeURIComponent(friendName)}&det_prob_threshold=${CONFIG.detProbThreshold}`,
                form,
                true
            );

            if (result.image_id) {
                console.log(`✅ (image_id: ${result.image_id.substring(0, 8)}...)`);
                successCount++;
            } else {
                console.log('⚠️  Uploaded but no face detected');
                failCount++;
            }
        } catch (error) {
            console.log('❌ Failed');
            failCount++;
        }

        // Small delay to not overwhelm the API
        await new Promise(r => setTimeout(r, 500));
    }

    console.log(`\n   📊 Results: ${successCount} succeeded, ${failCount} failed`);
    console.log(`   Subject "${friendName}" is ${successCount > 0 ? 'ready' : 'NOT ready'} for recognition.\n`);
}

// ---------------------------------------------------------------------------
// ACTION: Test face recognition on a photo
// ---------------------------------------------------------------------------
async function testRecognition(photoPath, threshold = 0.85) {
    console.log(`\n🧪 Testing face recognition...`);
    console.log(`   Photo: ${photoPath}`);
    console.log(`   Threshold: ${threshold}\n`);

    if (!await fs.pathExists(photoPath)) {
        console.error(`❌ File not found: ${photoPath}`);
        process.exit(1);
    }

    const form = new FormData();
    form.append('file', fs.createReadStream(photoPath));

    const result = await compreRequest(
        'POST',
        `/recognize?limit=0&det_prob_threshold=${CONFIG.detProbThreshold}&prediction_count=3&face_plugins=${CONFIG.facePlugins}`,
        form,
        true
    );

    if (!result.result || result.result.length === 0) {
        console.log('   ⚠️  No faces detected in this photo.\n');
        return;
    }

    console.log(`   Found ${result.result.length} face(s):\n`);

    for (let i = 0; i < result.result.length; i++) {
        const face = result.result[i];
        const box = face.box;
        const subjects = face.subjects || [];

        console.log(`   ┌─ Face #${i + 1} ──────────────────────────────`);
        console.log(`   │ Location:   (${box.x_min}, ${box.y_min}) → (${box.x_max}, ${box.y_max})`);
        console.log(`   │ Detection:  ${(box.probability * 100).toFixed(1)}% confidence`);

        if (face.gender) {
            console.log(`   │ Gender:     ${face.gender.value} (${(face.gender.probability * 100).toFixed(0)}%)`);
        }
        if (face.age) {
            console.log(`   │ Age:        ~${face.age.low}-${face.age.high}`);
        }

        if (subjects.length === 0) {
            console.log(`   │ Match:      ❓ Unknown person (no match above threshold)`);
        } else {
            for (const subj of subjects) {
                const isMatch = subj.similarity >= threshold;
                const icon = isMatch ? '✅' : '⚠️';
                console.log(`   │ Match:      ${icon} ${subj.subject} (${(subj.similarity * 100).toFixed(1)}% similarity)`);
            }
        }
        console.log(`   └────────────────────────────────────────\n`);
    }
}

// ---------------------------------------------------------------------------
// ACTION: Delete a subject and all their reference photos
// ---------------------------------------------------------------------------
async function deleteSubject(friendName) {
    console.log(`\n🗑️  Deleting subject "${friendName}" and all reference photos...`);

    try {
        await compreRequest('DELETE', `/subjects/${encodeURIComponent(friendName)}`);
        console.log(`   ✅ Subject "${friendName}" deleted.\n`);
    } catch (error) {
        console.log(`   ❌ Failed to delete. Subject may not exist.\n`);
    }
}

// ---------------------------------------------------------------------------
// ACTION: Bulk upload from a structured directory
// ---------------------------------------------------------------------------
// Expected structure:
//   reference_photos/
//     alice/
//       photo1.jpg
//       photo2.jpg
//     bob/
//       photo1.jpg
//       photo2.jpg
// ---------------------------------------------------------------------------
async function bulkUpload(baseDir) {
    console.log(`\n📦 Bulk uploading from ${baseDir}...\n`);

    if (!await fs.pathExists(baseDir)) {
        console.error(`❌ Directory not found: ${baseDir}`);
        process.exit(1);
    }

    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    const friendDirs = entries.filter(e => e.isDirectory());

    if (friendDirs.length === 0) {
        console.error('❌ No subdirectories found. Expected structure:');
        console.error('   reference_photos/alice/, reference_photos/bob/, etc.');
        process.exit(1);
    }

    console.log(`   Found ${friendDirs.length} friend folder(s): ${friendDirs.map(d => d.name).join(', ')}\n`);

    for (const dir of friendDirs) {
        const friendName = dir.name.toLowerCase();
        const friendPath = path.join(baseDir, dir.name);
        await uploadFaces(friendName, friendPath);
    }

    console.log('\n✅ Bulk upload complete! Run --action=list to verify.\n');
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------
async function main() {
    const args = require('yargs')
        .usage('Usage: $0 --action=<action> [options]')
        .option('action', {
            alias: 'a',
            describe: 'Action to perform',
            choices: ['upload', 'bulk', 'test', 'list', 'delete'],
            demandOption: true,
        })
        .option('friend', {
            alias: 'f',
            describe: 'Friend name (subject) for upload/delete',
            type: 'string',
        })
        .option('photos', {
            alias: 'p',
            describe: 'Path to photos directory (upload) or single photo (test)',
            type: 'string',
        })
        .option('photo', {
            describe: 'Path to a single photo for testing',
            type: 'string',
        })
        .option('dir', {
            alias: 'd',
            describe: 'Base directory for bulk upload (contains friend subdirectories)',
            type: 'string',
            default: './reference_photos',
        })
        .option('threshold', {
            alias: 't',
            describe: 'Confidence threshold for recognition (0.0 - 1.0)',
            type: 'number',
            default: 0.85,
        })
        .option('api-key', {
            describe: 'CompreFace API key (or set CF_RECOGNITION_API_KEY env var)',
            type: 'string',
        })
        .help()
        .argv;

    // Override API key if provided via CLI
    if (args['api-key']) {
        CONFIG.apiKey = args['api-key'];
    }

    if (!CONFIG.apiKey) {
        console.error('\n❌ No API key provided!');
        console.error('   Set CF_RECOGNITION_API_KEY environment variable, or pass --api-key=<key>');
        console.error('   Get your API key from CompreFace admin UI: http://localhost:8000\n');
        process.exit(1);
    }

    switch (args.action) {
        case 'list':
            await listSubjects();
            break;

        case 'upload':
            if (!args.friend || !args.photos) {
                console.error('❌ --friend and --photos are required for upload action');
                process.exit(1);
            }
            await uploadFaces(args.friend, args.photos);
            break;

        case 'bulk':
            await bulkUpload(args.dir);
            break;

        case 'test':
            if (!args.photo) {
                console.error('❌ --photo is required for test action');
                process.exit(1);
            }
            await testRecognition(args.photo, args.threshold);
            break;

        case 'delete':
            if (!args.friend) {
                console.error('❌ --friend is required for delete action');
                process.exit(1);
            }
            await deleteSubject(args.friend);
            break;
    }
}

main().catch(error => {
    console.error('\n💥 Unexpected error:', error.message);
    process.exit(1);
});
```

---

## n8n Workflows

There are 3 main JSON workflows that control the business logic. They represent the pipeline for processing the images.

### Workflow 01-ingest.json
**Description**: Triggers on new Google Drive files, extracts metadata, saves to media cache, records in the database, and calls the `02-process` workflow.

### Workflow 02-process.json
**Description**: Fetches pending media from DB. If video, extracts keyframes using `ffmpeg`. Sends images/keyframes to CompreFace for recognition. Parses recognition results to identify friends, groups media into 6-hour "hangout sessions" (deterministic), and updates media records in DB to 'processed'.

### Workflow 03-deliver.json
**Description**: Triggered by a webhook (geofence or manual). Fetches undelivered media. Implements routing logic (2+ friends -> Group Chat, 1 friend -> DM). Looks up contacts in PostgreSQL, prepares Evolution API payloads, implements random wait delays for WhatsApp ban prevention, sends media to Evolution API, and records delivery logs.

*(Full JSON code for the workflows is excluded here to maintain file size limits, but can be provided on request. They reside in the `workflows/` directory.)*

---

## Current Bug / Unresolved Issue (Evolution API QR Code Generation on WSL2)

**Problem Summary:**
When running the `atendai/evolution-api:v2.2.0` (or `v2.1.1`) Docker container on Windows WSL2, the Baileys library crashes internally during initialization, causing a silent restart loop. As a result, when attempting to create a new WhatsApp instance (`http://localhost:8080/instance/create`), the instance gets created but the QR code generation endpoint (`http://localhost:8080/instance/connect/:instanceName`) repeatedly returns `{"count": 0}` instead of the expected base64 QR code. WhatsApp cannot be paired.

**Observed Logs:**
The `evolution-api` container continuously prints the following in an infinite loop without showing any explicit stack traces or crash errors:
```
INFO   [ChannelStartupService]  [string]  Browser: Evolution API,Chrome,6.6.114.1-microsoft-standard-WSL2 
INFO   [ChannelStartupService]  [string]  Baileys version env: 2,3000,1015901307 
INFO   [ChannelStartupService]  [string]  Group Ignore: false 
```

**What We Know & Have Tried:**
1.  **The `os.release()` Bug in Baileys:** It is a known issue that Baileys relies on Node's `os.release()` to construct the WhatsApp Web Browser connection string. On Windows WSL2, this returns a long, non-standard string (e.g., `6.6.114.1-microsoft-standard-WSL2`), which WhatsApp rejects, causing Baileys to drop the connection and restart.
2.  **Attempted Fix 1 (sed replacement):** We tried modifying the `docker-compose.yml` command to run `sed` on the compiled files to replace `os.release()` with `"10.0"`:
    `command: ["sh", "-c", "find /evolution -name '*.js' -exec sed -i 's/os\\.release()/\"10.0\"/g' {} + && npm run start:prod"]`
    *Result:* The `sed` substitution was applied, but the infinite loop and `{count: 0}` issue persisted.
3.  **Attempted Fix 2 (Node Module Override):** We tried creating a `patch.js` file to override the `os` module globally before starting the server:
    `command: ["sh", "-c", "echo \"const os = require('os'); os.release = () => '10.0';\" > patch.js && node -r ./patch.js dist/main.js"]`
    *Result:* The server started, but the loop persisted.
4.  **Downgrading:** We wiped the database and volumes completely and downgraded to Evolution API `v2.1.1` (which supposedly worked previously). We sent the required payload (`{"instanceName": "autoshare", "integration": "WHATSAPP-BAILEYS", "qrcode": true}`).
    *Result:* The instance created successfully, but the QR code endpoint still returned `{"count": 0}` and the logs showed the exact same Baileys crash loop.

**Goal:**
We need a robust solution to get Evolution API (either v2.2.0 or v2.1.1) to successfully start the Baileys session and generate the pairing QR code on a Windows WSL2 Docker backend, without getting trapped in the `ChannelStartupService` restart loop.
kuda