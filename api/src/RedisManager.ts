
import { RedisClientType, createClient } from "redis";
import { MessageFromOrderbook } from "./types";
import { MessageToEngine } from "./types/to";

export class RedisManager {
    private client: RedisClientType;
    private publisher: RedisClientType;
    private static instance: RedisManager;

    private constructor() {
        this.client = createClient();
        this.client.connect();
        this.publisher = createClient();
        this.publisher.connect();
    }

    public static getInstance() {
        if (!this.instance)  {
            this.instance = new RedisManager();
        }
        return this.instance;
    }

    public sendAndAwait(message: MessageToEngine) {
        return new Promise<MessageFromOrderbook>((resolve, reject) => {
            const id = this.getRandomClientId();
            
            // Add timeout to prevent hanging forever
            const timeout = setTimeout(() => {
                this.client.unsubscribe(id);
                reject(new Error('Engine response timeout - is the engine running?'));
            }, 10000); // 10 second timeout
            
            this.client.subscribe(id, (message) => {
                clearTimeout(timeout);
                this.client.unsubscribe(id);
                resolve(JSON.parse(message));
            });
            
            this.publisher.lPush("messages", JSON.stringify({ clientId: id, message }));
        });
    }

    public getRandomClientId() {
        return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    }

}