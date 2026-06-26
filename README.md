# Centralized Exchange Platform

A comprehensive exchange platform built with modern web technologies, featuring real-time trading, order matching, and market data visualization.

## 🏗️ Architecture

architecture-diagram.png

Architecture decisions are tracked in docs/adr.

This exchange platform consists of multiple microservices:

### Core Components

- **Frontend** - Next.js/React-based trading interface
- **API** - Node.js/TypeScript REST API server
- **Engine** - High-performance trading engine with order matching
- **WebSocket** - Real-time data streaming service
- **Database** - PostgreSQL/TimescaleDB for persistence
- **Market Maker** - Automated market making service
- **Docker** - Containerization and orchestration

### Architecture Decisions

- See [docs/adr/0001-shared-types-and-precision.md](docs/adr/0001-shared-types-and-precision.md) for shared protocol types and scaled-precision math decisions.

## 🚀 Features

- **Real-time Trading**: Live order book updates and trade execution
- **Order Matching Engine**: High-performance order matching algorithm
- **Market Data**: Real-time price feeds, depth charts, and trading history
- **WebSocket API**: Low-latency real-time data streaming
- **Responsive UI**: Modern trading interface
- **Order Management**: Limit orders, market orders, and order history
- **Chart Integration**: Advanced trading charts with real-time candlestick aggregation
- **Multi-market Support**: Support for multiple trading pairs
- **Wallet & Fiat Onramp**: Integrated Razorpay checkout for secure fiat deposits with Postgres transaction tracking
- **Hybrid Authentication**: JWT access token + Postgres-backed refresh sessions
- **WebSocket Ticket Auth**: One-time 60s ticket required as first WS message
- **Role-Based Access Control**: user/admin roles enforced on protected routes
- **Account Lockout**: 5 failed logins → 15 min temporary lock
- **Session Management**: Max 3 concurrent sessions, session listing & revocation
- **OpenAPI Spec**: JSON spec served from the API

## 📁 Project Structure

```
exchange/
├── frontend/          # Next.js trading interface
├── api/              # REST API server
├── engine/           # Trading engine
├── ws/               # WebSocket service
├── db/               # Database operations
├── mm/               # Market maker service
├── shared/           # Shared types & protocol
├── docker/           # Legacy Docker config
└── docker-compose.yml # One-command deployment
```

## 🛠️ Technology Stack

- **Frontend**: Next.js, React, TypeScript, Tailwind CSS, Zustand
- **Backend**: Node.js, TypeScript, Express
- **Database**: Redis, PostgreSQL/TimescaleDB
- **Real-time**: WebSocket, Server-Sent Events
- **Containerization**: Docker, Docker Compose
- **Testing**: Jest, Vitest, Supertest

## 🐳 Quick Start (Docker)

The fastest way to run the entire platform:

```bash
# 1. Clone the repo
git clone https://github.com/Mithil-Adepu/Centralised-Exchange.git
cd Centralised-Exchange

# 2. Create environment file
cp .env.docker .env
# Edit .env — update DB_PASSWORD, ACCESS_TOKEN_SECRET, REFRESH_TOKEN_SECRET

# 3. Start everything
docker-compose up --build

# Frontend: http://localhost:3005
# API:      http://localhost:3000
# WS:       ws://localhost:3001
```

## 🔧 Local Development

### Prerequisites

- Node.js (v18 or higher)
- Docker and Docker Compose (for Redis + TimescaleDB)
- Redis
- PostgreSQL/TimescaleDB

### Installation

1. **Start infrastructure**
   ```bash
   docker-compose up timescaledb redis -d
   ```

2. **Install dependencies for all services**
   ```bash
   cd shared && npm install && npm run build && cd ..
   cd api && npm install && cd ..
   cd engine && npm install && cd ..
   cd ws && npm install && cd ..
   cd db && npm install && cd ..
   cd frontend && npm install && cd ..
   ```

3. **Initialize database schema**
   ```bash
   cd db && npm run seed:db
   ```

4. **Start individual services**
   ```bash
   cd api && npm run dev      # API server
   cd engine && npm run dev   # Trading engine
   cd ws && npm run dev       # WebSocket service
   cd frontend && npm run dev # Frontend
   ```

## 🔧 Configuration

### Environment Variables

Create `.env` files in each service directory:

**API Service (.env)**
```
API_PORT=3000
REDIS_URL=redis://localhost:6379
DB_USER=your_user
DB_PASSWORD=your_password
DB_HOST=localhost
DB_PORT=5433
DB_NAME=my_database
ACCESS_TOKEN_SECRET=change-this-access-secret
REFRESH_TOKEN_SECRET=change-this-refresh-secret
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL_SECONDS=604800
CORS_ORIGIN=http://localhost:3000,http://localhost:3005
```

**Engine Service (.env)**
```
REDIS_URL=redis://localhost:6379
ENGINE_LOG_MESSAGES=false
```

**WebSocket Service (.env)**
```
WS_PORT=3001
REDIS_URL=redis://localhost:6379
```

**Frontend (.env.local)**
```
NEXT_PUBLIC_API_URL=http://localhost:3000
NEXT_PUBLIC_WS_URL=ws://localhost:3001
NEXT_PUBLIC_API_TIMEOUT_MS=60000
```

## 📊 API Endpoints

### REST API
- `GET /health` - Service health
- `GET /api/v1/tickers` - Market ticker data
- `GET /api/v1/depth` - Order book depth
- `GET /api/v1/trades` - Recent trades
- `GET /api/v1/klines` - Candlestick data
- `POST /api/v1/order` - Place order (auth required)
- `DELETE /api/v1/order` - Cancel order (auth required)
- `GET /api/v1/order/open` - Open orders (auth required)
- `POST /api/v1/onramp` - Add funds (auth required)
- `GET /api/v1/wallet/balances` - Wallet balances (auth required)

### Auth API
- `POST /api/v1/auth/register` - Register + returns access token
- `POST /api/v1/auth/login` - Login + returns access token
- `POST /api/v1/auth/refresh` - Rotate access/refresh via HttpOnly cookie
- `POST /api/v1/auth/logout` - Invalidate refresh session
- `GET /api/v1/auth/me` - Current authenticated user
- `POST /api/v1/auth/ws-ticket` - Issue one-time websocket ticket
- `GET /api/v1/auth/sessions` - List active sessions
- `DELETE /api/v1/auth/sessions/:id` - Revoke a session
- `GET /api/v1/openapi.json` - OpenAPI spec

### WebSocket API
- `ws://localhost:3001` - Real-time market data
- Subscribe to: `ticker`, `depth`, `trades`, `klines`

First message must be:
```json
{
   "method": "AUTH",
   "params": { "ticket": "<uuid-from-/api/v1/auth/ws-ticket>" }
}
```

## 🔐 Security Model

- Access tokens are short-lived JWTs (`type=access`, 15m TTL) for HTTP authorization.
- Refresh tokens are rotated and stored hashed in Postgres (`auth_sessions`).
- Refresh token is delivered as `HttpOnly; SameSite=Strict` cookie.
- WebSocket connections are authenticated via one-time Redis-backed tickets (60s TTL).
- Role-based access control enforced on order, onramp, and WS ticket endpoints.
- **Account lockout**: 5 failed login attempts → 15 minute temporary lock (Redis-backed).
- **Session limit**: Max 3 concurrent sessions per user; 4th login evicts the oldest.
- **Session metadata**: IP address and user-agent tracked per session.
- **Session cleanup**: Expired sessions automatically purged every hour.
- API rate limiting on auth, order, and WS ticket endpoints.
- Production security headers: HSTS, CSP, X-Frame-Options, Referrer-Policy.
- Password requirements: 8+ characters, at least 1 letter, at least 1 number.

## ✅ Verification Checklist

1. **Health check**
   ```bash
   curl http://localhost:3000/health
   ```

2. **Register**
   ```bash
   curl -X POST http://localhost:3000/api/v1/auth/register \
     -H "Content-Type: application/json" \
     -d '{"email":"alice@example.com","password":"example1pass"}'
   ```

3. **Login**
   ```bash
   curl -X POST http://localhost:3000/api/v1/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"alice@example.com","password":"example1pass"}'
   ```

4. **Use access token**
   ```bash
   curl http://localhost:3000/api/v1/auth/me \
     -H "Authorization: Bearer <accessToken>"
   ```

5. **Create WS ticket**
   ```bash
   curl -X POST http://localhost:3000/api/v1/auth/ws-ticket \
     -H "Authorization: Bearer <accessToken>"
   ```

6. **List active sessions**
   ```bash
   curl http://localhost:3000/api/v1/auth/sessions \
     -H "Authorization: Bearer <accessToken>"
   ```

## 🧪 Testing

```bash
cd api && npm test
cd engine && npm test
cd ws && npm test
```

## 🐳 Docker Deployment

```bash
# Build and start all services
docker-compose up --build

# Run in background
docker-compose up -d

# View logs
docker-compose logs -f

# Stop all services
docker-compose down

# Reset everything (including database)
docker-compose down -v
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request
