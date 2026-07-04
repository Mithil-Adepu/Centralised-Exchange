export const CREATE_ORDER = "CREATE_ORDER";
export const CANCEL_ORDER = "CANCEL_ORDER";
export const ON_RAMP = "ON_RAMP";
export const GET_OPEN_ORDERS = "GET_OPEN_ORDERS";
export const GET_TICKERS = "GET_TICKERS";
export const GET_DEPTH = "GET_DEPTH";
export const GET_BALANCES = "GET_BALANCES";

export type MessageToEngine =
  | {
    type: typeof CREATE_ORDER;
    data: {
      market: string;
      price: string;
      quantity: string;
      side: "buy" | "sell";
      userId: string;
    };
  }
  | {
    type: typeof CANCEL_ORDER;
    data: {
      orderId: string;
      market: string;
      userId: string;
    };
  }
  | {
    type: typeof ON_RAMP;
    data: {
      amount: string;
      userId: string;
      txnId?: string;
    };
  }
  | {
    type: typeof GET_DEPTH;
    data: {
      market: string;
    };
  }
  | {
    type: typeof GET_OPEN_ORDERS;
    data: {
      userId: string;
      market: string;
    };
  }
  | {
    type: typeof GET_TICKERS;
    data: {
      market?: string;
    };
  }
  | {
    type: typeof GET_BALANCES;
    data: {
      userId: string;
    };
  };

export type OpenOrder = {
  orderId: string;
  executedQty: number;
  price: string;
  quantity: string;
  side: "buy" | "sell";
  userId: string;
  timestamp: number;
};

export type MessageToApi =
  | {
    type: "DEPTH";
    payload: {
      bids: [string, string][];
      asks: [string, string][];
    };
  }
  | {
    type: "ORDER_PLACED";
    payload: {
      orderId: string;
      executedQty: number;
      fills: {
        price: string;
        qty: number;
        tradeId: number;
      }[];
    };
  }
  | {
    type: "ORDER_CANCELLED";
    payload: {
      orderId: string;
      executedQty: number;
      remainingQty: number;
    };
  }
  | {
    type: "OPEN_ORDERS";
    payload: OpenOrder[];
  }
  | {
    type: "TICKERS";
    payload: {
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
    }[];
  }
  | {
    type: "ON_RAMP_SUCCESS";
    payload: {
      userId: string;
      amount: number;
    };
  }
  | {
    type: "ON_RAMP_FAILURE";
    payload: {
      userId: string;
      error: string;
    };
  }
  | {
    type: "BALANCES";
    payload: {
      userId: string;
      balances: Record<string, { available: number; locked: number }>;
    };
  }
  | {
    type: "ORDER_REJECTED";
    payload: {
      orderId?: string;
      reason: string;
    };
  }
  | {
    type: "CANCEL_ORDER_REJECTED";
    payload: {
      error: string;
    };
  };

export type MessageFromOrderbook = MessageToApi;

export type TickerUpdateMessage = {
  stream: string;
  data: {
    lastPrice?: string;
    high?: string;
    low?: string;
    volume?: string;
    quoteVolume?: string;
    symbol?: string;
    priceChange?: string;
    priceChangePercent?: string;
    firstPrice?: string;
    trades?: string;
    id: number;
    e: "ticker";
  };
};

export type DepthUpdateMessage = {
  stream: string;
  data: {
    b?: [string, string][];
    a?: [string, string][];
    e: "depth";
    // When true, `b`/`a` are the FULL book (replace local state), not a delta.
    // Absent/false means an incremental update (merge; qty "0" removes a level).
    snapshot?: boolean;
  };
};

export type TradeUpdateMessage = {
  stream: string;
  data: {
    e: "trade";
    id: number;
    price: string;
    quantity: string;
    quoteQuantity: string;
    timestamp: number;
    isBuyerMaker: boolean;
    symbol: string;
  };
};

export type WsMessage =
  | TickerUpdateMessage
  | DepthUpdateMessage
  | TradeUpdateMessage;

export type OutgoingMessage = WsMessage;
