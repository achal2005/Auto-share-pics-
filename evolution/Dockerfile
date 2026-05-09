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
RUN apk add --no-cache tini ca-certificates tzdata && update-ca-certificates

# Drop the patch into the image. Loaded via NODE_OPTIONS=--require so it runs
# BEFORE any `import { release } from 'os'` is evaluated. Mutating the os
# singleton at -r time also mutates every later destructure, because Node's
# built-in modules are cached singletons.
COPY evolution/patch.cjs /evolution/patch.cjs
RUN chmod 0444 /evolution/patch.cjs

# Force the patch to load on every node invocation in this container, including
# any child processes Evolution API may spawn.
ENV NODE_OPTIONS="--require=/evolution/patch.cjs"

# Sane Baileys browser identity. WhatsApp rejects the WSL2 kernel string; these
# values match what the Baileys community uses successfully in production.
ENV CONFIG_SESSION_PHONE_CLIENT="Evolution API"
ENV CONFIG_SESSION_PHONE_NAME="Chrome"
ENV CONFIG_SESSION_PHONE_VERSION="2.3000.1015901307"

# Restore the published entrypoint, but route through tini.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/evolution/dist/main.js"]
