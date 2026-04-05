# ── Build stage ──────────────────────────────────────────────
FROM node:20-slim AS deps

WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev

# ── Production image ─────────────────────────────────────────
FROM node:20-slim

# poppler-utils provides pdftoppm for server-side PDF-to-image rendering
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY server/ ./
COPY customer/ ../customer/
COPY admin/ ../admin/
COPY landing/ ../landing/

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["sh", "-c", "node src/db/migrate.js && node src/scripts/seedRefData.js && node src/index.js"]
