import { RawData, WebSocket, WebSocketServer } from "ws";
import { UserManager } from "./UserManager";
import { TicketStore } from "./TicketStore";

const WS_PORT = Number(process.env.WS_PORT) || 3001;
const AUTH_MESSAGE_MAX_BYTES = 1024;
const CONNECTION_WINDOW_MS = 60_000;
const MAX_CONNECTIONS_PER_WINDOW = 60;

const connectionCounters = new Map<string, { count: number; resetAt: number }>();

type TicketMessage = {
    ticket?: string;
    method?: string;
    params?: {
        ticket?: string;
    };
};

function rawDataByteLength(rawMessage: RawData) {
    if (typeof rawMessage === "string") {
        return Buffer.byteLength(rawMessage);
    }

    if (Array.isArray(rawMessage)) {
        return rawMessage.reduce((sum, part) => sum + part.length, 0);
    }

    if (rawMessage instanceof ArrayBuffer) {
        return rawMessage.byteLength;
    }

    return rawMessage.length;
}

function rawDataToString(rawMessage: RawData) {
    if (typeof rawMessage === "string") {
        return rawMessage;
    }

    if (Array.isArray(rawMessage)) {
        return (rawMessage as Buffer[]).map((part) => part.toString()).join("");
    }

    if (rawMessage instanceof ArrayBuffer) {
        return Buffer.from(rawMessage).toString();
    }

    return rawMessage.toString();
}

function getClientIp(req: any) {
    const forwarded = req?.headers?.["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
        return forwarded.split(",")[0]?.trim() || "unknown";
    }
    return req?.socket?.remoteAddress || "unknown";
}

function checkConnectionLimit(ip: string) {
    const now = Date.now();
    const current = connectionCounters.get(ip);

    if (!current || current.resetAt <= now) {
        connectionCounters.set(ip, {
            count: 1,
            resetAt: now + CONNECTION_WINDOW_MS,
        });
        return true;
    }

    current.count += 1;
    return current.count <= MAX_CONNECTIONS_PER_WINDOW;
}

const wss = new WebSocketServer({ port: WS_PORT });

wss.on("connection", (ws, req) => {
    console.log('🔌 New WebSocket connection');

    UserManager.getInstance().addUser(ws, "guest");

    const clientIp = getClientIp(req);
    if (!checkConnectionLimit(clientIp)) {
        ws.send(JSON.stringify({ error: "Too many connection attempts" }));
        ws.close(4008, "Rate limit exceeded");
        return;
    }

    ws.on("message", async (rawMessage) => {
        try {
            if (rawDataByteLength(rawMessage) > AUTH_MESSAGE_MAX_BYTES) {
                ws.send(JSON.stringify({ error: "Payload too large" }));
                return;
            }

            const parsedMessage: TicketMessage = JSON.parse(rawDataToString(rawMessage));
            const ticket = parsedMessage.ticket || parsedMessage.params?.ticket;

            if (parsedMessage.method === "AUTH" && ticket) {
                if (!/^[0-9a-fA-F-]{36}$/.test(ticket)) {
                    ws.send(JSON.stringify({ error: "Invalid ticket format" }));
                    return;
                }

                const payload = await TicketStore.getInstance().consume(ticket);
                if (!payload) {
                    ws.send(JSON.stringify({ error: "Invalid or expired ticket" }));
                    return;
                }

                ws.send(JSON.stringify({
                    type: "AUTH_SUCCESS",
                    userId: payload.userId,
                }));
            }
        } catch (error) {
            ws.send(JSON.stringify({ error: "Invalid message payload" }));
        }
    });

    ws.on("close", () => {
        // Subscription cleanup is handled by UserManager.
    });
});

