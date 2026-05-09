# AutoSharePics - Setup & Operations Guide

## Quick Start (5 minutes)

### Prerequisites
- Docker Desktop for Windows installed and running
- Google account with Google Drive
- WhatsApp on your phone

### Step 1: Clone & Configure
```bash
# Copy environment file
copy .env.example .env
# Edit .env with your values (see comments in the file)
notepad .env
```

### Step 2: Start the Stack
```bash
docker-compose up -d
```

⚠️ First boot takes 3-5 minutes. CompreFace downloads ML models (~1.5GB).

### Step 3: Verify Services
| Service | URL | What to Check |
|---------|-----|---------------|
| n8n | http://localhost:5678 | Login with N8N_AUTH_USER/PASSWORD |
| CompreFace | http://localhost:8000 | Create account on first visit |
| Evolution API | http://localhost:8080/docs | Swagger docs load |
| PostgreSQL | localhost:5433 | Connect via pgAdmin/DBeaver |

### Step 4: Connect WhatsApp
```bash
# Create Evolution API instance
curl -X POST http://localhost:8080/instance/create \
  -H "apikey: YOUR_EVOLUTION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"instanceName": "autoshare", "qrcode": true}'

# Get QR code
curl http://localhost:8080/instance/connect/autoshare \
  -H "apikey: YOUR_EVOLUTION_API_KEY"
```
Scan the QR code with WhatsApp on your phone (Linked Devices → Link a Device).

### Step 5: Set Up CompreFace
1. Go to http://localhost:8000
2. Register an account (local only, first time)
3. Create Application → Name it "AutoSharePics"
4. Note the **Recognition API Key** → put it in `.env` as `CF_RECOGNITION_API_KEY`

### Step 6: Upload Friend Faces
```bash
cd scripts
npm install
# Structure your reference photos:
#   reference_photos/alice/photo1.jpg, photo2.jpg, ...
#   reference_photos/bob/photo1.jpg, photo2.jpg, ...
node setup-compreface.js --action=bulk --dir=../reference_photos --api-key=YOUR_KEY
```

**Best practices for reference photos:**
- 5-10 photos per friend (minimum 5)
- Include: front face, slight left/right angles, smiling, serious
- Good lighting, no sunglasses
- Different backgrounds help
- Crop to face if possible (not required)

### Step 7: Import n8n Workflows
1. Open n8n → Workflows → Import from File
2. Import `workflows/01-ingest.json`
3. Import `workflows/02-process.json`
4. Import `workflows/03-deliver.json`
5. Set up credentials:
   - **Google Drive OAuth2**: Settings → Credentials → Add → Google Drive
   - **PostgreSQL**: Host=`app-postgres`, Port=`5432`, DB/User/Pass from .env
6. Activate all 3 workflows

### Step 8: Configure Google Drive
1. Create folder `/AutoSharePics/Inbox` in Google Drive
2. Copy the folder ID from the URL bar
3. Set `GDRIVE_FOLDER_ID` in .env
4. Set up Google Photos to auto-backup to this folder

### Step 9: Add Friends to Database
```sql
-- Connect to PostgreSQL (port 5433)
INSERT INTO friends_contacts (subject_name, display_name, phone_number, consent_given, consent_date)
VALUES
  ('alice', 'Alice', '919876543210', true, NOW()),
  ('bob', 'Bob', '919876543211', true, NOW());
```

### Step 10: Get Group Chat JID
```bash
# List all groups
curl http://localhost:8080/group/fetchAllGroups/autoshare \
  -H "apikey: YOUR_EVOLUTION_API_KEY"
# Find your group → copy the "id" field (format: XXXXXXX@g.us)
# Set WHATSAPP_GROUP_JID in .env
```

---

## iOS Geofence Shortcut

Create an iPhone Shortcut with:

1. **Automation** → Personal Automation → **Arrive** at location (your home)
2. Add action: **Get Contents of URL**
   - URL: `http://YOUR_PC_IP:5678/webhook/geofence-trigger`
   - Method: POST
   - Headers: `x-webhook-secret: YOUR_GEOFENCE_SECRET`
   - Body (JSON): `{"trigger": "geofence", "source": "ios"}`
3. Turn OFF "Ask Before Running"

⚠️ Your PC must be reachable from your phone (same WiFi or use Tailscale for remote access).

**Android Alternative (Tasker):**
1. Profile → Location → Set your home coordinates (150m radius)
2. Task → HTTP Request → Same URL/headers as above

**Manual Override via WhatsApp:**
Send any message to yourself or use:
```bash
curl -X POST http://localhost:5678/webhook/manual-send \
  -H "Content-Type: application/json" \
  -d '{"trigger": "manual"}'
```
