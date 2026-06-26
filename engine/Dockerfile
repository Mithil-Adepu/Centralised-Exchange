# ── Stage 1: Build ──
FROM node:18-alpine AS builder
WORKDIR /build

# Copy shared package first (dependency)
COPY shared/package.json shared/tsconfig.json ./shared/
COPY shared/src ./shared/src
RUN cd shared && npm install && npm run build

# Copy engine package
COPY engine/package.json engine/package-lock.json ./engine/
RUN cd engine && npm install

COPY engine/tsconfig.json ./engine/
COPY engine/src ./engine/src
RUN cd engine && npm run build

# ── Stage 2: Runtime ──
FROM node:18-alpine
WORKDIR /app

COPY --from=builder /build/shared/dist /shared/dist
COPY --from=builder /build/shared/package.json /shared/
COPY --from=builder /build/engine/dist ./dist
COPY --from=builder /build/engine/node_modules ./node_modules
COPY --from=builder /build/engine/package.json ./

# Copy snapshot if present (wildcard avoids failure if missing)
COPY engine/snapshot.jso[n] ./

ENV WITH_SNAPSHOT=true

CMD ["node", "dist/index.js"]
