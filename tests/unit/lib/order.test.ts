import assert from "node:assert";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import {
  postOrder,
  clearCooldowns,
  GtcOrderTracker,
} from "../../../src/lib/order";
import { ORDER } from "../../../src/lib/constants";

// Mock ClobClient
function createMockClient(
  options: {
    orderBook?: {
      asks: Array<{ price: string; size: string }>;
      bids: Array<{ price: string; size: string }>;
    } | null;
    postOrderSuccess?: boolean;
    postOrderErrorMsg?: string;
    getOrderBookError?: Error | null;
    getMarketError?: Error | null;
    createMarketOrderFn?: (args: any) => any;
  } = {},
) {
  const mockOrderBook = options.orderBook ?? {
    asks: [{ price: "0.50", size: "100" }],
    bids: [{ price: "0.48", size: "100" }],
  };

  return {
    getMarket: mock.fn(async () => {
      if (options.getMarketError) throw options.getMarketError;
      return { id: "test-market" };
    }),
    getOrderBook: mock.fn(async () => {
      if (options.getOrderBookError) throw options.getOrderBookError;
      return mockOrderBook;
    }),
    createMarketOrder:
      options.createMarketOrderFn ??
      mock.fn(async (args: any) => ({
        ...args,
        signature: "test-signature",
      })),
    postOrder: mock.fn(async () => ({
      success: options.postOrderSuccess ?? true,
      errorMsg: options.postOrderErrorMsg ?? "",
    })),
  };
}

describe("postOrder", () => {
  // Store original env vars
  let originalLiveTrading: string | undefined;

  beforeEach(() => {
    // Clear cooldowns before each test
    clearCooldowns();
    // Store original env
    originalLiveTrading = process.env.LIVE_TRADING;
  });

  afterEach(() => {
    // Restore original env
    if (originalLiveTrading !== undefined) {
      process.env.LIVE_TRADING = originalLiveTrading;
    } else {
      delete process.env.LIVE_TRADING;
    }
    clearCooldowns();
  });

  describe("simulation mode (live trading disabled)", () => {
    it("returns success with SIMULATED reason when live trading is disabled", async () => {
      delete process.env.LIVE_TRADING;
      const client = createMockClient();

      const result = await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        sizeUsd: 10,
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.reason, "SIMULATED");
    });
  });

  describe("order validation", () => {
    beforeEach(() => {
      process.env.LIVE_TRADING = "I_UNDERSTAND_THE_RISKS";
    });

    it("rejects orders below minimum size", async () => {
      const client = createMockClient();

      const result = await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        sizeUsd: ORDER.MIN_ORDER_USD / 2,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, "ORDER_TOO_SMALL");
    });

    it("handles missing orderbook", async () => {
      // Create a mock that returns null from getOrderBook
      const mockClient = {
        getMarket: mock.fn(async () => ({ id: "test-market" })),
        getOrderBook: mock.fn(async () => null),
        createMarketOrder: mock.fn(async (args: any) => ({
          ...args,
          signature: "test-signature",
        })),
        postOrder: mock.fn(async () => ({
          success: true,
          errorMsg: "",
        })),
      };

      const result = await postOrder({
        client: mockClient as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        sizeUsd: 10,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, "NO_ORDERBOOK");
    });

    it("handles empty asks for BUY orders", async () => {
      const client = createMockClient({
        orderBook: { asks: [], bids: [{ price: "0.48", size: "100" }] },
      });

      const result = await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        sizeUsd: 10,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, "NO_ASKS");
    });

    it("handles empty bids for SELL orders", async () => {
      const client = createMockClient({
        orderBook: { asks: [{ price: "0.50", size: "100" }], bids: [] },
      });

      const result = await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "SELL",
        sizeUsd: 10,
        skipDuplicateCheck: true,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, "NO_BIDS");
    });

    it("rejects zero price", async () => {
      const client = createMockClient({
        orderBook: {
          asks: [{ price: "0.0001", size: "100" }],
          bids: [{ price: "0.0001", size: "100" }],
        },
      });

      const result = await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        sizeUsd: 10,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, "ZERO_PRICE");
    });

    it("rejects invalid price (NaN)", async () => {
      const client = createMockClient({
        orderBook: {
          asks: [{ price: "invalid", size: "100" }],
          bids: [{ price: "0.48", size: "100" }],
        },
      });

      const result = await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        sizeUsd: 10,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, "INVALID_PRICE");
    });

    it("rejects inverted orderbook (bid > ask)", async () => {
      const client = createMockClient({
        orderBook: {
          asks: [{ price: "0.40", size: "100" }],
          bids: [{ price: "0.50", size: "100" }], // Bid higher than ask = inverted
        },
      });

      const result = await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        sizeUsd: 10,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, "INVALID_ORDERBOOK");
    });

    it("rejects loser positions (price below global minimum for BUY)", async () => {
      const client = createMockClient({
        orderBook: {
          asks: [{ price: "0.05", size: "100" }], // Below GLOBAL_MIN_BUY_PRICE (0.10)
          bids: [{ price: "0.04", size: "100" }],
        },
      });

      const result = await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        sizeUsd: 10,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, "LOSER_POSITION");
    });
  });

  describe("price protection", () => {
    beforeEach(() => {
      process.env.LIVE_TRADING = "I_UNDERSTAND_THE_RISKS";
    });

    it("rejects BUY when price exceeds maxAcceptablePrice", async () => {
      const client = createMockClient({
        orderBook: {
          asks: [{ price: "0.60", size: "100" }],
          bids: [{ price: "0.58", size: "100" }],
        },
      });

      const result = await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        sizeUsd: 10,
        maxAcceptablePrice: 0.55,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, "PRICE_TOO_HIGH");
    });

    it("rejects SELL when price is below maxAcceptablePrice", async () => {
      const client = createMockClient({
        orderBook: {
          asks: [{ price: "0.50", size: "100" }],
          bids: [{ price: "0.40", size: "100" }],
        },
      });

      const result = await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "SELL",
        sizeUsd: 10,
        maxAcceptablePrice: 0.45,
        skipDuplicateCheck: true,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, "PRICE_TOO_LOW");
    });
  });

  describe("duplicate prevention", () => {
    beforeEach(() => {
      process.env.LIVE_TRADING = "I_UNDERSTAND_THE_RISKS";
    });

    it("prevents duplicate BUY orders within cooldown period", async () => {
      const client = createMockClient();

      // First order should succeed
      const result1 = await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        sizeUsd: 10,
      });
      assert.strictEqual(result1.success, true);

      // Second immediate order should be blocked
      const result2 = await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        sizeUsd: 10,
      });
      assert.strictEqual(result2.success, false);
      assert.strictEqual(result2.reason, "IN_FLIGHT");
    });

    it("allows duplicate orders when skipDuplicateCheck is true", async () => {
      const client = createMockClient();

      // First order
      await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        sizeUsd: 10,
      });

      // Second order with skipDuplicateCheck
      const result = await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        sizeUsd: 10,
        skipDuplicateCheck: true,
      });
      assert.strictEqual(result.success, true);
    });

    it("does not apply duplicate check to SELL orders", async () => {
      const client = createMockClient();

      // First SELL order
      const result1 = await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "SELL",
        sizeUsd: 10,
        skipDuplicateCheck: true,
      });
      assert.strictEqual(result1.success, true);

      // Second SELL order should also succeed (no duplicate check for SELL)
      const result2 = await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "SELL",
        sizeUsd: 10,
        skipDuplicateCheck: true,
      });
      assert.strictEqual(result2.success, true);
    });
  });

  describe("successful order execution", () => {
    beforeEach(() => {
      process.env.LIVE_TRADING = "I_UNDERSTAND_THE_RISKS";
    });

    it("executes BUY order successfully", async () => {
      const client = createMockClient({
        orderBook: {
          asks: [{ price: "0.50", size: "100" }],
          bids: [{ price: "0.48", size: "100" }],
        },
        postOrderSuccess: true,
      });

      const result = await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        sizeUsd: 10,
      });

      assert.strictEqual(result.success, true);
      assert.ok(result.filledUsd !== undefined && result.filledUsd > 0);
      assert.ok(result.avgPrice !== undefined && result.avgPrice > 0);
    });

    it("executes SELL order successfully", async () => {
      const client = createMockClient({
        orderBook: {
          asks: [{ price: "0.50", size: "100" }],
          bids: [{ price: "0.48", size: "100" }],
        },
        postOrderSuccess: true,
      });

      const result = await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "SELL",
        sizeUsd: 10,
        skipDuplicateCheck: true,
      });

      assert.strictEqual(result.success, true);
      assert.ok(result.filledUsd !== undefined && result.filledUsd > 0);
    });
  });

  describe("error handling", () => {
    beforeEach(() => {
      process.env.LIVE_TRADING = "I_UNDERSTAND_THE_RISKS";
    });

    it("handles market closed error", async () => {
      const client = createMockClient({
        getOrderBookError: new Error("No orderbook exists for token"),
      });

      const result = await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        sizeUsd: 10,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, "MARKET_CLOSED");
    });

    it("handles 404 error as market closed", async () => {
      const client = createMockClient({
        getOrderBookError: new Error("404 Not Found"),
      });

      const result = await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        sizeUsd: 10,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, "MARKET_CLOSED");
    });

    it("returns error message when order execution fails", async () => {
      const client = createMockClient({
        postOrderSuccess: false,
        postOrderErrorMsg: "Insufficient liquidity",
      });

      const result = await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        sizeUsd: 10,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, "Insufficient liquidity");
    });
  });

  describe("clearCooldowns", () => {
    beforeEach(() => {
      process.env.LIVE_TRADING = "I_UNDERSTAND_THE_RISKS";
    });

    it("allows orders after clearing cooldowns", async () => {
      const client = createMockClient();

      // First order
      await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        sizeUsd: 10,
      });

      // Should be blocked
      const blocked = await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        sizeUsd: 10,
      });
      assert.strictEqual(blocked.reason, "IN_FLIGHT");

      // Clear cooldowns
      clearCooldowns();

      // Should succeed now
      const result = await postOrder({
        client: client as any,
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        sizeUsd: 10,
      });
      assert.strictEqual(result.success, true);
    });
  });
});

describe("GtcOrderTracker", () => {
  describe("checkForCancellations - price drift", () => {
    it("cancels BUY order when price moves UP (away from limit)", () => {
      const tracker = new GtcOrderTracker({ maxPriceDriftPct: 3 });

      // Track a BUY order at 65¢
      tracker.track({
        orderId: "test-buy-order",
        tokenId: "test-token",
        side: "BUY",
        price: 0.65,
        sizeUsd: 25,
        shares: 38.46,
        reason: "test",
      });

      // Price moved UP to 70¢ (7.7% drift) - bad for BUY, should cancel
      const currentPrices = new Map([["test-token", 0.7]]);
      const toCancel = tracker.checkForCancellations(currentPrices);

      assert.strictEqual(toCancel.length, 1);
      assert.strictEqual(toCancel[0].orderId, "test-buy-order");
    });

    it("does NOT cancel BUY order when price moves DOWN (toward limit)", () => {
      const tracker = new GtcOrderTracker({ maxPriceDriftPct: 3 });

      // Track a BUY order at 65¢
      tracker.track({
        orderId: "test-buy-order",
        tokenId: "test-token",
        side: "BUY",
        price: 0.65,
        sizeUsd: 25,
        shares: 38.46,
        reason: "test",
      });

      // Price moved DOWN to 60¢ (7.7% drift) - good for BUY, should NOT cancel
      const currentPrices = new Map([["test-token", 0.6]]);
      const toCancel = tracker.checkForCancellations(currentPrices);

      assert.strictEqual(toCancel.length, 0);
    });

    it("cancels SELL order when price moves DOWN (away from limit)", () => {
      const tracker = new GtcOrderTracker({ maxPriceDriftPct: 3 });

      // Track a SELL order at 70¢
      tracker.track({
        orderId: "test-sell-order",
        tokenId: "test-token",
        side: "SELL",
        price: 0.7,
        sizeUsd: 25,
        shares: 35.71,
        reason: "test",
      });

      // Price moved DOWN to 65¢ (7.1% drift) - bad for SELL, should cancel
      const currentPrices = new Map([["test-token", 0.65]]);
      const toCancel = tracker.checkForCancellations(currentPrices);

      assert.strictEqual(toCancel.length, 1);
      assert.strictEqual(toCancel[0].orderId, "test-sell-order");
    });

    it("does NOT cancel SELL order when price moves UP (toward limit)", () => {
      const tracker = new GtcOrderTracker({ maxPriceDriftPct: 3 });

      // Track a SELL order at 70¢
      tracker.track({
        orderId: "test-sell-order",
        tokenId: "test-token",
        side: "SELL",
        price: 0.7,
        sizeUsd: 25,
        shares: 35.71,
        reason: "test",
      });

      // Price moved UP to 75¢ (7.1% drift) - good for SELL, should NOT cancel
      const currentPrices = new Map([["test-token", 0.75]]);
      const toCancel = tracker.checkForCancellations(currentPrices);

      assert.strictEqual(toCancel.length, 0);
    });

    it("does NOT cancel orders within drift threshold", () => {
      const tracker = new GtcOrderTracker({ maxPriceDriftPct: 5 });

      // Track a BUY order at 65¢
      tracker.track({
        orderId: "test-buy-order",
        tokenId: "test-token",
        side: "BUY",
        price: 0.65,
        sizeUsd: 25,
        shares: 38.46,
        reason: "test",
      });

      // Price moved UP to 67¢ (3% drift) - below threshold
      const currentPrices = new Map([["test-token", 0.67]]);
      const toCancel = tracker.checkForCancellations(currentPrices);

      assert.strictEqual(toCancel.length, 0);
    });
  });

  describe("checkForCancellations - time expiry", () => {
    it("cancels expired orders", () => {
      const tracker = new GtcOrderTracker({ defaultExpiryMs: 1000 });

      // Track an order that expires immediately
      tracker.track({
        orderId: "test-expired-order",
        tokenId: "test-token",
        side: "BUY",
        price: 0.65,
        sizeUsd: 25,
        shares: 38.46,
        reason: "test",
        expiresAt: Date.now() - 1000, // Already expired
      });

      const currentPrices = new Map<string, number>();
      const toCancel = tracker.checkForCancellations(currentPrices);

      assert.strictEqual(toCancel.length, 1);
      assert.strictEqual(toCancel[0].orderId, "test-expired-order");
    });
  });
});
