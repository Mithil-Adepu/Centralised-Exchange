import { WS_RECONNECT_DELAY } from "../lib/constants";
import { getWsTicket, isAuthenticated } from "./httpClient";
import { Trade } from "./types";

const wsBaseUrl = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3001";
const DEBUG = process.env.NODE_ENV !== "production";

function log(...args: unknown[]) {
    if (DEBUG) {
        console.log(...args);
    }
}

function normalizeTradeMessage(data: any): Trade | null {
    if (!data) {
        return null;
    }

    const price = data.price ?? data.p;
    const quantity = data.quantity ?? data.q;
    if (!price || !quantity) {
        return null;
    }

    const rawTimestamp = data.timestamp ?? data.t;
    let timestamp = Date.now();
    if (typeof rawTimestamp === "number") {
        timestamp = rawTimestamp > 1e12 ? rawTimestamp : rawTimestamp * 1000;
    }

    const id = typeof data.id === "number"
        ? data.id
        : typeof data.t === "number"
            ? data.t
            : Date.now();

    const isBuyerMaker = typeof data.isBuyerMaker === "boolean"
        ? data.isBuyerMaker
        : Boolean(data.m);

    const quoteQuantity = data.quoteQuantity ?? (Number(price) * Number(quantity)).toString();

    return {
        id,
        price: price.toString(),
        quantity: quantity.toString(),
        quoteQuantity: quoteQuantity.toString(),
        timestamp,
        isBuyerMaker,
        symbol: data.symbol ?? data.s,
    };
}

export class SignalingManager {
    private ws: WebSocket | null = null;
    private static instance: SignalingManager;
    private bufferedMessages: any[] = [];
    private callbacks: Record<string, [Function, string][]> = {};
    private id: number;
    private initialized: boolean = false;
    private reconnectAttempts: number = 0;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private shouldReconnect: boolean = true;
    // Per-stream reference count: multiple components can share a stream, so we only
    // send SUBSCRIBE on the first subscriber (0->1) and UNSUBSCRIBE on the last (1->0).
    // A plain Set let one component's unmount kill the feed for every other consumer.
    private subscriptions: Map<string, number> = new Map();

    private constructor() {
        this.id = 1;
        this.connect();
    }

    public static getInstance() {
        if (!this.instance) {
            this.instance = new SignalingManager();
        }
        return this.instance;
    }

    private connect() {
        try {
            log('🔌 Connecting to exchange WebSocket...');
            this.ws = new WebSocket(wsBaseUrl);
            this.init();
        } catch (error) {
            console.error('❌ WebSocket connection error:', error);
            this.handleReconnect();
        }
    }

    private init() {
        if (!this.ws) return;

        this.ws.onopen = () => {
            log('✅ WebSocket connected');
            this.reconnectAttempts = 0;

            if (this.reconnectTimeout) {
                clearTimeout(this.reconnectTimeout);
                this.reconnectTimeout = null;
            }

            if (!isAuthenticated()) {
                this.initialized = true;
                this.flushPendingMessages();
                return;
            }

            this.authenticateSocket().catch((error) => {
                console.error('❌ WebSocket ticket auth failed:', error);
                this.ws?.close();
            });
        };

        this.ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);

                if (message.error) {
                    console.error('❌ WebSocket error:', message.error);
                    return;
                }

                if (message.type === "AUTH_SUCCESS") {
                    this.initialized = true;
                    this.flushPendingMessages();
                    return;
                }

                if (message.result === null && message.id) {
                    log('✅ Subscription confirmed for id:', message.id);
                    return;
                }

                // Backpack WebSocket format: { stream: "type.symbol", data: {...} }
                if (message.stream && message.data) {
                    // Split stream by '.' to get type and symbol (e.g., "ticker.SOL_USDC")
                    const streamParts = message.stream.split('.');
                    const type = streamParts[0];
                    const symbol = streamParts.slice(1).join('.'); // Handle symbols with dots
                    const streamKey = symbol ? `${type}.${symbol}` : type;

                    switch (type) {
                        case 'ticker':
                            this.triggerCallbacks(streamKey, {
                                ...message.data,
                                symbol: message.data.symbol ?? symbol,
                            });
                            break;
                        case 'depth':
                            this.triggerCallbacks(streamKey, message.data);
                            break;
                        case 'trade':
                            {
                                const trade = normalizeTradeMessage({
                                    ...message.data,
                                    symbol: message.data.symbol ?? symbol,
                                });
                                if (trade) {
                                    this.triggerCallbacks(streamKey, trade);
                                }
                            }
                            break;
                        default:
                            log('📨 Unknown stream type:', type, 'from stream:', message.stream);
                    }
                }
            } catch (error) {
                console.error('❌ Error parsing WebSocket message:', error);
            }
        };

        this.ws.onerror = (error) => {
            console.error('❌ WebSocket error:', error);
        };

        this.ws.onclose = () => {
            log('🔌 WebSocket disconnected');
            this.initialized = false;
            this.handleReconnect();
        };
    }

    private handleReconnect() {
        if (!this.shouldReconnect) {
            return; // Intentional teardown — don't reconnect.
        }
        if (this.reconnectTimeout) {
            return; // A reconnect is already scheduled.
        }

        this.reconnectAttempts++;
        // Exponential backoff capped at 30s. We never give up permanently: a hard
        // stop left the live UI silently frozen with no path to recover. This way
        // the UI heals automatically once the WS server is reachable again.
        const delay = Math.min(WS_RECONNECT_DELAY * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5)), 30_000);
        log(`🔄 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);

        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            this.connect();
        }, delay);
    }

    private async authenticateSocket() {
        if (!isAuthenticated()) {
            throw new Error("User not authenticated — please log in");
        }

        const { ticket } = await getWsTicket();

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocket closed before authentication");
        }

        this.ws.send(JSON.stringify({
            method: "AUTH",
            params: { ticket }
        }));
    }

    private flushPendingMessages() {
        this.bufferedMessages.forEach((bufferedMessage) => {
            this.ws?.send(JSON.stringify(bufferedMessage));
        });
        this.bufferedMessages = [];

        this.subscriptions.forEach((count, sub) => {
            if (count > 0) {
                this.ws?.send(JSON.stringify({ method: "SUBSCRIBE", params: [sub] }));
            }
        });
    }

    private triggerCallbacks(type: string, data: any) {
        const callbacks = this.callbacks[type] || [];
        callbacks.forEach(([callback]: [Function, string]) => {
            callback(data);
        });
    }

    public sendMessage(message: any) {
        const isSubscribe = message.method === "SUBSCRIBE" && message.params?.[0];
        const isUnsubscribe = message.method === "UNSUBSCRIBE" && message.params?.[0];

        // Reference-count shared streams so a component unmount doesn't tear down
        // a feed other mounted components still need.
        if (isSubscribe) {
            const stream = message.params[0];
            const count = (this.subscriptions.get(stream) || 0) + 1;
            this.subscriptions.set(stream, count);
            if (count > 1) {
                return; // Already subscribed for another consumer.
            }
        } else if (isUnsubscribe) {
            const stream = message.params[0];
            const count = (this.subscriptions.get(stream) || 0) - 1;
            if (count > 0) {
                this.subscriptions.set(stream, count);
                return; // Other consumers still need this stream.
            }
            this.subscriptions.delete(stream);
        }

        const messageWithId = { ...message, id: this.id++ };

        if (!this.initialized || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            if (!isSubscribe && !isUnsubscribe) {
                log('⏳ WebSocket not ready, buffering message:', messageWithId);
                this.bufferedMessages.push(messageWithId);
            }
            // Subscriptions are re-sent from the ref-count map on (re)connect.
            return;
        }

        log('📤 Sending WebSocket message:', messageWithId);
        this.ws.send(JSON.stringify(messageWithId));
    }

    public registerCallback(type: string, callback: Function, id: string) {
        this.callbacks[type] = this.callbacks[type] || [];
        this.callbacks[type] = this.callbacks[type].filter(([, cbId]) => cbId !== id);
        this.callbacks[type].push([callback, id]);
        log(`📝 Registered ${type} callback with id: ${id}`);
    }

    public deRegisterCallback(type: string, id: string) {
        if (this.callbacks[type]) {
            this.callbacks[type] = this.callbacks[type].filter(([, cbId]: [Function, string]) => cbId !== id);
            log(`🗑️ Deregistered ${type} callback with id: ${id}`);
        }
    }

    public getConnectionState(): string {
        if (!this.ws) return 'DISCONNECTED';

        switch (this.ws.readyState) {
            case WebSocket.CONNECTING:
                return 'CONNECTING';
            case WebSocket.OPEN:
                return 'CONNECTED';
            case WebSocket.CLOSING:
                return 'CLOSING';
            case WebSocket.CLOSED:
                return 'DISCONNECTED';
            default:
                return 'UNKNOWN';
        }
    }

    public destroy() {
        log('🧹 Destroying SignalingManager...');
        this.shouldReconnect = false;

        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        this.callbacks = {};
        this.bufferedMessages = [];
        this.subscriptions.clear();
        this.initialized = false;
    }
}