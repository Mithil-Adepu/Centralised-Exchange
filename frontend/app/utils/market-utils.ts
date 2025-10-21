/**
 * Utility functions for market data handling
 */

import { Ticker } from "./types";

/**
 * Filter tickers to show only SPOT markets (excluding PERP)
 */
export function filterSpotMarkets(tickers: Ticker[]): Ticker[] {
    return tickers.filter(t => !t.symbol.endsWith('_PERP'));
}

/**
 * Filter tickers to show only PERP markets
 */
export function filterPerpMarkets(tickers: Ticker[]): Ticker[] {
    return tickers.filter(t => t.symbol.endsWith('_PERP'));
}

/**
 * Filter tickers by quote currency (e.g., USDC)
 */
export function filterByQuote(tickers: Ticker[], quote: string): Ticker[] {
    return tickers.filter(t => {
        const parts = t.symbol.split('_');
        const quoteSymbol = parts[parts.length - 1];
        return quoteSymbol === quote || quoteSymbol === quote + '_PERP';
    });
}

/**
 * Get base and quote symbols from a market symbol
 * Examples:
 * - SOL_USDC => [SOL, USDC]
 * - BTC_USDC_PERP => [BTC, USDC]
 */
export function parseMarketSymbol(symbol: string): [string, string] {
    const parts = symbol.split('_');
    if (parts.length === 3 && parts[2] === 'PERP') {
        // PERP market: BTC_USDC_PERP
        return [parts[0] || '', parts[1] || ''];
    } else if (parts.length === 2) {
        // SPOT market: SOL_USDC
        return [parts[0] || '', parts[1] || ''];
    }
    // Fallback
    return [parts[0] || '', parts.slice(1).join('_')];
}

/**
 * Check if a market is a perpetual
 */
export function isPerp(symbol: string): boolean {
    return symbol.endsWith('_PERP');
}

/**
 * Get the base market symbol (remove _PERP suffix if present)
 */
export function getBaseMarketSymbol(symbol: string): string {
    if (symbol.endsWith('_PERP')) {
        return symbol.replace('_PERP', '');
    }
    return symbol;
}

