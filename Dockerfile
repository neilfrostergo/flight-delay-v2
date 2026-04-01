# ── Build stage ──────────────────────────────────────────────
FROM node:20-slim AS deps

WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev

# ── Production image ─────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY server/ ./
COPY customer/ ./public/customer/
COPY admin/ ./public/admin/

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "src/index.js"]
