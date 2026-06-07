# =============================================================================
# Evolution API — WSL2-Hardened Build
# =============================================================================
# Bakes the os.release() patch into the image so it cannot be skipped at
# runtime, removes brittle `sed` hacks, and pins the Baileys browser tuple to
# values WhatsApp actually accepts.
#
# Build:  docker build -t autoshare/evolution:wsl2 -f evolution/Dockerfile .
# =============================================================================
FROM atendai/evolution-api:v2.2.0

# Tini for proper signal handling (avoids zombie node processes on restart)
USER root
RUN apk add --no-cache tini ca-certificates tzdata ffmpeg && update-ca-certificates

# Drop the patch into the image. Loaded via NODE_OPTIONS=--require so it runs
# BEFORE any `import { release } from 'os'` is evaluated. Mutating the os
# singleton at -r time also mutates every later destructure, because Node's
# built-in modules are cached singletons.
COPY evolution/patch.cjs /evolution/patch.cjs
RUN chmod 0444 /evolution/patch.cjs

# Force the patch to load on every node invocation in this container, including
# any child processes Evolution API may spawn.
ENV NODE_OPTIONS="--require=/evolution/patch.cjs"

# Set the latest WhatsApp Web version (fetched from web.whatsapp.com/check-update).
# Overriding this is critical because the base image contains an outdated fallback
# ('2.3000.1015901307') which WhatsApp servers now silently reject.
ENV CONFIG_SESSION_PHONE_VERSION="2.3000.1032691661"
ENV WEB_VERSION="2.3000.1032691661"
ENV CONFIG_SESSION_PHONE_CLIENT="Evolution API"
ENV CONFIG_SESSION_PHONE_NAME="Chrome"

# Local cache is REQUIRED for Baileys session persistence in Evolution v2.x.
# Without it, sessions are lost on container restart → new QR loop.
ENV CACHE_LOCAL_ENABLED="true"

# Point @ffmpeg-installer/ffmpeg to the system binary installed via apk.
# Without this, it uses os.platform() detection which may look for wrong paths.
ENV FFMPEG_PATH="/usr/bin/ffmpeg"
ENV FFPROBE_PATH="/usr/bin/ffprobe"

# Diagnostic: lets pair-whatsapp.js confirm the patch is active
ENV DEBUG_PATCH="true"

# Restore the published entrypoint, but route through tini.
# Prisma db push syncs the schema (creates tables like Instance) on first boot.
# Without this, Evolution API crashes with 'table public.Instance does not exist'.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "cd /evolution && npx prisma db push --schema=prisma/postgresql-schema.prisma --skip-generate 2>&1 && npm run start:prod"]
