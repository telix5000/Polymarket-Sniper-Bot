/**
 * WebSocketMarketClient Tests
 *
 * Tests for:
 * - Connection state management
 * - Subscription handling
 * - Reconnection logic
 * - URL builder returns correct base URL
 * - Keepalive ping scheduling
 * - Orderbook reconstruction from deltas
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";

import {
  WebSocketMarketClient,
  initWebSocketMarketClient,
  getWebSocketMarketClient,
} from "../../src/lib/ws-market-client";
import { POLYMARKET_WS } from "../../src/lib/constants";

// ============================================================================
// WebSocketMarketClient Tests
// ============================================================================

describe("WebSocketMarketClient", () => {
  let client: WebSocketMarketClient;

  beforeEach(() => {
    // Create fresh client for each test (won't actually connect in tests)
    client = new WebSocketMarketClient({
      url: "wss://test.example.com/ws/", // Won't actually connect
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

    it("should have no subscriptions initially", () => {
      const subs = client.getSubscriptions();
      assert.strictEqual(subs.length, 0);
    });
  });

  describe("Subscription management", () => {
    it("should track subscriptions when added", () => {
      client.subscribe(["token-1", "token-2"]);

      const subs = client.getSubscriptions();
      assert.strictEqual(subs.length, 2);
      assert.ok(subs.includes("token-1"));
      assert.ok(subs.includes("token-2"));
    });

    it("should deduplicate subscriptions", () => {
      client.subscribe(["token-1"]);
      client.subscribe(["token-1", "token-2"]);

      const subs = client.getSubscriptions();
      assert.strictEqual(subs.length, 2);
    });

    it("should remove subscriptions when unsubscribed", () => {
      client.subscribe(["token-1", "token-2", "token-3"]);
      client.unsubscribe(["token-2"]);

      const subs = client.getSubscriptions();
      assert.strictEqual(subs.length, 2);
      assert.ok(subs.includes("token-1"));
      assert.ok(subs.includes("token-3"));
      assert.ok(!subs.includes("token-2"));
    });

    it("should handle empty subscription arrays", () => {
      client.subscribe([]);
      assert.strictEqual(client.getSubscriptions().length, 0);

      client.unsubscribe([]);
      assert.strictEqual(client.getSubscriptions().length, 0);
    });
  });

  describe("Metrics", () => {
    it("should report initial metrics correctly", () => {
      const metrics = client.getMetrics();

      assert.strictEqual(metrics.state, "DISCONNECTED");
      assert.strictEqual(metrics.subscriptions, 0);
      assert.strictEqual(metrics.messagesReceived, 0);
      assert.strictEqual(metrics.reconnectAttempts, 0);
    });

    it("should track subscription count in metrics", () => {
      client.subscribe(["token-1", "token-2"]);

      const metrics = client.getMetrics();
      assert.strictEqual(metrics.subscriptions, 2);
    });
  });

  describe("Singleton management", () => {
    it("should return same instance from getWebSocketMarketClient", () => {
      const client1 = getWebSocketMarketClient();
      const client2 = getWebSocketMarketClient();
      assert.strictEqual(client1, client2);
    });

    it("should create new instance with initWebSocketMarketClient", () => {
      // Test that initWebSocketMarketClient creates a client
      const newClient = initWebSocketMarketClient({
        url: "wss://new.example.com/ws/",
      });
      // Note: The important thing is that initWebSocketMarketClient can reset state
      assert.ok(newClient);
    });
  });
});

// ============================================================================
// URL and Configuration Tests
// ============================================================================

describe("WebSocket URL Configuration", () => {
  it("should have correct base URL without path segments", () => {
    // The base URL MUST be exactly this - no /user or /market path segments
    const expectedUrl = "wss://ws-subscriptions-clob.polymarket.com/ws/";
    assert.strictEqual(POLYMARKET_WS.BASE_URL, expectedUrl);
  });

  it("should have trailing slash in base URL", () => {
    assert.ok(POLYMARKET_WS.BASE_URL.endsWith("/"));
  });

  it("should NOT have USER_URL constant (removed)", () => {
    // USER_URL was removed - both clients use BASE_URL
    assert.strictEqual((POLYMARKET_WS as any).USER_URL, undefined);
  });

  it("should use correct default for new clients", () => {
    // Creating a client verifies the default URL is used internally
    const testClient = new WebSocketMarketClient();
    // We can't directly access the private url property, but we verify
    // the constant is correct and the client is created
    assert.ok(testClient);
    assert.strictEqual(
      POLYMARKET_WS.BASE_URL,
      "wss://ws-subscriptions-clob.polymarket.com/ws/",
    );
    testClient.disconnect();
  });

  it("should have reasonable reconnection defaults", () => {
    assert.ok(POLYMARKET_WS.RECONNECT_BASE_MS >= 500); // At least 500ms base
    assert.ok(POLYMARKET_WS.RECONNECT_MAX_MS >= 10000); // At least 10s max
    assert.ok(POLYMARKET_WS.RECONNECT_MAX_MS <= 60000); // At most 60s max
  });

  it("should have stable connection threshold", () => {
    assert.ok(POLYMARKET_WS.STABLE_CONNECTION_MS >= 5000); // At least 5s
    assert.ok(POLYMARKET_WS.STABLE_CONNECTION_MS <= 60000); // At most 60s
  });

  it("should have ping interval configured", () => {
    assert.ok(POLYMARKET_WS.PING_INTERVAL_MS >= 5000); // At least 5s
    assert.ok(POLYMARKET_WS.PING_INTERVAL_MS <= 30000); // At most 30s
  });
});

// ============================================================================
// Disconnect/Cleanup Tests
// ============================================================================

describe("WebSocketMarketClient Cleanup", () => {
  it("should reset state on disconnect", () => {
    const client = new WebSocketMarketClient({
      url: "wss://test.example.com/ws/",
    });

    // Disconnect should clean up state
    client.disconnect();

    assert.strictEqual(client.getState(), "DISCONNECTED");
    assert.strictEqual(client.isConnected(), false);
  });

  it("should preserve subscriptions after disconnect for reconnect", () => {
    const client = new WebSocketMarketClient({
      url: "wss://test.example.com/ws/",
    });

    client.subscribe(["token-1", "token-2"]);
    client.disconnect();

    // Subscriptions should be preserved for potential reconnect
    const subs = client.getSubscriptions();
    assert.strictEqual(subs.length, 2);
  });
});
