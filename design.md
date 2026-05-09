# AutoSharePics — Design

## Goal

Take photos and videos shot during a hangout, automatically figure out which friends are in them using face recognition, and deliver the originals (full quality) to those friends over WhatsApp — without manual sorting or uploading.

## Non-goals

- A photo *editor*. We pass originals through; we don't recompress, color-correct, or stylize.
- A *cloud* product. Everything self-hosts on a single host (typical: a NUC, a workstation, or a VPS). Cost target: electricity only.
- A *general* messaging integration. WhatsApp via Evolution API is the only delivery channel in scope.
- *Real-time* delivery. The pipeline is batch-oriented and tolerates minutes of latency in exchange for ban safety.

## Constraints that shape the design

1. **WhatsApp bans are silent and permanent.** Sending must look human: random delays, batch cooldowns, no bursts. This is the dominant non-functional requirement.
2. **iPhone HEIC + originals.** Source files are HEIC photos and high-bitrate videos. To preserve quality, photos are sent **as documents**, not as compressed media attachments.
3. **Face recognition is fuzzy.** A 0.85 similarity threshold is a tuned compromise; below it we get false positives, above it we miss people in side profiles or low light.
4. **GDPR / consent.** Friends must opt in before we store their face. The schema models this (`consent_given`, `consent_date`) and the operator is expected to honor it.
5. **Single-host failure domain.** No HA, no clustering. Everything runs in `docker-compose` on one machine. Recovery = restart container or restore volume.

## Architecture

```
┌────────────┐   sync    ┌──────────────┐  poll   ┌─────────────────────────────┐
│  iPhone    │──────────▶│ Google Drive │────────▶│ n8n: 01-ingest              │
│  (camera)  │           │  (folder)    │         │  download → cache → DB row  │
└────────────┘           └──────────────┘         └────────────┬────────────────┘
                                                               │ trigger
                                                               ▼
       ┌──────────────┐  HTTP   ┌─────────────────────────────────────────────┐
       │  CompreFace  │◀────────│ n8n: 02-process                             │
       │ (face AI)    │ recog.  │  HEIC→JPEG, video→keyframes, recognize,     │
       └──────────────┘────────▶│  cluster into 6h sessions, mark processed   │
                                └────────────┬────────────────────────────────┘
                                             │ webhook (geofence / manual)
                                             ▼
       ┌────────────────┐ HTTP  ┌─────────────────────────────────────────────┐
       │ Evolution API  │◀──────│ n8n: 03-deliver                             │
       │ (WhatsApp GW)  │ send  │  route by friend count, throttle, log        │
       └───────┬────────┘       └────────────┬────────────────────────────────┘
               │                              │
               ▼                              ▼
         WhatsApp Web                  PostgreSQL (state, logs)
```

All services live behind a private Docker network. Only n8n (`5678`), CompreFace (`8000`), and Evolution API (`8080`) expose host ports for the operator.

## Pipeline stages

### Stage 1 — Ingest (`workflows/01-ingest.json`)

**Trigger:** Google Drive watch on `GDRIVE_FOLDER_ID`.

**Steps:**
1. Download the new file to the `media_cache` Docker volume.
2. Extract EXIF (`taken_at`, GPS, camera model). HEIC needs a sidecar tool because n8n's image node doesn't read it natively.
3. Insert a `media_files` row with `status='pending'`, `gdrive_file_id` (UNIQUE — dedup), and `idempotency_key`.
4. Fire-and-forget: trigger `02-process`.

**Why split from process:** Drive's polling cadence is unpredictable; ingest needs to be cheap and fast so we don't drop events. Processing is heavy (face AI, ffmpeg) and benefits from being independently retryable.

### Stage 2 — Process (`workflows/02-process.json`)

**Trigger:** explicit call from `01-ingest`, or a cron-based sweep over `status='pending'` rows for retry.

**Steps:**
1. Mark `status='processing'`, increment `process_attempts`.
2. **If video:** extract N keyframes with `ffmpeg -vf fps=1/<interval>` to a temp dir. Upper bound on keyframes (`FACE_DETECT_LIMIT`) keeps long clips bounded.
3. **If HEIC:** convert to JPEG (CompreFace can't read HEIC).
4. POST each frame to CompreFace `/recognize` with `det_prob_threshold=0.8`. Parse the response:
   - For each face, take the top `prediction_count=3` candidates.
   - A friend is "identified" if any candidate's `similarity ≥ FACE_CONFIDENCE_THRESHOLD` (default `0.85`).
5. **Session clustering** (deterministic): query the most recent `hangout_sessions` row. If `(this.taken_at - last.ended_at) < 6h`, attach to that session and extend `ended_at`. Otherwise create a new session. Update `friends_present` (set union).
6. Persist `faces_recognized` (full JSONB), `friends_identified` (text[]), `session_id`. Set `status='processed'`.

**Why determinism matters:** sessions are recomputable from `media_files.taken_at` alone. If `hangout_sessions` is corrupted, we can rebuild it. Avoid any logic that depends on session creation order.

### Stage 3 — Deliver (`workflows/03-deliver.json`)

**Trigger:** webhook with `GEOFENCE_WEBHOOK_SECRET` (from iOS Shortcut) or manual hit. Not a cron — delivery is intentionally operator/event-driven so we don't ship while the hangout is still in progress.

**Steps:**
1. Read `v_ready_to_deliver` (already filtered to `status='processed'` and not yet logged).
2. For each row, **route**:
   - 0 friends → skip (mark `status='skipped'`, no delivery).
   - 1 friend → DM that friend's `whatsapp_jid`.
   - ≥2 friends → group chat (`WHATSAPP_GROUP_JID`).
3. **Send shape:**
   - photos: `sent_as='document'` to preserve original quality.
   - videos: `sent_as='media'` (WhatsApp re-encodes anyway; document mode often fails for videos).
4. **Throttle** between sends: `random(WA_MIN_DELAY_MS, WA_MAX_DELAY_MS)`. After `WA_BATCH_SIZE` messages, sleep `WA_BATCH_COOLDOWN_MS`.
5. Insert a `delivery_logs` row. The `(media_file_id, recipient_jid)` UNIQUE index is the safety net — if anything double-fires, the second send fails on insert before hitting Evolution API.
6. Update `media_files.status='delivered'` once **all** required recipients are logged.

## Data model rationale

- **Why a separate `friends_contacts.subject_name`?** CompreFace identifies people by an opaque "subject" string. Decoupling that from `display_name` lets us rename friends in the UI without re-uploading reference photos.
- **Why a JID *and* a phone number?** Storing both means we never have to recompute the JID at send time. The trigger `set_whatsapp_jid` keeps them in sync.
- **Why `friends_identified TEXT[]` *and* `faces_recognized JSONB`?** Routing only needs the names (cheap GIN index for "find all photos with Alice"). Diagnostics need bounding boxes and similarities — keep those in JSONB so the hot path doesn't pay for them.
- **Why is `delivery_logs` keyed on `(media_file_id, recipient_jid)`?** Same media can legitimately go to multiple recipients (group + DMs). It must NOT go to the same recipient twice. That's exactly the index.

## Failure modes & recovery

| Failure | Detection | Recovery |
|---|---|---|
| Google Drive transient 5xx | n8n node retry | Built-in n8n retry with backoff |
| HEIC→JPEG conversion fails | exception in `02-process` | Mark `status='failed'`, log to `last_error`, manual retry |
| CompreFace returns no faces | empty `result` array | Mark `status='processed'`, `friends_identified='{}'` → routes to `skip` in delivery |
| WhatsApp send 4xx (rate limit) | Evolution returns error | Bump `delivery_logs.retry_count`, back off the whole batch (cooldown) |
| WhatsApp send 5xx | network error | Same as rate limit; if persistent, mark `status='failed'` |
| Evolution disconnect | Baileys reconnect loop | **Known issue on WSL2.** See `CLAUDE.md`. Pairing must succeed before delivery works. |
| Duplicate Drive trigger | UNIQUE on `gdrive_file_id` | DB rejects insert; n8n catches and skips |
| Operator wants to "rewind" a session | manual SQL | Set `delivery_logs.status='cancelled'` and `media_files.status='processed'`; next delivery run will resend |

## Tunables

| Knob | Default | Effect |
|---|---|---|
| `FACE_CONFIDENCE_THRESHOLD` | `0.85` | Higher = fewer false positives, more missed friends |
| `FACE_DETECT_LIMIT` | `10` | Caps faces per image (and keyframes per video) |
| `CF_IMG_LIMIT` | `640` | Max image dimension CompreFace processes — speed vs accuracy |
| `WA_MIN_DELAY_MS` / `WA_MAX_DELAY_MS` | `3000` / `8000` | Per-message jitter to mimic human pace |
| `WA_BATCH_SIZE` / `WA_BATCH_COOLDOWN_MS` | `10` / `120000` | Long pause every N sends |
| Session window | `6h` (hardcoded in `02-process`) | Larger = fewer sessions, blurrier "events" |

Don't tighten the WhatsApp throttles to "go faster." The defaults are the safe regime.

## Security posture

- Single-host, behind home NAT by default. No inbound from the internet except optional Caddy reverse proxy (not in default compose).
- `.env` is the secrets store. `evolution_api_key`, `cf_recognition_api_key`, `geofence_webhook_secret`, all DB passwords live there.
- The webhook for `03-deliver` requires `GEOFENCE_WEBHOOK_SECRET` as a header — minimal but non-zero protection if the host is exposed.
- CompreFace stores reference face embeddings in its own PostgreSQL (volume `compreface_postgres_data`). That volume is the consent record. Backing it up is backing up biometric data — treat accordingly.
- See [docs/SECURITY_TESTING_DEPLOYMENT.md](docs/SECURITY_TESTING_DEPLOYMENT.md) for the deployment-hardening checklist.

## Things explicitly *not* in the design

- A web UI. n8n and CompreFace ship admin UIs; the app itself is headless.
- Per-friend opt-out at delivery time. Today the only "opt out" is `is_active=false` on `friends_contacts` or `consent_given=false`. There is no fine-grained "skip me on this session."
- Multi-tenant. The DB schema and routing assume one operator, one social graph.
- Cloud storage offload. Originals live in `media_cache` indefinitely. Operator manages retention with a cron — see `db/sample_queries.sql`.

## Open questions / future work

- **Resolve the Baileys/WSL2 QR loop.** Currently the biggest blocker for fresh installs on Windows hosts. Tracked in [CLAUDE.md](CLAUDE.md#known-issues) and [project_context.md](project_context.md).
- **Smarter session boundaries.** A flat 6-hour window misclusters back-to-back hangouts on the same day. Consider GPS-aware clustering once `gps_latitude/longitude` are reliably populated.
- **Confidence-aware routing.** Today a friend at 0.86 similarity is treated identically to 0.99. A "low-confidence → DM the operator for review" path would reduce embarrassing misroutes.
- **Reference photo refresh.** Faces drift (haircuts, glasses). No mechanism today to age out old embeddings.
