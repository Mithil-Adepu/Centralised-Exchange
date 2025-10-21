export const CHART_INTERVALS = [
  { label: '1m', value: '1m', seconds: 60 },
  { label: '5m', value: '5m', seconds: 300 },
  { label: '15m', value: '15m', seconds: 900 },
  { label: '1H', value: '1h', seconds: 3600 },
  { label: '4H', value: '4h', seconds: 14400 },
  { label: '1D', value: '1d', seconds: 86400 },
  { label: '1W', value: '1w', seconds: 604800 },
] as const;

export const DEFAULT_INTERVAL = '1h';

export const ORDERBOOK_DEPTH = 15;

export const TRADES_LIMIT = 50;

export const MARKETS_REFRESH_INTERVAL = 5000; // 5 seconds

export const TICKER_REFRESH_INTERVAL = 1000; // 1 second

export const WS_RECONNECT_DELAY = 3000; // 3 seconds

export const WS_MAX_RECONNECT_ATTEMPTS = 10;

export const API_REQUEST_TIMEOUT = 10000; // 10 seconds

export const POPULAR_MARKETS = [
  'SOL_USDC',
  'BTC_USDC',
  'ETH_USDC',
  'BONK_USDC',
  'WIF_USDC',
] as const;

export const MARKET_CATEGORIES = {
  ALL: 'All Markets',
  FAVORITES: 'Favorites',
  SPOT: 'Spot Markets',
  PERP: 'Perpetuals',
  USDC: 'USDC Markets',
} as const;

export const ORDER_TYPES = {
  LIMIT: 'Limit',
  MARKET: 'Market',
} as const;

export const ORDER_SIDES = {
  BUY: 'buy',
  SELL: 'sell',
} as const;

export const PRICE_PRECISION = 2;
export const QUANTITY_PRECISION = 4;
export const PERCENTAGE_PRECISION = 2;

