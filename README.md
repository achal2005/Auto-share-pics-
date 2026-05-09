# 📸 AutoSharePics

**Automatically distribute hangout photos to friends via WhatsApp using AI face recognition.**

Photos with 2+ friends → Group chat (as documents, full quality)
Photos with 1 friend → DM (as document, full quality)
Videos → Sent as normal media

## Architecture

```
iPhone Camera → Google Drive → n8n (Ingest → Process → Deliver) → WhatsApp
                                      ↕              ↕
                                  PostgreSQL    CompreFace (Face AI)
```

## Quick Start

```bash
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
```

## Project Structure

```
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
```

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
