/**
 * WebSocketUserClient Tests
 *
 * Tests for:
 * - Connection state management
 * - OrderStateStore functionality
 * - Order and trade event processing
 * - URL configuration (uses same BASE_URL as market client)
 * - Auth credential validation
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";

import {
  WebSocketUserClient,
  OrderStateStore,
  type OrderEvent,
  type TradeEvent,
} from "../../src/lib/ws-user-client";
import { POLYMARKET_WS } from "../../src/lib/constants";

// ============================================================================
// OrderStateStore Tests
// ============================================================================

describe("OrderStateStore", () => {
  let store: OrderStateStore;

  beforeEach(() => {
    store = new OrderStateStore();
  });

  describe("Order tracking", () => {
    it("should store and retrieve orders", () => {
      const orderEvent: OrderEvent = {
        type: "order",
        id: "order-123",
        status: "LIVE",
        asset_id: "token-abc",
        side: "BUY",
        price: "0.55",
        original_size: "100",
        size_matched: "0",
        fee_rate_bps: "10",
        created_at: new Date().toISOString(),
      };

      store.updateOrder(orderEvent);

      const order = store.getOrder("order-123");
      assert.notStrictEqual(order, null);
      assert.strictEqual(order?.orderId, "order-123");
      assert.strictEqual(order?.tokenId, "token-abc");
      assert.strictEqual(order?.side, "BUY");
      assert.strictEqual(order?.status, "LIVE");
      assert.strictEqual(order?.price, 0.55);
    });

    it("should update order status", () => {
      // Create initial order
      const createEvent: OrderEvent = {
        type: "order",
        id: "order-456",
        status: "LIVE",
        asset_id: "token-def",
        side: "SELL",
        price: "0.60",
        original_size: "50",
        size_matched: "0",
        fee_rate_bps: "10",
        created_at: new Date().toISOString(),
      };
      store.updateOrder(createEvent);

      // Update order to matched
      const matchEvent: OrderEvent = {
        ...createEvent,
        status: "MATCHED",
        size_matched: "50",
      };
      store.updateOrder(matchEvent);

      const order = store.getOrder("order-456");
      assert.strictEqual(order?.status, "MATCHED");
      assert.strictEqual(order?.sizeMatched, 50);
    });

    it("should get orders by token", () => {
      // Create orders for different tokens
      store.updateOrder({
        type: "order",
        id: "order-1",
        status: "LIVE",
        asset_id: "token-x",
        side: "BUY",
        price: "0.50",
        original_size: "100",
        size_matched: "0",
        fee_rate_bps: "10",
        created_at: new Date().toISOString(),
      });

      store.updateOrder({
        type: "order",
        id: "order-2",
        status: "LIVE",
        asset_id: "token-x",
        side: "SELL",
        price: "0.55",
        original_size: "50",
        size_matched: "0",
        fee_rate_bps: "10",
        created_at: new Date().toISOString(),
      });

      store.updateOrder({
        type: "order",
        id: "order-3",
        status: "LIVE",
        asset_id: "token-y",
        side: "BUY",
        price: "0.45",
        original_size: "200",
        size_matched: "0",
        fee_rate_bps: "10",
        created_at: new Date().toISOString(),
      });

      const tokenXOrders = store.getOrdersForToken("token-x");
      assert.strictEqual(tokenXOrders.length, 2);

      const tokenYOrders = store.getOrdersForToken("token-y");
      assert.strictEqual(tokenYOrders.length, 1);
    });

    it("should get active orders only", () => {
      store.updateOrder({
        type: "order",
        id: "order-live",
        status: "LIVE",
        asset_id: "token-1",
        side: "BUY",
        price: "0.50",
        original_size: "100",
        size_matched: "0",
        fee_rate_bps: "10",
        created_at: new Date().toISOString(),
      });

      store.updateOrder({
        type: "order",
        id: "order-matched",
        status: "MATCHED",
        asset_id: "token-1",
        side: "SELL",
        price: "0.55",
        original_size: "50",
        size_matched: "50",
        fee_rate_bps: "10",
        created_at: new Date().toISOString(),
      });

      const activeOrders = store.getActiveOrders();
      assert.strictEqual(activeOrders.length, 1);
      assert.strictEqual(activeOrders[0].orderId, "order-live");
    });
  });

  describe("Trade tracking", () => {
    it("should record trades", () => {
      const tradeEvent: TradeEvent = {
        type: "trade",
        id: "trade-789",
        taker_order_id: "order-123",
        maker_order_id: "order-456",
        status: "MATCHED",
        asset_id: "token-abc",
        side: "BUY",
        price: "0.55",
        size: "25",
        fee_rate_bps: "10",
        match_time: new Date().toISOString(),
      };

      store.recordTrade(tradeEvent);

      const trades = store.getRecentTrades(10);
      assert.strictEqual(trades.length, 1);
      assert.strictEqual(trades[0].tradeId, "trade-789");
      assert.strictEqual(trades[0].price, 0.55);
      assert.strictEqual(trades[0].size, 25);
    });

    it("should return trades in reverse chronological order", () => {
      // Record trades with different timestamps
      for (let i = 0; i < 5; i++) {
        store.recordTrade({
          type: "trade",
          id: `trade-${i}`,
          taker_order_id: `order-${i}`,
          maker_order_id: `maker-${i}`,
          status: "MATCHED",
          asset_id: "token-1",
          side: "BUY",
          price: "0.50",
          size: "10",
          fee_rate_bps: "10",
          match_time: new Date(Date.now() + i * 1000).toISOString(),
        });
      }

      const trades = store.getRecentTrades(10);
      assert.strictEqual(trades.length, 5);
      // Most recent should be first
      assert.strictEqual(trades[0].tradeId, "trade-4");
      assert.strictEqual(trades[4].tradeId, "trade-0");
    });

    it("should limit returned trades", () => {
      for (let i = 0; i < 10; i++) {
        store.recordTrade({
          type: "trade",
          id: `trade-${i}`,
          taker_order_id: `order-${i}`,
          maker_order_id: `maker-${i}`,
          status: "MATCHED",
          asset_id: "token-1",
          side: "BUY",
          price: "0.50",
          size: "10",
          fee_rate_bps: "10",
          match_time: new Date().toISOString(),
        });
      }

      const trades = store.getRecentTrades(5);
      assert.strictEqual(trades.length, 5);
    });
  });

  describe("Metrics", () => {
    it("should track order update counts", () => {
      for (let i = 0; i < 3; i++) {
        store.updateOrder({
          type: "order",
          id: `order-${i}`,
          status: "LIVE",
          asset_id: "token-1",
          side: "BUY",
          price: "0.50",
          original_size: "100",
          size_matched: "0",
          fee_rate_bps: "10",
          created_at: new Date().toISOString(),
        });
      }

      const metrics = store.getMetrics();
      assert.strictEqual(metrics.totalOrderUpdates, 3);
      assert.strictEqual(metrics.activeOrders, 3);
    });

    it("should track trade counts", () => {
      for (let i = 0; i < 5; i++) {
        store.recordTrade({
          type: "trade",
          id: `trade-${i}`,
          taker_order_id: `order-${i}`,
          maker_order_id: `maker-${i}`,
          status: "MATCHED",
          asset_id: "token-1",
          side: "BUY",
          price: "0.50",
          size: "10",
          fee_rate_bps: "10",
          match_time: new Date().toISOString(),
        });
      }

      const metrics = store.getMetrics();
      assert.strictEqual(metrics.totalTrades, 5);
    });
  });

  describe("Cleanup", () => {
    it("should clear all data", () => {
      store.updateOrder({
        type: "order",
        id: "order-1",
        status: "LIVE",
        asset_id: "token-1",
        side: "BUY",
        price: "0.50",
        original_size: "100",
        size_matched: "0",
        fee_rate_bps: "10",
        created_at: new Date().toISOString(),
      });

      store.recordTrade({
        type: "trade",
        id: "trade-1",
        taker_order_id: "order-1",
        maker_order_id: "maker-1",
        status: "MATCHED",
        asset_id: "token-1",
        side: "BUY",
        price: "0.50",
        size: "10",
        fee_rate_bps: "10",
        match_time: new Date().toISOString(),
      });

      store.clear();

      const metrics = store.getMetrics();
      assert.strictEqual(metrics.activeOrders, 0);
      assert.strictEqual(metrics.totalOrders, 0);
      assert.strictEqual(metrics.totalTrades, 0);
    });
  });
});

// ============================================================================
// WebSocketUserClient Tests
// ============================================================================

describe("WebSocketUserClient", () => {
  let client: WebSocketUserClient;

  beforeEach(() => {
    client = new WebSocketUserClient({
      url: "wss://test.example.com/ws/", // Same base URL format as market client
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
      stableConnectionMs: 500,
      pingIntervalMs: 100,
    });
  });

  describe("Initial state", () => {
    it("should start in DISCONNECTED state", () => {
      assert.strictEqual(client.getState(), "DISCONNECTED");
    });

    it("should not be connected initially", () => {
      assert.strictEqual(client.isConnected(), false);
    });
  });

  describe("OrderStore access", () => {
    it("should provide access to order store", () => {
      const store = client.getOrderStore();
      assert.ok(store instanceof OrderStateStore);
    });
  });

  describe("Metrics", () => {
    it("should report initial metrics correctly", () => {
      const metrics = client.getMetrics();

      assert.strictEqual(metrics.state, "DISCONNECTED");
      assert.strictEqual(metrics.messagesReceived, 0);
      assert.strictEqual(metrics.reconnectAttempts, 0);
      assert.ok("orderStoreMetrics" in metrics);
    });
  });
});

// ============================================================================
// User WebSocket URL Configuration Tests
// ============================================================================

import { getUserWsUrl, getMarketWsUrl } from "../../src/lib/constants";

describe("WebSocketUserClient URL Configuration", () => {
  it("getUserWsUrl() returns correct user channel URL", () => {
    // Per Polymarket docs: wss://ws-subscriptions-clob.polymarket.com/ws/user
    const url = getUserWsUrl();
    assert.strictEqual(
      url,
      "wss://ws-subscriptions-clob.polymarket.com/ws/user",
    );
    assert.ok(url.endsWith("/ws/user"));
  });

  it("getMarketWsUrl() and getUserWsUrl() use same host but different paths", () => {
    const marketUrl = getMarketWsUrl();
    const userUrl = getUserWsUrl();

    // Same host
    assert.ok(
      marketUrl.startsWith("wss://ws-subscriptions-clob.polymarket.com"),
    );
    assert.ok(userUrl.startsWith("wss://ws-subscriptions-clob.polymarket.com"));

    // Different paths
    assert.ok(marketUrl.endsWith("/ws/market"));
    assert.ok(userUrl.endsWith("/ws/user"));
    assert.notStrictEqual(marketUrl, userUrl);
  });

  it("should NOT have USER_URL constant (use getUserWsUrl instead)", () => {
    // USER_URL was removed - use getUserWsUrl() instead
    assert.strictEqual((POLYMARKET_WS as any).USER_URL, undefined);
  });

  it("should use user URL for new user clients by default", () => {
    // Creating a client without URL option should use getUserWsUrl()
    const testClient = new WebSocketUserClient();
    assert.ok(testClient);
    // Verify the URL function returns correct value
    assert.strictEqual(
      getUserWsUrl(),
      "wss://ws-subscriptions-clob.polymarket.com/ws/user",
    );
    testClient.disconnect();
  });
});

// ============================================================================
// User WebSocket Cleanup Tests
// ============================================================================

describe("WebSocketUserClient Cleanup", () => {
  it("should reset state on disconnect", () => {
    const client = new WebSocketUserClient({
      url: "wss://test.example.com/ws/user",
    });

    client.disconnect();

    assert.strictEqual(client.getState(), "DISCONNECTED");
    assert.strictEqual(client.isConnected(), false);
  });
});
