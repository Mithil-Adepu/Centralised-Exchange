import { describe, expect, it, vi } from "vitest";
import { Engine } from "../trade/Engine";
import { RedisManager } from "../RedisManager";
import { CREATE_ORDER } from "../types/fromApi";

vi.mock("../RedisManager", () => ({
    RedisManager: {
      getInstance: () => ({
        publishMessage: vi.fn(),
        sendToApi: vi.fn(),
        pushMessage: vi.fn()
      })
    }
}));


describe("Engine", () => {
    it("Publishes Trade updates", () => {
        const engine = new Engine();
        const publishSpy = vi.spyOn(engine, "publishWsTrades");
        engine.process({
            message: {
                type: CREATE_ORDER,
                data: {
                    market: "SOL_USDC",
                    price: "1000",
                    quantity: "1",
                    side: "buy",
                    userId: "1"
                }
            },
            clientId: "1"
        });

        engine.process({
            message: {
                type: CREATE_ORDER,
                data: {
                    market: "SOL_USDC",
                    price: "1001",
                    quantity: "1",
                    side: "sell",
                    userId: "2"
                }
            },
            clientId: "1"
        });
        
        expect(publishSpy).toHaveBeenCalledTimes(2);

    });

    it("Sets isBuyerMaker correctly", () => {
        const engine = new Engine();
        const publishSpy = vi.spyOn(engine, "publishWsTrades");

        engine.process({
            message: {
                type: CREATE_ORDER,
                data: {
                    market: "SOL_USDC",
                    price: "1000",
                    quantity: "1",
                    side: "buy",
                    userId: "1"
                }
            },
            clientId: "1"
        });

        engine.process({
            message: {
                type: CREATE_ORDER,
                data: {
                    market: "SOL_USDC",
                    price: "1000",
                    quantity: "1",
                    side: "sell",
                    userId: "2"
                }
            },
            clientId: "1"
        });

        const publishCalls = publishSpy.mock.calls;
        const lastCall = publishCalls[publishCalls.length - 1];
        const fills = lastCall?.[0] || [];
        const side = lastCall?.[2];

        expect(side).toBe("sell");
        expect(fills.length).toBeGreaterThan(0);
    });
});