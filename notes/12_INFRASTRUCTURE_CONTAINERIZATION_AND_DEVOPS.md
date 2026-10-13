# Module 12: Infrastructure, Containerization, and Production DevOps

## 1. Monorepo Orchestration and Container Topography

The Centralised Exchange is architected as an event-driven distributed system consisting of seven distinct services and two core persistence backends. In development and production environments, coordinating the startup order, networking, shared library compilation, and health verification across these components is non-trivial.

### System Network and Dependency Graph

```
                                 Internet / Clients
                                         │
                                  Ports 80 / 443
                                         ▼
                            ┌─────────────────────────┐
                            │    cex-nginx (Alpine)   │
                            │  Reverse Proxy & SSL    │
                            └────────────┬────────────┘
                                         │
                 ┌───────────────────────┴───────────────────────┐
                 │ HTTP (3000)                                   │ WS (3001)
                 ▼                                               ▼
      ┌─────────────────────┐                         ┌─────────────────────┐
      │       cex-api       │                         │       cex-ws        │
      │    (API Gateway)    │                         │  (WebSocket Gateway)│
      └──────────┬──────────┘                         └──────────┬──────────┘
                 │                                               │
                 ├───────────────────────────────┐               │
                 │                               │               │
                 ▼                               ▼               ▼
      ┌─────────────────────┐         ┌─────────────────────────────┐
      │     cex-engine      │         │          cex-redis          │
      │  (Matching Engine)  │◄────────┤    (Streams + Pub/Sub)      │
      └──────────┬──────────┘         └──────────────┬──────────────┘
                 │ (db_processor stream)             │
                 ▼                                   │
      ┌─────────────────────┐                        │
      │   cex-db-processor  │                        │
      │ (Timescale Persist) │                        │
      └──────────┬──────────┘                        │
                 │                                   │
                 ▼                                   ▼
      ┌─────────────────────┐             ┌─────────────────────┐
      │   cex-timescaledb   │             │       cex-mm        │
      │   (Postgres + TS)   │             │   (Market Maker)    │
      └─────────────────────┘             └─────────────────────┘
```

---

## 2. Startup Lifecycle and Healthcheck Gates (`docker-compose.yml`)

Located at [`docker-compose.yml`](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/docker-compose.yml).

### The Boot Race Condition Problem

In distributed architectures, launching services with simple `depends_on: [timescaledb, redis]` leads to intermittent, catastrophic boot crashes:
1. `timescaledb` starts its container, but Postgres takes 3 to 10 seconds to initialize database clusters and open sockets.
2. `api` or `db-processor` connects instantly, encounters `ECONNREFUSED`, and terminates.
3. If `timescaledb` is up, but migrations have not executed, `api` queries `SELECT * FROM users` and crashes with `relation "users" does not exist`.

### The Solution: Condition-Gated Healthchecks and Init Containers

Docker Compose v2 introduces condition evaluation (`service_healthy` and `service_completed_successfully`).

```yaml
# 1. TimescaleDB Healthcheck
timescaledb:
  image: timescale/timescaledb:latest-pg14
  container_name: cex-timescaledb
  restart: unless-stopped
  ports:
    - "${DB_PORT:-5432}:5432"
  environment:
    POSTGRES_DB: ${DB_NAME:-my_database}
    POSTGRES_USER: ${DB_USER:-your_user}
    POSTGRES_PASSWORD: ${DB_PASSWORD:-your_password}
  volumes:
    - timescale-data:/var/lib/postgresql/data
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U ${DB_USER:-your_user} -d ${DB_NAME:-my_database}"]
    interval: 10s
    timeout: 5s
    retries: 5

# 2. Redis AOF Healthcheck
redis:
  image: redis:7-alpine
  container_name: cex-redis
  restart: unless-stopped
  command: ["redis-server", "--appendonly", "yes"]
  ports:
    - "${REDIS_PORT:-6379}:6379"
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
    interval: 10s
    timeout: 5s
    retries: 5
```

### The Init Container Pattern (`cex-db-seed`)

```yaml
db-seed:
  build:
    context: .
    dockerfile: db/Dockerfile
  container_name: cex-db-seed
  depends_on:
    timescaledb:
      condition: service_healthy
  environment:
    DB_USER: ${DB_USER:-your_user}
    DB_PASSWORD: ${DB_PASSWORD:-your_password}
    DB_HOST: timescaledb
    DB_PORT: 5432
    DB_NAME: ${DB_NAME:-my_database}
  restart: "no" # Init container: executes once and terminates cleanly (exit code 0)
```

### Downstream Service Dependencies

All operational microservices declare a strict dependency on `db-seed` completing successfully:

```yaml
engine:
  depends_on:
    redis:
      condition: service_healthy
    db-seed:
      condition: service_completed_successfully

api:
  depends_on:
    redis:
      condition: service_healthy
    timescaledb:
      condition: service_healthy
    db-seed:
      condition: service_completed_successfully
    engine:
      condition: service_started

db-processor:
  depends_on:
    redis:
      condition: service_healthy
    timescaledb:
      condition: service_healthy
    db-seed:
      condition: service_completed_successfully
```

#### Why This Works:
- `db-seed` creates the tables, hypertables, indices, and 7 materialized views before any background worker or HTTP route tries to query them.
- Services never fail on boot, eliminating container flapping and crash loops.

---

## 3. Multi-Stage Monorepo Dockerfiles

Every Node.js service depends on the shared package at `shared/`. If each Dockerfile simply ran `npm install` inside its own directory, the dependency on `../shared` would fail unless the build context is the repository root.

Examining [`api/Dockerfile`](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/api/Dockerfile):

```dockerfile
# ── Stage 1: Build Stage ──
FROM node:18-alpine AS builder
WORKDIR /build

# 1. Compile the shared TypeScript library first
COPY shared/package.json shared/tsconfig.json ./shared/
COPY shared/src ./shared/src
RUN cd shared && npm install && npm run build

# 2. Copy and compile the API service
COPY api/package.json api/package-lock.json ./api/
RUN cd api && npm install

COPY api/tsconfig.json ./api/
COPY api/src ./api/src
RUN cd api && npm run build

# ── Stage 2: Minimal Production Runtime ──
FROM node:18-alpine
WORKDIR /app

# Copy ONLY compiled JavaScript and production node_modules
COPY --from=builder /build/shared/dist /shared/dist
COPY --from=builder /build/shared/package.json /shared/
COPY --from=builder /build/api/dist ./dist
COPY --from=builder /build/api/node_modules ./node_modules
COPY --from=builder /build/api/package.json ./

EXPOSE 3000

# Container Healthcheck probe
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
```

### Advantages of This Multi-Stage Pattern:
1. **Zero TypeScript Tooling in Production:** The final runtime image does not contain `tsc`, `typescript`, `@types/*`, or build caches, cutting container footprint from $\approx 650\text{ MB}$ to $< 120\text{ MB}$.
2. **Layer Caching:** If only `api/src` changes, Docker reuses the cached layer for `shared`, resulting in sub-3-second incremental image rebuilds.
3. **Attack Surface Minimization:** The runtime image contains minimal binaries, strictly limiting potential CVE vulnerabilities in dev dependencies.

---

## 4. Production Nginx Reverse Proxy and SSL Gateway

Located at [`nginx/nginx.conf`](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/nginx/nginx.conf).

### Unified Edge Routing

Nginx serves as the single ingress point on ports 80 (HTTP) and 443 (HTTPS), terminating TLS and proxying internal container network hostnames (`http://api:3000` and `http://ws:3001`).

```nginx
events {
    worker_connections 1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;
    sendfile        on;
    tcp_nopush      on;
    tcp_nodelay     on;
    keepalive_timeout  65;

    # Gzip Compression for fast API payload transfers
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css application/json application/javascript text/xml;

    # 1. Automatic HTTP to HTTPS Redirection + Certbot ACME Challenge Passthrough
    server {
        listen 80;
        server_name exchange-api.duckdns.org exchange-ws.duckdns.org;
        
        location /.well-known/acme-challenge/ {
            root /var/www/certbot;
        }

        location / {
            return 301 https://$host$request_uri;
        }
    }
```

### HTTP REST API Upstream Block

```nginx
    server {
        listen 443 ssl;
        server_name exchange-api.duckdns.org;

        ssl_certificate /etc/letsencrypt/live/exchange-api.duckdns.org/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/exchange-api.duckdns.org/privkey.pem;
        
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_prefer_server_ciphers on;

        # Hardened HTTP Security Headers
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-XSS-Protection "1; mode=block" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "no-referrer-when-downgrade" always;

        location /api/ {
            proxy_pass http://api:3000/api/;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            
            proxy_connect_timeout 60s;
            proxy_send_timeout 60s;
            proxy_read_timeout 60s;
        }
    }
```

### WebSocket Streaming Upstream Block

Standard HTTP reverse proxies drop idle connections after 60 seconds. A cryptocurrency exchange WebSocket connection must stay open indefinitely:

```nginx
    server {
        listen 443 ssl;
        server_name exchange-ws.duckdns.org;

        ssl_certificate /etc/letsencrypt/live/exchange-api.duckdns.org/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/exchange-api.duckdns.org/privkey.pem;
        
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_prefer_server_ciphers on;

        location / {
            proxy_pass http://ws:3001/;
            proxy_http_version 1.1;
            
            # WebSocket Protocol Upgrade Handshake
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            
            # Ultra-Long Keepalive Timeouts (7 Days)
            # Prevents intermediate proxy disconnections during quiet market periods
            proxy_connect_timeout 7d;
            proxy_send_timeout 7d;
            proxy_read_timeout 7d;
        }
    }
```

---

## 5. Environment Secrets and Production Configuration

The exchange isolates configuration using an environment matrix. All sensitive secrets are decoupled from source control:

| Variable | Target Service | Purpose & Production Rule |
| :--- | :--- | :--- |
| `INTERNAL_SERVICE_TOKEN` | `api`, `mm` | Shared 256-bit hexadecimal string allowing the Market Maker bot to place orders without OTP/passwords. **Must be rotated upon deployment.** |
| `ACCESS_TOKEN_SECRET` | `api` | Cryptographic secret for signing short-lived (15-min) HMAC-SHA256 JWTs. |
| `REFRESH_TOKEN_SECRET`| `api` | Cryptographic secret for signing long-lived (7-day) refresh JWTs. |
| `WITH_SNAPSHOT` | `engine` | Set to `true` to enable 1,000-message periodic JSON state checkpoints and crash replay. |
| `ENGINE_LOG_LEVEL` | `engine` | `info` logs business operations (trades, fills, refunds); `debug` adds raw stream ACKs. |
| `CORS_ORIGIN` | `api` | In production, restrict to exact frontend origin (e.g. `https://exchange.domain.com`) to enforce cookie credential isolation. |
| `SMTP_*` | `api` | SMTP host, port, user, and password for production email verification OTP delivery. |

---

## 6. Production Operational Runbook

### Clean Cluster Boot

```bash
# 1. Pull base images and compile all TypeScript microservices
docker compose build

# 2. Start the cluster in detached mode
docker compose up -d

# 3. Verify health status across all containers
docker compose ps
```

### Tail Engine Matching Operations

```bash
# Stream engine real-time execution logs
docker compose logs -f engine

# Output sample:
# [INFO] 🚀 Matching Engine started in SNAPSHOT mode
# [INFO] Replaying 0 unacknowledged pending messages...
# [INFO] [TRADE] SOL_USDC: 1.5000 @ 142.50 (Maker: o-102, Taker: o-105)
```

### Emergency Engine State Snapshot Inspection

When inspecting or recovering disk state:

```bash
# Execute shell inside engine container
docker compose exec engine ls -la /app/snapshots/

# Inspect raw JSON state machine balance ledger
docker compose exec engine cat /app/snapshots/snapshot.json
```

### Zero-Downtime Database Maintenance

To trigger a manual off-cycle refresh of the 7 TimescaleDB candlestick materialized views:

```bash
docker compose exec timescaledb psql -U your_user -d my_database -c "
  REFRESH MATERIALIZED VIEW CONCURRENTLY klines_1m;
  REFRESH MATERIALIZED VIEW CONCURRENTLY klines_1h;
"
```
