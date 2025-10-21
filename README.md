# Centralized Exchange Platform

A comprehensive  exchange platform built with modern web technologies, featuring real-time trading, order matching, and market data visualization.

## 🏗️ Architecture

architecture-diagram.png

This exchange platform consists of multiple microservices:

### Core Components

- **Frontend** - Next.js/React-based trading interface
- **API** - Node.js/TypeScript REST API server
- **Engine** - High-performance trading engine with order matching
- **WebSocket** - Real-time data streaming service
- **Database** - Data persistence and management
- **Market Maker** - Automated market making service
- **Docker** - Containerization and orchestration

## 🚀 Features

- **Real-time Trading**: Live order book updates and trade execution
- **Order Matching Engine**: High-performance order matching algorithm
- **Market Data**: Real-time price feeds, depth charts, and trading history
- **WebSocket API**: Low-latency real-time data streaming
- **Responsive UI**: Modern trading interface
- **Order Management**: Limit orders, market orders, and order history
- **Chart Integration**: Advanced trading charts with technical indicators
- **Multi-market Support**: Support for multiple trading pairs

## 📁 Project Structure

```
exchange/
├── frontend/          # Next.js trading interface
├── api/              # REST API server
├── engine/           # Trading engine
├── ws/               # WebSocket service
├── db/               # Database operations
├── mm/               # Market maker service
└── docker/           # Docker configuration
```

## 🛠️ Technology Stack

- **Frontend**: Next.js, React, TypeScript, Tailwind CSS
- **Backend**: Node.js, TypeScript, Express
- **Database**: Redis, PostgreSQL
- **Real-time**: WebSocket, Server-Sent Events
- **Containerization**: Docker, Docker Compose
- **Testing**: Jest, Supertest

## 🚀 Quick Start

### Prerequisites

- Node.js (v18 or higher)
- Docker and Docker Compose
- Redis
- PostgreSQL

### Installation

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd exchange
   ```

2. **Install dependencies for all services**
   ```bash
   # Install frontend dependencies
   cd frontend && npm install && cd ..
   
   # Install API dependencies
   cd api && npm install && cd ..
   
   # Install engine dependencies
   cd engine && npm install && cd ..
   
   # Install WebSocket dependencies
   cd ws && npm install && cd ..
   
   # Install database dependencies
   cd db && npm install && cd ..
   
   # Install market maker dependencies
   cd mm && npm install && cd ..
   ```

3. **Start services with Docker**
   ```bash
   docker-compose up -d
   ```

4. **Start individual services**
   ```bash
   # Start API server
   cd api && npm run dev
   
   # Start trading engine
   cd engine && npm run dev
   
   # Start WebSocket service
   cd ws && npm run dev
   
   # Start frontend
   cd frontend && npm run dev
   ```

## 🔧 Configuration

### Environment Variables

Create `.env` files in each service directory with the following variables:

**API Service (.env)**
```
PORT=3001
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgresql://user:password@localhost:5432/exchange
```

**Engine Service (.env)**
```
REDIS_URL=redis://localhost:6379
```

**WebSocket Service (.env)**
```
PORT=3002
REDIS_URL=redis://localhost:6379
```

## 📊 API Endpoints

### REST API
- `GET /api/ticker` - Get market ticker data
- `GET /api/depth` - Get order book depth
- `GET /api/trades` - Get recent trades
- `GET /api/klines` - Get candlestick data
- `POST /api/orders` - Place new order
- `GET /api/orders` - Get user orders

### WebSocket API
- `ws://localhost:3002` - Real-time market data
- Subscribe to: `ticker`, `depth`, `trades`, `klines`

## 🧪 Testing

Run tests for each service:

```bash
# Test API
cd api && npm test

# Test Engine
cd engine && npm test

# Test WebSocket
cd ws && npm test
```

## 🐳 Docker Deployment

Deploy the entire platform using Docker:

```bash
# Build and start all services
docker-compose up --build

# Run in background
docker-compose up -d

# View logs
docker-compose logs -f
```
## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

