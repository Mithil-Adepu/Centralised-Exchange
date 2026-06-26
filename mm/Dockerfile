# ── Stage 1: Build ──
FROM node:18-alpine AS builder
WORKDIR /build

COPY mm/package.json mm/package-lock.json ./mm/
RUN cd mm && npm install

COPY mm/tsconfig.json ./mm/
COPY mm/src ./mm/src
RUN cd mm && npm run build

# ── Stage 2: Runtime ──
FROM node:18-alpine
WORKDIR /app

COPY --from=builder /build/mm/dist ./dist
COPY --from=builder /build/mm/node_modules ./node_modules
COPY --from=builder /build/mm/package.json ./

CMD ["node", "dist/index.js"]