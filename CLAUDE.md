# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project: AutoSharePics

Self-hosted pipeline that automatically distributes hangout photos to friends via WhatsApp using AI face recognition.

**Flow:** iPhone Camera → Google Drive → n8n (Ingest → Process → Deliver) → WhatsApp
**Side systems:** PostgreSQL (state), CompreFace (face AI), Evolution API (WhatsApp gateway)

## Repository layout

- [docker-compose.yml](docker-compose.yml) — full service stack
- [db/init/](db/init/) — schema migrations auto-run on first PostgreSQL boot
- [db/sample_queries.sql](db/sample_queries.sql) — operator queries
- [workflows/](workflows/) — n8n workflow JSON (`01-ingest`, `02-process`, `03-deliver`)
- [scripts/setup-compreface.js](scripts/setup-compreface.js) — CLI for uploading friend reference photos
- [docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md) — step-by-step install
- [docs/SECURITY_TESTING_DEPLOYMENT.md](docs/SECURITY_TESTING_DEPLOYMENT.md) — security/test/deploy notes

## Common commands

```bash
# Start everything
docker-compose up -d

# Tail a service
docker-compose logs -f n8n
docker-compose logs -f evolution-api

# Reset (destructive — wipes volumes)
docker-compose down -v

# Upload reference faces to CompreFace
cd scripts && npm install
node setup-compreface.js --action=bulk --dir=../reference_photos --api-key=$CF_RECOGNITION_API_KEY

# Test recognition on one photo
node setup-compreface.js --action=test --photo=./test.jpg --threshold=0.85

# WhatsApp instance bootstrap
curl -X POST http://localhost:8080/instance/create \
  -H "apikey: $EVOLUTION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"instanceName":"autoshare","integration":"WHATSAPP-BAILEYS","qrcode":true}'
```

Service URLs (local): n8n `:5678`, CompreFace `:8000`, Evolution API `:8080`, PostgreSQL `:5433`.

## Database

Single PostgreSQL instance shared by n8n, the app, and Evolution API (CompreFace has its own).

Tables (see [db/init/001_schema.sql](db/init/)):
- `friends_contacts` — CompreFace `subject_name` ↔ WhatsApp JID. JID is auto-derived via trigger.
- `hangout_sessions` — 6-hour time-windowed groupings. `is_delivered` gates delivery.
- `media_files` — every photo/video. Status: `pending → processing → processed → delivered | failed | skipped`. `gdrive_file_id` and `idempotency_key` enforce dedup.
- `delivery_logs` — one row per send. Unique index on `(media_file_id, recipient_jid)` prevents duplicate sends.

Helper views: `v_ready_to_deliver`, `v_session_summary`.

## Working in this repo

- **n8n workflows are the source of truth for business logic.** Don't reimplement routing in scripts; edit the JSON in `workflows/` (export from n8n UI after editing, then commit).
- **Routing rule:** photos with ≥2 friends → group chat as document; photos with 1 friend → DM as document; videos → sent as media.
- **Session windowing:** new session starts when there's a 6+ hour gap between photo `taken_at` timestamps. Sessions are deterministic — recompute, don't mutate.
- **Idempotency is non-negotiable.** Always honor `gdrive_file_id` UNIQUE and the `delivery_logs` dedup index. WhatsApp double-sends are user-visible failures.
- **Rate limiting matters.** WhatsApp bans are real. Respect `WA_MIN_DELAY_MS`/`WA_MAX_DELAY_MS`/`WA_BATCH_SIZE`/`WA_BATCH_COOLDOWN_MS`. Don't add a "fast path" that skips delays.
- **Secrets stay in `.env`.** Never commit `.env`, `reference_photos/`, or extracted `media_cache` content.
- **Schema changes go through `db/init/`** as new numbered files (`002_*.sql`, `003_*.sql`). The mount is init-only — existing DBs need manual migration.

## Known issues

- **Evolution API on Windows WSL2 QR code loop (MITIGATED).** Baileys uses `os.release()`, `os.platform()`, and `os.type()` to build the WhatsApp browser connection string. WSL2 returns Linux kernel values that WhatsApp rejects, causing a silent reconnect loop. **Current fix:** `evolution/patch.cjs` is loaded via `NODE_OPTIONS=--require` (baked into `evolution/Dockerfile`) and overrides all OS detection functions to return Windows-like values. The old `sed` hack in `docker-compose.yml` `command:` is removed. If the loop persists after `docker compose up -d --build`, check `docker compose logs -f evolution-api` for `[wsl2-patch] applied:` — if it doesn't appear, the patch isn't loading.

## Recent changes (2026-05-29)

- **WSL2 patch hardened:** `evolution/patch.cjs` now overrides `os.release()`, `os.type()`, `os.version()`, and `os.hostname()` (`os.platform()` is intentionally not overridden to avoid breaking native binaries). Dockerfile sets `CACHE_LOCAL_ENABLED=true` (required for session persistence).
- **Workflow 01:** Added "Extract EXIF Data" node between photo metadata and save. `taken_at` now comes from EXIF `DateTimeOriginal` instead of Google Drive's upload timestamp.
- **Workflow 02:** Added "Mark Processing" node after loading pending media — prevents infinite retries on failure. Added "Convert HEIC if Needed" + "Read Converted Photo" nodes for iPhone HEIC→JPEG conversion before CompreFace.
- **Schema 001:** Aligned status CHECK to include `'erased'`, dedup index now excludes `'pending'` (matches 002).
- **docker-compose.yml:** n8n entrypoint installs `exifreader` and `heic-convert` on first boot.

## Conventions

- PowerShell is the default shell; Bash is available via the Bash tool. Use forward slashes for paths inside Docker; backslashes only for host paths in PS examples.
- `subject_name` in CompreFace **must exactly match** `friends_contacts.subject_name` (case-sensitive). Lower-case everything by convention.
- Phone numbers: country-code-prefixed digits only, no `+` (e.g. `919876543210`). The DB trigger appends `@s.whatsapp.net`.
- Confidence threshold `0.85` is the tuned default. Don't change without re-running `--action=test` on a labeled set.
