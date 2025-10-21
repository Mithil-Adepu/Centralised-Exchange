import { WS_RECONNECT_DELAY, WS_MAX_RECONNECT_ATTEMPTS } from "../lib/constants";

export const BASE_URL = "ws://localhost:3001"

export class SignalingManager {
    private ws: WebSocket | null = null;
    private static instance: SignalingManager;
    private bufferedMessages: any[] = [];
    private callbacks: any = {};
    private id: number;
    private initialized: boolean = false;
    private reconnectAttempts: number = 0;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private shouldReconnect: boolean = true;
    private subscriptions: string[] = [];

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
            console.log('🔌 Connecting to Backpack WebSocket...');
            this.ws = new WebSocket(BASE_URL);
            this.init();
        } catch (error) {
            console.error('❌ WebSocket connection error:', error);
            this.handleReconnect();
        }
    }

    private init() {
        if (!this.ws) return;

        this.ws.onopen = () => {
            console.log('✅ WebSocket connected to Backpack');
            this.initialized = true;
            this.reconnectAttempts = 0;

            if (this.reconnectTimeout) {
                clearTimeout(this.reconnectTimeout);
                this.reconnectTimeout = null;
            }

            this.bufferedMessages.forEach(message => {
                this.ws?.send(JSON.stringify(message));
            });
            this.bufferedMessages = [];

            this.subscriptions.forEach(sub => {
                this.ws?.send(JSON.stringify({ method: "SUBSCRIBE", params: [sub] }));
            });
        };

        this.ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);

                if (message.error) {
                    console.error('❌ WebSocket error:', message.error);
                    return;
                }

                if (message.result === null && message.id) {
                    console.log('✅ Subscription confirmed for id:', message.id);
                    return;
                }

                // Backpack WebSocket format: { stream: "type.symbol", data: {...} }
                if (message.stream && message.data) {
                    // Split stream by '.' to get type and symbol (e.g., "ticker.SOL_USDC")
                    const streamParts = message.stream.split('.');
                    const type = streamParts[0];
                    const symbol = streamParts.slice(1).join('.'); // Handle symbols with dots

                    switch (type) {
                        case 'ticker':
                            this.triggerCallbacks("ticker", {
                                symbol: symbol,
                                ...message.data
                            });
                            break;
                        case 'depth':
                            this.triggerCallbacks("depth", message.data);
                            break;
                        case 'trade':
                            this.triggerCallbacks("trade", message.data);
                            break;
                        default:
                            console.log('📨 Unknown stream type:', type, 'from stream:', message.stream);
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
            console.log('🔌 WebSocket disconnected');
            this.initialized = false;
            this.handleReconnect();
        };
    }

    private handleReconnect() {
        if (!this.shouldReconnect || this.reconnectAttempts >= WS_MAX_RECONNECT_ATTEMPTS) {
            console.log('🛑 Max reconnection attempts reached or reconnection disabled');
            return;
        }

        this.reconnectAttempts++;
        console.log(`🔄 Attempting to reconnect (${this.reconnectAttempts}/${WS_MAX_RECONNECT_ATTEMPTS})...`);

        this.reconnectTimeout = setTimeout(() => {
            this.connect();
        }, WS_RECONNECT_DELAY);
    }

    private triggerCallbacks(type: string, data: any) {
        const callbacks = this.callbacks[type] || [];
        callbacks.forEach(([callback]: [Function, string]) => {
            callback(data);
        });
    }

    public sendMessage(message: any) {
        const messageWithId = { ...message, id: this.id++ };

        if (message.method === "SUBSCRIBE" && message.params?.[0]) {
            this.subscriptions.push(message.params[0]);
        } else if (message.method === "UNSUBSCRIBE" && message.params?.[0]) {
            this.subscriptions = this.subscriptions.filter(sub => sub !== message.params[0]);
        }

        if (!this.initialized || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.log('⏳ WebSocket not ready, buffering message:', messageWithId);
            this.bufferedMessages.push(messageWithId);
            return;
        }

        console.log('📤 Sending WebSocket message:', messageWithId);
        this.ws.send(JSON.stringify(messageWithId));
    }

    public registerCallback(type: string, callback: Function, id: string) {
        this.callbacks[type] = this.callbacks[type] || [];
        this.callbacks[type].push([callback, id]);
        console.log(`📝 Registered ${type} callback with id: ${id}`);
    }

    public deRegisterCallback(type: string, id: string) {
        if (this.callbacks[type]) {
            this.callbacks[type] = this.callbacks[type].filter(([, cbId]: [Function, string]) => cbId !== id);
            console.log(`🗑️ Deregistered ${type} callback with id: ${id}`);
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

    public subscribeToDepth(market: string, callback: (data: any) => void) {
        this.registerCallback(`depth.${market}`, callback, `DEPTH-${market}`);
    }

    public subscribeToTicker(market: string, callback: (data: any) => void) {
        this.registerCallback(`ticker.${market}`, callback, `TICKER-${market}`);
    }

    public subscribeToChart(market: string, callback: (data: any) => void) {
        this.registerCallback(`trade.${market}`, callback, `CHART-${market}`);
    }

    public destroy() {
        console.log('🧹 Destroying SignalingManager...');
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
        this.subscriptions = [];
        this.initialized = false;
    }
}