# ── Stage 1: Build ──
FROM node:18-alpine AS builder
WORKDIR /build

# Copy shared package first (dependency)
COPY shared/package.json shared/tsconfig.json ./shared/
COPY shared/src ./shared/src
RUN cd shared && npm install && npm run build

# Copy API package
COPY api/package.json api/package-lock.json ./api/
RUN cd api && npm install

COPY api/tsconfig.json ./api/
COPY api/src ./api/src
RUN cd api && npm run build

# ── Stage 2: Runtime ──
FROM node:18-alpine
WORKDIR /app

COPY --from=builder /build/shared/dist /shared/dist
COPY --from=builder /build/shared/package.json /shared/
COPY --from=builder /build/api/dist ./dist
COPY --from=builder /build/api/node_modules ./node_modules
COPY --from=builder /build/api/package.json ./

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
