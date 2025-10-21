//TODO: Can we share the types between the ws layer and the engine?

export type TickerUpdateMessage = {
    stream: string, 
    data: {
        lastPrice?: string,
        high?: string,
        low?: string,
        volume?: string,
        quoteVolume?: string,
        symbol?: string,
        priceChange?: string,
        priceChangePercent?: string,
        firstPrice?: string,
        trades?: string,
        id: number,
        e: "ticker"
    }
}

export type DepthUpdateMessage = {
    stream: string,
    data: {
        b?: [string, string][],
        a?: [string, string][],
        e: "depth"
    }
}

export type TradeAddedMessage = {
    stream: string,
    data: {
        e: "trade",
        t: number,
        m: boolean,
        p: string,
        q: string,
        s: string, // symbol
    }
}

export type WsMessage = TickerUpdateMessage | DepthUpdateMessage | TradeAddedMessage;
