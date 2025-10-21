import { RedisClientType, createClient } from "redis";
import { UserManager } from "./UserManager";

export class SubscriptionManager {
    private static instance: SubscriptionManager;
    private subscriptions: Map<string, string[]> = new Map();
    private reverseSubscriptions: Map<string, string[]> = new Map();
    private redisClient: RedisClientType;

    private constructor() {
        this.redisClient = createClient();
        this.redisClient.connect().then(() => {
            console.log('✅ WebSocket Redis connected');
        }).catch((err) => {
            console.error('❌ WebSocket Redis connection failed:', err);
        });
        
        this.redisClient.on('error', (err) => {
            console.error('❌ WebSocket Redis error:', err);
        });
    }

    public static getInstance() {
        if (!this.instance)  {
            this.instance = new SubscriptionManager();
        }
        return this.instance;
    }

    public subscribe(userId: string, subscription: string) {
        console.log(`📡 User ${userId} subscribing to: ${subscription}`);
        
        if (this.subscriptions.get(userId)?.includes(subscription)) {
            console.log(`⚠️ User ${userId} already subscribed to ${subscription}`);
            return
        }

        this.subscriptions.set(userId, (this.subscriptions.get(userId) || []).concat(subscription));
        this.reverseSubscriptions.set(subscription, (this.reverseSubscriptions.get(subscription) || []).concat(userId));
        
        if (this.reverseSubscriptions.get(subscription)?.length === 1) {
            console.log(`🔔 First subscriber to ${subscription}, subscribing to Redis`);
            this.redisClient.subscribe(subscription, this.redisCallbackHandler);
        } else {
            console.log(`📊 Additional subscriber to ${subscription}, total: ${this.reverseSubscriptions.get(subscription)?.length}`);
        }
    }

    private redisCallbackHandler = (message: string, channel: string) => {
        console.log(`📨 Redis message received on ${channel}:`, message.substring(0, 100) + '...');
        const parsedMessage = JSON.parse(message);
        const subscribers = this.reverseSubscriptions.get(channel);
        console.log(`📤 Broadcasting to ${subscribers?.length || 0} subscribers`);
        subscribers?.forEach(userId => {
            const user = UserManager.getInstance().getUser(userId);
            if (user) {
                console.log(`📤 Sending to user ${userId}`);
                user.emit(parsedMessage);
            } else {
                console.log(`⚠️ User ${userId} not found`);
            }
        });
    }

    public unsubscribe(userId: string, subscription: string) {
        const subscriptions = this.subscriptions.get(userId);
        if (subscriptions) {
            this.subscriptions.set(userId, subscriptions.filter(s => s !== subscription));
        }
        const reverseSubscriptions = this.reverseSubscriptions.get(subscription);
        if (reverseSubscriptions) {
            this.reverseSubscriptions.set(subscription, reverseSubscriptions.filter(s => s !== userId));
            if (this.reverseSubscriptions.get(subscription)?.length === 0) {
                this.reverseSubscriptions.delete(subscription);
                this.redisClient.unsubscribe(subscription);
            }
        }
    }

    public userLeft(userId: string) {
        console.log("user left " + userId);
        this.subscriptions.get(userId)?.forEach(s => this.unsubscribe(userId, s));
    }
    
    getSubscriptions(userId: string) {
        return this.subscriptions.get(userId) || [];
    }
}