// Backpack Exchange API Types

export interface KLine {
    close: string;
    end: string;
    high: string;
    low: string;
    open: string;
    quoteVolume: string;
    start: string;
    trades: string;
    volume: string;
}

export interface Trade {
    id: number;
    isBuyerMaker: boolean;
    price: string;
    quantity: string;
    quoteQuantity: string;
    timestamp: number;
}

export interface Depth {
    bids: [string, string][];
    asks: [string, string][];
    lastUpdateId: string;
    timestamp: number;
}

export interface Ticker {
    firstPrice: string;
    high: string;
    lastPrice: string;
    low: string;
    priceChange: string;
    priceChangePercent: string;
    quoteVolume: string;
    symbol: string;
    trades: string;
    volume: string;
}

export interface Market {
    baseSymbol: string;
    quoteSymbol: string;
    symbol: string;
    marketType: 'SPOT' | 'PERP';
    visible: boolean;
    orderBookState: 'Open' | 'Closed' | 'PostOnly';
    filters: {
        price: {
            minPrice: string | null;
            maxPrice: string | null;
            tickSize: string;
        };
        quantity: {
            minQuantity: string | null;
            maxQuantity: string | null;
            stepSize: string;
        };
    };
}