# ── Stage 1: Build frontend ──
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install build tools for native modules (better-sqlite3, node-pty)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy source for vite build
COPY src/ src/
COPY static/ static/
COPY vite.config.ts tsconfig.json index.html ./
RUN npx vite build


# ── Stage 2: Production image ──
FROM node:22-bookworm-slim

WORKDIR /app

# System deps: jq (hook enrichment), python3/make/g++ (native module rebuild)
RUN apt-get update && apt-get install -y --no-install-recommends \
    jq python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm rebuild better-sqlite3 node-pty && \
    apt-get purge -y python3 make g++ && \
    apt-get autoremove -y && \
    rm -rf /root/.npm /tmp/*

# Copy server, hooks, bin, static assets, types
COPY server/ server/
COPY hooks/ hooks/
COPY bin/ bin/
COPY static/ static/
COPY types/ types/

# Copy built frontend from builder stage
COPY --from=builder /app/dist/client dist/client/

# Ensure data directory exists
RUN mkdir -p data

# Create default config (zero-config mode, no password, no browser open)
RUN echo '{ \
  "port": 8964, \
  "hookDensity": "medium", \
  "debug": false, \
  "processCheckInterval": 15000, \
  "sessionHistoryHours": 24, \
  "enabledClis": ["claude"], \
  "passwordHash": null \
}' > data/server-config.json

# Create MQ directory (hooks write here)
RUN mkdir -p /tmp/claude-session-center

# Fix node-pty spawn-helper permissions
RUN if [ -d node_modules/node-pty/prebuilds ]; then \
      find node_modules/node-pty/prebuilds -name spawn-helper -exec chmod 755 {} + ; \
    fi

EXPOSE 8964

# Health check: hit the auth status endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8964/api/auth/status').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Start server without opening a browser
CMD ["npx", "tsx", "server/index.ts", "--no-open"]
