# Security, Testing & Deployment Guide

## 🔐 Security & Privacy (Part 7)

### CompreFace Biometric Data Protection
- **Never expose port 8000 to the internet** — it's on Docker internal network only
- Face embeddings are stored in CompreFace's own PostgreSQL, never transmitted externally
- No cloud API ever sees your friends' faces

### WhatsApp Ban Prevention Strategy
```
Rate Limiting Config (.env):
  WA_MIN_DELAY_MS=3000      # 3 sec minimum between messages
  WA_MAX_DELAY_MS=8000      # 8 sec maximum (random in range)
  WA_BATCH_SIZE=10           # Pause after 10 messages
  WA_BATCH_COOLDOWN_MS=120000 # 2 min cooldown between batches
```

**Rules to follow:**
1. Never send more than 30 media files in one session
2. Don't run the delivery workflow more than 2x per day
3. Use "composing" presence before sending (built into workflow)
4. Avoid sending between 1am-6am (suspicious pattern)

### GDPR Consent Flow
Before adding a friend's face to CompreFace:
1. Tell them you're using face recognition to auto-sort photos
2. Get explicit verbal/written consent
3. Set `consent_given = true` in `friends_contacts` table
4. The system will NOT send to friends where `consent_given = false`
5. Provide a way to delete their data: `node setup-compreface.js --action=delete --friend=name`

### Backup Strategy
```bash
# Database backup (run weekly via Task Scheduler)
docker exec autoshare-postgres pg_dump -U autoshare autosharepics > backup_%date%.sql

# CompreFace backup
docker exec autoshare-compreface-db pg_dump -U compreface frs > compreface_backup_%date%.sql

# Volume backup
docker run --rm -v autoshare_media_cache:/data -v %cd%:/backup alpine tar czf /backup/media_cache.tar.gz /data
```

---

## 🧪 Testing Plan (Part 8)

### Manual Test Checklist
- [ ] Docker stack starts without errors (`docker-compose up -d`)
- [ ] n8n UI is accessible at http://localhost:5678
- [ ] CompreFace UI loads at http://localhost:8000
- [ ] Evolution API QR code scans successfully
- [ ] WhatsApp stays connected after 24 hours
- [ ] Upload a test photo to Google Drive → check n8n execution log
- [ ] CompreFace recognizes a known friend (>85% confidence)
- [ ] Photo with 2 friends → sent to group chat
- [ ] Photo with 1 friend → sent as DM
- [ ] Photo sent as document (not compressed image)
- [ ] Video sent as normal media
- [ ] Delivery log appears in PostgreSQL
- [ ] Summary message received on your WhatsApp
- [ ] Duplicate file doesn't trigger re-send
- [ ] Geofence webhook triggers delivery workflow

### Testing Face Recognition Accuracy
```bash
# Test with a known photo
node scripts/setup-compreface.js --action=test --photo=./test_photos/group_shot.jpg --threshold=0.85

# Expected output: lists detected faces with confidence scores
# If below 85%: add more reference photos for that friend
```

### Integration Test Scenarios
| # | Scenario | Expected Result |
|---|----------|----------------|
| 1 | Upload JPEG with 2 friends | Recognized → group chat as document |
| 2 | Upload HEIC with 1 friend | Converted → recognized → DM as document |
| 3 | Upload MP4 video with friends | Keyframes extracted → recognized → sent as media |
| 4 | Upload photo with no known faces | Status set to 'skipped', no send |
| 5 | Upload same file twice | Second upload ignored (dedup by gdrive_file_id) |
| 6 | CompreFace is down during processing | Status stays 'pending', retry on next schedule |
| 7 | WhatsApp disconnected during delivery | Error logged, retry on next trigger |
| 8 | Geofence fires while photos still uploading | 5-min debounce handles it |

---

## 🚀 Deployment (Part 9)

### Local PC (Your Current Setup)
- Docker Desktop for Windows with WSL2 backend
- Allocate: 4GB RAM to Docker, 2 CPUs minimum
- Set Docker to start on Windows login
- Use Task Scheduler to run `docker-compose up -d` on boot

### VPS Option (Future)
| Provider | Plan | Specs | Cost |
|----------|------|-------|------|
| Hetzner CX22 | Shared | 2 vCPU, 4GB RAM, 40GB | €4.49/mo |
| Hetzner CX32 | Shared | 4 vCPU, 8GB RAM, 80GB | €8.49/mo |
| DigitalOcean | Basic | 2 vCPU, 4GB RAM, 80GB | $24/mo |

**Recommended: Hetzner CX22** for budget, CX32 for comfort.

### SSL Setup (if exposing webhooks)
Use Tailscale (free) for secure remote access without exposing ports:
```bash
# Install Tailscale on PC and phone
# Access n8n via https://your-pc.tail-net:5678
# Geofence webhook uses Tailscale URL
```

### Monitoring
Add Uptime Kuma container to docker-compose:
```yaml
uptime-kuma:
  image: louislam/uptime-kuma:1
  container_name: autoshare-monitor
  ports:
    - "3001:3001"
  volumes:
    - uptime_kuma_data:/app/data
```
Monitor: n8n (5678), CompreFace (8000), Evolution (8080), PostgreSQL (5432)

### Monthly Cost Breakdown (Local)
| Item | Cost |
|------|------|
| Docker Desktop | Free (personal) |
| Google Drive (15GB) | Free |
| Electricity (~50W) | ~$3-5/mo |
| Domain (optional) | $0-10/yr |
| **Total** | **~$3-5/month** |

---

## 📈 Roadmap (Part 10)

### MVP (This Weekend)
- [x] Docker stack with all services
- [x] n8n workflows (Ingest → Process → Deliver)
- [x] CompreFace face recognition
- [x] WhatsApp delivery via Evolution API
- [x] Photos as documents, videos as media
- [x] Basic session clustering
- [ ] Test with 5 friends, 20 photos

### Phase 2 (Next Month)
- **GPT-4 Captions**: Add a Code node that calls OpenAI API to generate fun captions for group photos
- **Approval Gate**: Before sending, WhatsApp you a preview → reply "yes" to confirm
- **Smart Albums**: Auto-create Google Photos shared albums per session
- **Duplicate Detection**: Perceptual hashing (pHash) to detect near-duplicate photos
- **Multi-Event Tags**: Label sessions as "Beach Trip", "Birthday Party" based on GPS/time

### Phase 3 (Future)
- **Web Dashboard**: Simple Next.js app showing delivery history, friend stats, session gallery
- **Mobile App**: React Native app to manage friends, trigger sends, view status
- **Multi-Photographer**: Support multiple people's camera rolls merging into one session
- **Face Clustering**: Auto-discover new faces and prompt you to name them
- **WhatsApp Bot**: Friends can request their photos by messaging the bot
