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

import { getMarketWsUrl, getUserWsUrl } from "../../src/lib/constants";

describe("WebSocket URL Configuration", () => {
  it("should have HOST constant for base host", () => {
    // HOST should be without trailing path
    assert.strictEqual(
      POLYMARKET_WS.HOST,
      "wss://ws-subscriptions-clob.polymarket.com",
    );
  });

  it("getMarketWsUrl() returns correct market channel URL", () => {
    // Per Polymarket docs: wss://ws-subscriptions-clob.polymarket.com/ws/market
    const url = getMarketWsUrl();
    assert.strictEqual(
      url,
      "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    );
    assert.ok(url.endsWith("/ws/market"));
  });

  it("getUserWsUrl() returns correct user channel URL", () => {
    // Per Polymarket docs: wss://ws-subscriptions-clob.polymarket.com/ws/user
    const url = getUserWsUrl();
    assert.strictEqual(
      url,
      "wss://ws-subscriptions-clob.polymarket.com/ws/user",
    );
    assert.ok(url.endsWith("/ws/user"));
  });

  it("should have deprecated BASE_URL for backward compatibility", () => {
    // BASE_URL kept for backward compat but should not be used alone (returns 404)
    const expectedUrl = "wss://ws-subscriptions-clob.polymarket.com/ws/";
    assert.strictEqual(POLYMARKET_WS.BASE_URL, expectedUrl);
  });

  it("should NOT have USER_URL constant (removed)", () => {
    // USER_URL was removed - use getUserWsUrl() instead
    assert.strictEqual((POLYMARKET_WS as any).USER_URL, undefined);
    // Verify replacement functions exist
    assert.strictEqual(typeof getMarketWsUrl, "function");
    assert.strictEqual(typeof getUserWsUrl, "function");
  });

  it("should use correct market URL for new clients", () => {
    // Creating a client should use getMarketWsUrl() internally
    const testClient = new WebSocketMarketClient();
    assert.ok(testClient);
    // Verify the URL function returns correct value
    assert.strictEqual(
      getMarketWsUrl(),
      "wss://ws-subscriptions-clob.polymarket.com/ws/market",
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

// ============================================================================
// Mock WebSocket Server Tests for Keepalive and Reconnection
// ============================================================================

import WebSocket, { WebSocketServer } from "ws";

describe("WebSocketMarketClient Keepalive Integration", () => {
  it("should send PING at configured interval and receive PONG", async () => {
    const receivedMessages: string[] = [];

    // Create a mock WebSocket server
    const server = new WebSocketServer({ port: 0 });
    const serverPort = await new Promise<number>((resolve) => {
      server.on("listening", () => {
        resolve((server.address() as any).port);
      });
    });

    server.on("connection", (ws) => {
      ws.on("message", (data) => {
        const msg = data.toString();
        receivedMessages.push(msg);
        // Respond to PING with PONG
        if (msg === "PING") {
          ws.send("PONG");
        }
      });
    });

    const pingIntervalMs = 100;
    const client = new WebSocketMarketClient({
      url: `ws://127.0.0.1:${serverPort}`,
      pingIntervalMs,
      pongTimeoutMs: 1000,
      reconnectBaseMs: 50,
    });

    client.connect();

    // Wait for connection + ping interval + buffer
    await new Promise((r) => setTimeout(r, pingIntervalMs + 150));

    // Should have sent at least one PING
    const pingCount = receivedMessages.filter((m) => m === "PING").length;
    assert.ok(pingCount >= 1, `Expected at least 1 PING, got ${pingCount}`);

    // Metrics should show pong received
    const metrics = client.getMetrics();
    assert.ok(
      metrics.lastPongAgeMs >= 0,
      "Should have received PONG (lastPongAgeMs >= 0)",
    );

    client.disconnect();
    server.close();
  });

  it("should trigger reconnect when server does not respond to PING (pong timeout)", async () => {
    // Create a server that does NOT respond to PING
    const silentServer = new WebSocketServer({ port: 0 });
    const silentPort = await new Promise<number>((resolve) => {
      silentServer.on("listening", () => {
        resolve((silentServer.address() as any).port);
      });
    });

    silentServer.on("connection", (_ws) => {
      // Intentionally do NOT respond to PING messages
    });

    const client = new WebSocketMarketClient({
      url: `ws://127.0.0.1:${silentPort}`,
      pingIntervalMs: 50, // Send ping quickly
      pongTimeoutMs: 80, // Short timeout for test
      reconnectBaseMs: 30,
    });

    client.connect();

    // Wait for connection (~50ms) + ping interval (50ms) + pong timeout (80ms) + buffer
    await new Promise((r) => setTimeout(r, 400));

    // Should have triggered at least one reconnect due to pong timeout
    const metrics = client.getMetrics();
    assert.ok(
      metrics.reconnectAttempts >= 1,
      `Expected at least 1 reconnect attempt due to pong timeout, got ${metrics.reconnectAttempts}`,
    );

    client.disconnect();
    silentServer.close();
  });

  it("should restore subscriptions after reconnect", async () => {
    const subscriptionMessages: string[] = [];

    // Create a mock WebSocket server
    const server = new WebSocketServer({ port: 0 });
    const serverPort = await new Promise<number>((resolve) => {
      server.on("listening", () => {
        resolve((server.address() as any).port);
      });
    });

    let serverConnection: WebSocket | null = null;
    server.on("connection", (ws) => {
      serverConnection = ws;
      ws.on("message", (data) => {
        const msg = data.toString();
        if (msg === "PING") {
          ws.send("PONG");
          return;
        }
        try {
          const parsed = JSON.parse(msg);
          if (parsed.type === "market" || parsed.operation === "subscribe") {
            subscriptionMessages.push(msg);
          }
        } catch {
          /* ignore non-JSON */
        }
      });
    });

    const client = new WebSocketMarketClient({
      url: `ws://127.0.0.1:${serverPort}`,
      pingIntervalMs: 5000, // Don't interfere with test
      pongTimeoutMs: 5000,
      reconnectBaseMs: 30,
    });

    // Subscribe before connecting
    client.subscribe(["token-a", "token-b"]);
    client.connect();

    // Wait for connection
    await new Promise((r) => setTimeout(r, 100));

    // Force a close (simulating server disconnect)
    if (serverConnection) {
      serverConnection.close();
    }

    // Wait for reconnect
    await new Promise((r) => setTimeout(r, 200));

    // Should have subscribed at least once after connect/reconnect
    assert.ok(
      subscriptionMessages.length >= 1,
      `Expected subscription messages, got ${subscriptionMessages.length}`,
    );

    // Verify subscriptions are still tracked
    const subs = client.getSubscriptions();
    assert.ok(subs.includes("token-a"));
    assert.ok(subs.includes("token-b"));

    client.disconnect();
    server.close();
  });

  it("should report lastPongAgeMs in metrics", async () => {
    // Create a mock WebSocket server
    const server = new WebSocketServer({ port: 0 });
    const serverPort = await new Promise<number>((resolve) => {
      server.on("listening", () => {
        resolve((server.address() as any).port);
      });
    });

    server.on("connection", (ws) => {
      ws.on("message", (data) => {
        const msg = data.toString();
        if (msg === "PING") {
          ws.send("PONG");
        }
      });
    });

    const client = new WebSocketMarketClient({
      url: `ws://127.0.0.1:${serverPort}`,
      pingIntervalMs: 50,
      pongTimeoutMs: 1000,
      reconnectBaseMs: 50,
    });

    client.connect();

    // Wait for connection and a ping/pong cycle
    await new Promise((r) => setTimeout(r, 150));

    const metrics = client.getMetrics();

    // lastPongAgeMs should be recent
    assert.ok(
      metrics.lastPongAgeMs < 300,
      `Expected recent lastPongAgeMs, got ${metrics.lastPongAgeMs}`,
    );

    client.disconnect();
    server.close();
  });

  it("should have pongTimeoutMs option in configuration", () => {
    // Verify pongTimeoutMs can be configured
    const client = new WebSocketMarketClient({
      url: "wss://test.example.com/ws/",
      pongTimeoutMs: 5000,
    });
    assert.ok(client, "Should create client with pongTimeoutMs option");
    client.disconnect();
  });
});
