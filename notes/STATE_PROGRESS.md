# Project Mastery & Modernization State: Centralised Exchange

This document serves as the **Single Source of Truth** for the line-by-line architectural analysis, reverse-engineering, and master notes generation for this production cryptocurrency centralized exchange.

---

## 1. Syllabus & Progress Matrix

| Module | Title & Focus Area | Key Files Analyzed | Status |
| :--- | :--- | :--- | :---: |
| **00** | **System Architecture & Disruptor Blueprint** | System Topology, LMAX Paradigm, Sequence Flow, Zero Data Loss | ✅ **Completed** |
| **01** | **Precision Math & Financial Foundations** | `engine/src/trade/precision.ts`, `shared/src/index.ts` | ✅ **Completed** |
| **02** | **The Order Book & Matching Algorithm** | `engine/src/trade/Orderbook.ts` | ✅ **Completed** |
| **03** | **Matching Engine Core State Machine** | `engine/src/trade/Engine.ts` | ✅ **Completed** |
| **04** | **Crash Recovery, Snapshots & Redis Streams** | `engine/src/index.ts`, `engine/src/RedisManager.ts` | ✅ **Completed** |
| **05** | **API Gateway Routing & Request Lifecycle** | `api/src/index.ts`, `api/src/routes/*`, `api/src/RedisManager.ts` | ✅ **Completed** |
| **06** | **Enterprise Auth & Session Security** | `api/src/auth/*`, `api/src/routes/auth.ts`, `api/src/routes/sessionCleanup.ts`| ✅ **Completed** |
| **07** | **Fiat Onramp & Payment Integration** | `api/src/routes/razorpay.ts`, `frontend/app/deposit/page.tsx` | ✅ **Completed** |
| **08** | **Real-Time WebSocket Gateway & Pub/Sub** | `ws/src/index.ts`, `ws/src/UserManager.ts`, `ws/src/SubscriptionManager.ts` | ✅ **Completed** |
| **09** | **Persistence, TimescaleDB & Kline Views** | `db/src/index.ts`, `db/src/seed-db.ts` | ✅ **Completed** |
| **10** | **Market Maker Bot & Liquidity Simulation** | `mm/src/index.ts` | ✅ **Completed** |
| **11** | **Frontend Architecture, State & Trading UI** | `frontend/app/utils/*`, `frontend/app/store/*`, `frontend/app/components/*` | ✅ **Completed** |
| **12** | **Infrastructure, Docker & DevOps** | `docker-compose.yml`, `nginx/nginx.conf`, Dockerfiles | ✅ **Completed** |
| **13** | **"What-If" Scenarios & Production Evolution** | Failure Modes, Edge Cases, Institutional Scaling Roadmap | ✅ **Completed** |

---

## 2. Master Notes Index

All notes are stored in the [`notes/`](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/notes) folder. Each document is a self-contained, textbook-grade masterclass featuring:
- High-level architecture, design philosophy, and tradeoffs.
- Low-level, function-by-function, line-by-line code dissection.
- Data flow diagrams and inter-process communication contracts.
- Edge case handling, failure recovery, and mathematical proofs.

### Complete Document Catalog:
1. [00_EXCHANGE_BLUEPRINT_AND_SYSTEM_ARCHITECTURE.md](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/notes/00_EXCHANGE_BLUEPRINT_AND_SYSTEM_ARCHITECTURE.md)
   - LMAX Disruptor philosophy, single-threaded in-memory core, end-to-end request sequence diagram, defense-in-depth matrix.
2. [01_PRECISION_MATH_AND_FINANCIAL_FOUNDATIONS.md](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/notes/01_PRECISION_MATH_AND_FINANCIAL_FOUNDATIONS.md)
   - IEEE 754 floating point hazards, fixed-point integer scaling (`SCALE = 1,000,000`), BigInt operations, input validation bounds.
3. [02_THE_ORDER_BOOK_AND_MATCHING_ALGORITHM.md](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/notes/02_THE_ORDER_BOOK_AND_MATCHING_ALGORITHM.md)
   - Price-Time priority (FIFO), `addOrder`, `matchBid`, `matchAsk`, self-trade prevention, maker vs. taker economics, $O(1)$ depth cache maintenance.
4. [03_THE_MATCHING_ENGINE_CORE_STATE_MACHINE.md](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/notes/03_THE_MATCHING_ENGINE_CORE_STATE_MACHINE.md)
   - Balance locking, double-entry settlement, mathematical proof of the **price improvement refund**, deposit minting idempotency, 24h ticker aggregation.
5. [04_CRASH_RECOVERY_SNAPSHOTS_AND_REDIS_STREAMS.md](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/notes/04_CRASH_RECOVERY_SNAPSHOTS_AND_REDIS_STREAMS.md)
   - Redis Streams consumer groups (`XADD`, `XREADGROUP`, `XACK`), pending message replay, dead-letter queue (`engine_dlq`), two-phase atomic snapshotting (`.tmp.json` $\rightarrow$ `.json`), graceful shutdown signals.
6. [05_API_GATEWAY_ROUTING_AND_REQUEST_LIFECYCLE.md](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/notes/05_API_GATEWAY_ROUTING_AND_REQUEST_LIFECYCLE.md)
   - Stateless Express gateway, ephemeral Redis Pub/Sub RPC bridge (`sendAndAwait` with subscribe-before-publish race condition fix), structured JSON logging, security headers.
7. [06_ENTERPRISE_AUTHENTICATION_AND_SESSION_SECURITY.md](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/notes/06_ENTERPRISE_AUTHENTICATION_AND_SESSION_SECURITY.md)
   - Dual-token architecture (JWT + HttpOnly refresh cookie), SHA-256 session hashing, token reuse detection, atomic 3-session eviction, Redis brute-force lockout, CSPRNG email OTP.
8. [07_FIAT_ONRAMP_AND_PAYMENT_GATEWAY_INTEGRATION.md](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/notes/07_FIAT_ONRAMP_AND_PAYMENT_GATEWAY_INTEGRATION.md)
   - Razorpay INR onramp, constant-time HMAC-SHA256 signature verification, compare-and-swap SQL state transitions, engine deposit minting.
9. [08_REALTIME_WEBSOCKET_GATEWAY_AND_PUBSUB.md](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/notes/08_REALTIME_WEBSOCKET_GATEWAY_AND_PUBSUB.md)
   - Rate limiting, atomic 60s ticket validation via Redis `GETDEL`, zombie socket ping/pong pruning, reference-counted reverse-index Pub/Sub multiplexing.
10. [09_PERSISTENCE_TIMESCALEDB_AND_CANDLESTICK_AGGREGATION.md](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/notes/09_PERSISTENCE_TIMESCALEDB_AND_CANDLESTICK_AGGREGATION.md)
    - TimescaleDB hypertable `sol_usdc_prices`, 7 candlestick materialized views (`klines_1m` to `klines_1w`), non-blocking concurrent refreshes (`REFRESH MATERIALIZED VIEW CONCURRENTLY`), `db_processor_dlq`, bounded random-walk price seeder.
11. [10_MARKET_MAKER_BOT_AND_LIQUIDITY_SIMULATION.md](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/notes/10_MARKET_MAKER_BOT_AND_LIQUIDITY_SIMULATION.md)
    - Cold-start liquidity bootstrap, internal service token bypass, 4 trader archetypes (`MARKET_MAKER`, `MOMENTUM_TRADER`, `MEAN_REVERTER`, `SCALPER`), 20-level orderbook laddering, volatility injection.
12. [11_FRONTEND_ARCHITECTURE_STATE_AND_TRADING_UI.md](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/notes/11_FRONTEND_ARCHITECTURE_STATE_AND_TRADING_UI.md)
    - Next.js trading terminal, Axios 401 silent token refresh replay queue, reference-counted WebSocket client (`SignalingManager`), TradingView Lightweight Charts canvas rendering, order placement slippage collar, Zustand state stores.
13. [12_INFRASTRUCTURE_CONTAINERIZATION_AND_DEVOPS.md](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/notes/12_INFRASTRUCTURE_CONTAINERIZATION_AND_DEVOPS.md)
    - Docker Compose multi-service topology, condition-gated healthcheck boot orchestration (`service_healthy` and `service_completed_successfully`), multi-stage lean Dockerfiles, Nginx TLS termination with 7-day WebSocket keepalive, production operational runbook.
14. [13_BRAINSTORMING_WHAT_IF_SCENARIOS_AND_PRODUCTION_EVOLUTION.md](file:///c:/webdevcode/PROJECTS/Centralised-Exchange/notes/13_BRAINSTORMING_WHAT_IF_SCENARIOS_AND_PRODUCTION_EVOLUTION.md)
    - Exhaustive "What-If" failure scenario matrix (Redis crash, Engine OOM, cancel vs. fill races, DB lag, account takeover), and institutional evolution roadmap to 100,000+ orders/sec (C++/Rust matching core, LMAX Disruptor lock-free RingBuffer, Raft active-passive HA, FIX 4.4 protocol, CPU core pinning).
