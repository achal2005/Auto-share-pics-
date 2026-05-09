# Troubleshooting

## 1. Evolution API: QR endpoint returns `{"count": 0}` and Baileys loops

**Symptom**

```
INFO  [ChannelStartupService]  Browser: Evolution API,Chrome,6.6.114.1-microsoft-standard-WSL2
```

repeats forever; `GET /instance/connect/<name>` returns `{"count":0}`.

**Root cause**

Three independent failure modes converge here. Solve them in order.

### 1a. Baileys reports the WSL2 kernel as the browser version

Baileys does `import { release } from 'os'` and embeds the result in the WhatsApp Web browser tuple. WSL2's `os.release()` returns `6.6.114.1-microsoft-standard-WSL2`, which WhatsApp's web protocol rejects → silent reconnect loop.

The original `sed 's/os\.release()/.../'` does **not** match the compiled output, which looks like `(0, os_1.release)()` after TS→CJS. That's why the prior attempts looked like they worked but didn't.

**Fix (already applied in this repo):** Build Evolution API from `evolution/Dockerfile`, which:

1. `COPY`s [evolution/patch.cjs](../evolution/patch.cjs) into the image.
2. Sets `NODE_OPTIONS="--require=/evolution/patch.cjs"` so Node loads the patch *before* `dist/main.js`. The patch mutates the singleton `os` module, so every subsequent `require('os').release` (including destructured imports compiled to `os_1.release`) returns `10.0.22631`.
3. Sets `CONFIG_SESSION_PHONE_CLIENT/NAME/VERSION` env vars in case the running Evolution build reads those instead.

Verify the patch loaded:

```powershell
docker compose logs evolution-api | Select-String "wsl2-patch"
# expect: [wsl2-patch] applied: os.release()='10.0.22631' platform='win32' ...
```

If you don't see that line, the patch never ran — recheck `NODE_OPTIONS` is set in the running container:

```powershell
docker compose exec evolution-api printenv NODE_OPTIONS
```

### 1b. WSL2 clock drift

WhatsApp's handshake includes a timestamp. WSL2's clock drifts seconds-to-minutes after the host laptop sleeps. A drifted clock fails the handshake silently and reconnects.

```powershell
# from PowerShell on the host
wsl --shutdown
# then: open Docker Desktop, restart, retry pairing
```

For a permanent fix on Windows 11:

```powershell
# resync WSL clock on every host wake
wsl -d docker-desktop -u root -- hwclock -s
```

### 1c. IPv6 resolution to web.whatsapp.com fails inside WSL2

If your Docker network has IPv6 enabled but no IPv6 egress, Baileys spends 75 seconds timing out before falling back to IPv4 and the QR never appears within the user-facing window.

```powershell
# disable IPv6 in Docker Desktop: Settings -> Resources -> Network -> uncheck IPv6
```

Or pin DNS to a v4-only resolver inside the container by adding to the `evolution-api` service:

```yaml
dns:
  - 1.1.1.1
  - 8.8.8.8
```

### Pairing flow after the fix

```powershell
docker compose up -d --build evolution-api
node scripts/pair-whatsapp.js
# QR renders inline; scan with phone -> Linked Devices -> Link a Device
```

---

## 2. n8n returns 401 on every request

You set `N8N_AUTH_USER`/`N8N_AUTH_PASSWORD` but the original compose file never wired them. The audited [docker-compose.yml](../docker-compose.yml) sets `N8N_BASIC_AUTH_ACTIVE=true` and references both variables. Re-up:

```powershell
docker compose up -d n8n
```

If you still get 401, you may have an old n8n session cached — clear browser cookies for `localhost:5678`.

---

## 3. CompreFace returns 401 with "API key not found"

Two distinct API keys exist in CompreFace:
- **Recognition** — used by n8n + `setup-compreface.js`.
- **Detection** — different service, different key.

`CF_RECOGNITION_API_KEY` must come from a **Recognition** service inside the AutoSharePics application. If you accidentally created a Detection service, recognition calls 401.

---

## 4. Photos with friends are sent to the wrong person

**Most common cause: too few reference photos per friend.**

CompreFace's similarity score is *relative*. With only Alice and Bob enrolled, every face in every photo gets compared to just Alice and Bob — and one of them always wins, often above your threshold. Result: a stranger's face is "recognized" as Alice.

Mitigations (apply all):
1. Enroll ≥5 reference photos per friend (the audited `setup-compreface.js` enforces this).
2. Raise `FACE_CONFIDENCE_THRESHOLD` to `0.90`.
3. Add an "unknown" subject populated with random non-friend faces. CompreFace's softmax pushes unknowns toward this bucket.
4. In `02-process`, drop matches where the second-place candidate is within `0.05` of the first (ambiguous) — see [docs/ARCHITECTURE.md](ARCHITECTURE.md#confidence-aware-routing).

---

## 5. HEIC photos arrive but produce 0 faces

CompreFace cannot read HEIC. Conversion happens in `02-process` via `heic-convert`. Verify it's installed in the n8n container:

```powershell
docker compose exec n8n node -e "console.log(require('heic-convert'))"
```

If you see `Cannot find module`, the image must be rebuilt or `NODE_FUNCTION_ALLOW_EXTERNAL` is missing `heic-convert`. The audited compose includes it.

---

## 6. Duplicate sends after a retry

You hit this if the original schema's blocking unique index `idx_delivery_dedup` was in place: the second attempt failed insert, the workflow logged "duplicate," and you assumed the message was sent.

Apply [db/init/002_migrations.sql](../db/init/002_migrations.sql), which:
- Replaces the blocking unique with a *partial* unique on `status IN ('sent','delivered','read')` only.
- Adds an `idempotency_key` column the workflow uses to make retries deterministic.

---

## 7. Postgres `psql: connection refused`

The audited compose doesn't publish the Postgres host port by default. Either:
1. Uncomment the `ports:` block under `app-postgres` in compose, OR
2. Run psql via `docker compose exec`:

```powershell
docker compose exec app-postgres psql -U $env:APP_DB_USER -d $env:APP_DB_NAME
```

---

## 8. n8n cannot find `media_cache` files

Different services mount the cache at different paths:
- n8n: `/home/node/media_cache`
- Evolution API: `/evolution/media_cache`

When `03-deliver` builds the Evolution payload, the `media_path` must use the **Evolution-side** path. Set it in the workflow's prep node:

```js
const filename = item.local_path.split('/').pop();
return { media_path: `/evolution/media_cache/${filename}` };
```

---

## 9. Google Drive trigger never fires

n8n's Google Drive node uses *polling*, not push. Default interval is 1 minute, so plan for that latency. If polling has stopped:

1. n8n -> Workflows -> 01-ingest -> open the trigger -> "Listen for events" tab to confirm it's active.
2. Re-auth the Google Drive credential — refresh tokens occasionally expire.
3. Check executions log for the trigger; OAuth failures show as red.

There is no Drive push fallback in this stack — if n8n is down, photos accumulate in Drive and ingest catches up on next start (which is fine; `gdrive_file_id` UNIQUE prevents reprocessing).

---

## 10. Disk fills up

`media_cache` and Postgres grow without bound by default. The audited migration adds `sweep_retention()`. Schedule it from n8n on a cron trigger:

```sql
SELECT * FROM sweep_retention();
```

To purge media files from the host volume after the DB sweep:

```powershell
docker compose exec n8n sh -c 'find /home/node/media_cache -type f -mtime +365 -delete'
```
