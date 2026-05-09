# AutoSharePics — Production Audit

Date: 2026-05-09

## 1. Executive Summary

### Risk matrix

| ID | Severity | Area | Issue |
|---|---|---|---|
| C1 | **Critical** | Infra | Evolution API `sed` patch doesn't match TS-emitted `os_1.release()` — Baileys silently loops on WSL2, no QR ever issues |
| C2 | **Critical** | Security | `N8N_AUTH_USER/PASSWORD` in `.env` were never wired into compose → n8n is open to anyone on `localhost:5678` |
| C3 | **Critical** | Security | `CF_DB_PASSWORD` defaults to a hardcoded literal in compose — silent fallback if `.env` is missing |
| C4 | **Critical** | Data integrity | Original `idx_delivery_dedup` blocks legitimate retries; `02-process` race can create duplicate sessions |
| C5 | **Critical** | Privacy | `consent_given` exists but no workflow checks it; no erasure path; no retention policy |
| H1 | High | CompreFace | False-positive risk with <5 friends — strangers get classified as Alice, sent to Alice's DM |
| H2 | High | Workflow | Webhook for `03-deliver` lacks HMAC verification |
| H3 | High | Schema | Foreign keys lack `ON DELETE` behavior — deleting a session fails or orphans rows |
| H4 | High | Schema | Status fields are free-text VARCHAR — typos pass validation, break dispatch |
| H5 | High | Reliability | No healthcheck on Evolution API → orchestrator can't tell pairing has stopped working |
| H6 | High | Operations | n8n keeps execution history forever → unbounded disk growth and PII retention |
| H7 | High | Security | CompreFace UI listens on `0.0.0.0:8000` with no auth — admin takeover from LAN |
| M1 | Medium | Tuning | `CF_IMG_LIMIT=640` loses faces in group photos; raise to 1024 |
| M2 | Medium | Tuning | Default thresholds (`0.85`, gap-blind) cause confusable-friend swaps |
| M3 | Medium | Code | `setup-compreface.js`: glob v9 API mismatch, no 429 handling, no HEIC support |
| M4 | Medium | Compose | No memory/CPU limits — one runaway process OOMs the host |
| M5 | Medium | Operations | No backup/restore docs for `app_postgres_data` or `compreface_postgres_data` |
| M6 | Medium | Operations | `media_cache` volume grows without bound — no retention sweeper |
| L1 | Low | Schema | Missing partial indexes for hot dispatch query |
| L2 | Low | Tooling | No env validator — silent placeholder values reach runtime |
| L3 | Low | Docs | No troubleshooting, no architecture diagram, no GDPR runbook |

## 2. Detailed findings

### C1 — Evolution WSL2 Baileys loop

**Current behavior.** `docker-compose.yml` shipped with:

```yaml
command: ["sh","-c","find /evolution/dist -name '*.js' -exec sed -i 's/os\\.release()/\"10.0\"/g' {} + && npm run start:prod"]
```

The TypeScript source in Evolution API uses `import { release } from 'os'`, which the build emits as:

```js
const os_1 = require("os");
// ...
(0, os_1.release)()
```

`s/os\.release()/.../` does not match `os_1.release()`, so the patch is a no-op. The browser tuple is constructed with the WSL2 kernel string, WhatsApp rejects it, Baileys reconnects, loop forever. The user's prior log confirms this: `Browser: Evolution API,Chrome,6.6.114.1-microsoft-standard-WSL2`.

**Risk.** Pairing impossible on WSL2 → blocks every fresh install on Windows.

**Fix.** Build a custom image with [evolution/Dockerfile](../evolution/Dockerfile) that:
1. `COPY`s [evolution/patch.cjs](../evolution/patch.cjs) into `/evolution/`.
2. Sets `NODE_OPTIONS=--require=/evolution/patch.cjs` so the patch loads before the app's first `import { release } from 'os'`. Mutating `os.release` on the singleton works because Node compiles destructured imports to `os_1.release(...)` — a live property access on the cached module.
3. Sets `CONFIG_SESSION_PHONE_*` env vars as a belt-and-braces.

Two adjacent root causes also need to be addressed (clock drift, IPv6 timeout) — see [docs/TROUBLESHOOTING.md §1](TROUBLESHOOTING.md).

### C2 — n8n basic auth not wired

**Current behavior.** `.env.example` defines `N8N_AUTH_USER`/`N8N_AUTH_PASSWORD` but the original compose file doesn't reference them. n8n boots without basic auth — anyone on the host network reaches the workflow editor.

**Fix.** Audited compose adds:

```yaml
N8N_BASIC_AUTH_ACTIVE: "true"
N8N_BASIC_AUTH_USER: ${N8N_AUTH_USER:?Set N8N_AUTH_USER in .env}
N8N_BASIC_AUTH_PASSWORD: ${N8N_AUTH_PASSWORD:?Set N8N_AUTH_PASSWORD in .env}
N8N_ENCRYPTION_KEY: ${N8N_ENCRYPTION_KEY:?Set N8N_ENCRYPTION_KEY in .env}
```

The `:?` guard fails compose-up if any is missing. `N8N_ENCRYPTION_KEY` is the single most catastrophic secret to lose — added to validator.

### C3 — Hardcoded CompreFace DB password fallback

**Current.** `POSTGRES_PASSWORD: ${CF_DB_PASSWORD:-compreface_secret}`. If `.env` lacks the var, the DB silently boots with a public-knowledge default.

**Fix.** Audited compose uses `${CF_DB_PASSWORD:?Set CF_DB_PASSWORD in .env}` and the validator forbids reusing `APP_DB_PASSWORD`.

### C4 — Delivery dedup blocks retries; session race

**Delivery dedup.** The original `UNIQUE INDEX idx_delivery_dedup (media_file_id, recipient_jid)` rejects a retry insert after a `failed` row exists. Retries silently fail; operator believes the message was already sent.

**Fix in [002_migrations.sql](../db/init/002_migrations.sql):** drop the blocking unique, add a partial unique only over successful states:

```sql
CREATE UNIQUE INDEX idx_delivery_dedup_success
    ON delivery_logs (media_file_id, recipient_jid)
    WHERE status IN ('sent', 'delivered', 'read');
```

Plus an `idempotency_key` column with its own unique index for in-flight protection.

**Session race.** Two photos arriving inside the same `02-process` execution can both miss the "current session" lookup and `INSERT` two new sessions. The fix is a SQL function `attach_to_session()` that wraps the lookup-or-insert under `pg_advisory_xact_lock` so concurrent callers serialize.

### C5 — GDPR consent / erasure

**Current.** `friends_contacts.consent_given` exists but no workflow checks it. There is no path to erase a friend's data. There is no retention policy, so face metadata accumulates forever.

**Fix.** Migration adds:
- `deleted_at`, `erasure_requested_at`, `data_retention_days` on `friends_contacts`.
- `erase_friend(subject)` SQL function that strips face data and anonymizes delivery logs.
- `sweep_retention()` for periodic purge — schedule via n8n cron.
- Workflow change required (manually applied to the JSON in n8n UI): `03-deliver` must filter `WHERE deleted_at IS NULL AND consent_given = true AND is_active = true` when joining `friends_contacts`.

### H1 — False-positive risk in small subject sets

**Mechanism.** CompreFace returns the *closest* enrolled subject. With Alice and Bob enrolled, every face in every photo is classified as Alice or Bob — even strangers' faces, often above 0.85 similarity.

**Fix (defense in depth):**
1. Raise default `FACE_CONFIDENCE_THRESHOLD` to `0.88`.
2. Implement an ambiguity gap check: reject if `top - second < 0.05` (the audited [docs/ARCHITECTURE.md §confidence-aware-routing](ARCHITECTURE.md#confidence-aware-routing) provides the snippet for the n8n Function node).
3. Recommend enrolling an "unknown" subject with non-friend faces — softmax pushes strangers there.
4. The audited setup script enforces `>=5 reference photos per subject` before declaring "ready."

### H2 — Geofence webhook unauthenticated

**Current.** `GEOFENCE_WEBHOOK_SECRET` exists but the workflow doesn't verify it. Anyone who learns the public webhook URL can trigger delivery.

**Fix.** First node in `03-deliver` must compute `HMAC-SHA256(rawBody, GEOFENCE_WEBHOOK_SECRET)` and constant-time compare to `X-Hub-Signature-256`. n8n Function node:

```js
const crypto = require('crypto');
const sig = $input.item.json.headers['x-hub-signature-256'] || '';
const body = JSON.stringify($input.item.json.body);
const expected = 'sha256=' + crypto.createHmac('sha256', $env.GEOFENCE_WEBHOOK_SECRET).update(body).digest('hex');
const ok = sig.length === expected.length &&
           crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
if (!ok) throw new Error('Invalid signature');
return $input.item;
```

### H3 / H4 — Schema constraints

Migration adds `CHECK` constraints on every status/enum field, `ON DELETE CASCADE` for `delivery_logs.media_file_id`, `ON DELETE SET NULL` for `media_files.session_id` and `delivery_logs.session_id`, plus phone-format and lowercase-subject checks.

### H5 — Evolution healthcheck

Audited compose adds a healthcheck that hits `localhost:8080/` and looks for "evolution" in the body — basic but catches a hung Baileys session. With `start_period: 90s` the Docker scheduler tolerates the cold-start.

### H6 — n8n execution history

Audited compose:

```yaml
EXECUTIONS_DATA_PRUNE: "true"
EXECUTIONS_DATA_MAX_AGE: "168"
EXECUTIONS_DATA_PRUNE_MAX_COUNT: "10000"
```

7-day retention. Production overlay tightens to 72h.

### H7 — CompreFace LAN exposure

Audited compose binds `compreface-fe` to `127.0.0.1` only:

```yaml
ports:
  - "127.0.0.1:${CF_API_PORT:-8000}:80"
```

Production overlay drops the host port entirely; access goes through Caddy at `/cf` with basic-auth.

### M1 / M2 — Tuning

`.env.example` defaults updated:
- `CF_IMG_LIMIT=1024` (was 640)
- `FACE_CONFIDENCE_THRESHOLD=0.88` (was 0.85)
- `WA_MIN_DELAY_MS=4000`, `WA_MAX_DELAY_MS=12000`, `WA_BATCH_SIZE=8`, `WA_BATCH_COOLDOWN_MS=180000` — slightly more conservative, real ban incidents have been reported with the originals on accounts >1 year old.

### M3 — `setup-compreface.js`

Rewrite covers: glob v9+ correct usage, exponential backoff on 429/5xx, HEIC support via `heic-convert`, lowercase normalization to match the new DB CHECK, "ready" only when `>=5` enrolled embeddings exist.

### M4 — Resource limits

All services have `deploy.resources.limits.memory` set; CompreFace core gets `2G` (it's the OOM offender at scale); n8n gets `1G`; everything else proportional. Honored on Docker 23+ with the default compose plugin.

### M5 — Backup/restore

Add to `docs/SECURITY_TESTING_DEPLOYMENT.md` (new section):

```powershell
# Postgres dump (run from host)
docker compose exec -T app-postgres pg_dump -U $env:APP_DB_USER $env:APP_DB_NAME `
  | Out-File -Encoding utf8 backups/app-$(Get-Date -Format yyyyMMdd-HHmm).sql

# CompreFace embeddings (the biometric data)
docker compose exec -T compreface-postgres pg_dump -U $env:CF_DB_USER frs `
  | Out-File -Encoding utf8 backups/cf-$(Get-Date -Format yyyyMMdd-HHmm).sql
```

Schedule weekly via Task Scheduler / cron. Restore is `psql < dump`.

### M6 — Disk retention

`sweep_retention()` SQL function. Schedule from n8n with a Cron + Postgres node:

```sql
SELECT * FROM sweep_retention();
```

### L1 / L2 / L3

Partial indexes added; [scripts/validate-env.js](../scripts/validate-env.js) blocks `CHANGE_ME` placeholders; [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md) and [docs/ARCHITECTURE.md](ARCHITECTURE.md) cover the runbook gap.

## 3. Implementation roadmap

### Phase 1 — Critical (do today)

1. Build new Evolution image: `docker compose build evolution-api`.
2. Apply migrations:

   ```powershell
   docker compose exec -T app-postgres psql -U $env:APP_DB_USER -d $env:APP_DB_NAME `
     < db/init/002_migrations.sql
   ```
3. Add new secrets to `.env` (`N8N_ENCRYPTION_KEY`, regenerate every password). Run `node scripts/validate-env.js`.
4. `docker compose up -d --force-recreate` to pick up the new compose file.
5. Pair WhatsApp: `node scripts/pair-whatsapp.js`.
6. Edit each n8n workflow to: (a) verify HMAC in `03-deliver`, (b) call `attach_to_session()` instead of inline session SQL in `02-process`, (c) join `friends_contacts WHERE consent_given AND is_active AND deleted_at IS NULL`.

### Phase 2 — High (this week)

1. Implement confidence-aware routing snippet in `02-process`.
2. Backfill `>=5 photos` per friend; re-run `node scripts/setup-compreface.js --action=list`.
3. Schedule retention sweeper via n8n Cron (daily 03:00 local).
4. Hook host backup script for both Postgres volumes.

### Phase 3 — Medium (this month)

1. Stand up production overlay (`docker-compose.prod.yml`) with Caddy + Loki on the public host.
2. Document and dry-run a GDPR erasure: `SELECT erase_friend('alice')`.
3. Add Grafana board fed by Loki for delivery success/failure trends.

### Phase 4 — Low

1. Switch to GPS-aware session clustering once `gps_latitude/longitude` are populated reliably.
2. Add a "review" path for low-confidence matches (DM operator before sending).
3. Reference-photo refresh reminder (faces drift).

## 4. File index

| File | Purpose |
|---|---|
| [docker-compose.yml](../docker-compose.yml) | Hardened dev stack |
| [docker-compose.prod.yml](../docker-compose.prod.yml) | Caddy + Loki production overlay |
| [evolution/Dockerfile](../evolution/Dockerfile) | WSL2-patched Evolution API build |
| [evolution/patch.cjs](../evolution/patch.cjs) | Mutates `os` singleton at module load |
| [caddy/Caddyfile](../caddy/Caddyfile) | TLS-terminating reverse proxy |
| [monitoring/promtail.yml](../monitoring/promtail.yml) | Docker log shipping → Loki |
| [db/init/001_schema.sql](../db/init/001_schema.sql) | Original schema (untouched) |
| [db/init/002_migrations.sql](../db/init/002_migrations.sql) | Additive constraints, GDPR, idempotency |
| [scripts/validate-env.js](../scripts/validate-env.js) | Pre-flight env check |
| [scripts/setup-compreface.js](../scripts/setup-compreface.js) | Audited rewrite with retry + HEIC |
| [scripts/pair-whatsapp.js](../scripts/pair-whatsapp.js) | One-shot QR pairing helper |
| [.env.example](../.env.example) | Hardened template, no defaults for secrets |
| [docs/ARCHITECTURE.md](ARCHITECTURE.md) | Mermaid data-flow + invariants |
| [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Failure-mode runbook (WSL2 + 9 others) |

## 5. Constraints honored

- 100% self-hosted: only external dependencies are Google Drive (n8n OAuth) and WhatsApp itself.
- WSL2 Docker: addressed via `evolution/Dockerfile` + clock-drift / IPv6 notes.
- All schema changes are additive (`ALTER TABLE … IF NOT EXISTS`, `CREATE … IF NOT EXISTS`); existing data is preserved.
- HEIC handled in both setup script and `02-process` documentation.
- Group photos with 5–15 people: `CF_IMG_LIMIT=1024` + `FACE_DETECT_LIMIT=15`.
- WhatsApp ban prevention: throttle defaults loosened.
