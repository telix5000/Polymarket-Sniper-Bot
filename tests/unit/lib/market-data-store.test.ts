/**
 * Market Data Store Tests
 *
 * Tests for:
 * - Staleness detection and fallback
 * - Deduplication of updates
 * - LRU eviction
 * - Metrics and observability
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";

import {
  MarketDataStore,
  initMarketDataStore,
  getMarketDataStore,
  type OrderbookLevel,
} from "../../../src/lib/market-data-store";

// ============================================================================
// Test Helpers
// ============================================================================

function createTestLevels(): {
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
} {
  return {
    bids: [
      { price: 0.55, size: 100 },
      { price: 0.54, size: 200 },
      { price: 0.53, size: 300 },
    ],
    asks: [
      { price: 0.56, size: 100 },
      { price: 0.57, size: 200 },
      { price: 0.58, size: 300 },
    ],
  };
}

// ============================================================================
// MarketDataStore Tests
// ============================================================================

describe("MarketDataStore", () => {
  let store: MarketDataStore;

  beforeEach(() => {
    store = new MarketDataStore({
      maxTokens: 10,
      staleMs: 1000,
      depthWindowCents: 5,
    });
  });

  describe("Basic operations", () => {
    it("should store and retrieve market data", () => {
      const tokenId = "test-token-1";
      const { bids, asks } = createTestLevels();

      const updated = store.updateFromWs(tokenId, bids, asks);
      assert.strictEqual(updated, true);

      const data = store.get(tokenId);
      assert.notStrictEqual(data, null);
      assert.strictEqual(data?.tokenId, tokenId);
      assert.strictEqual(data?.bestBid, 0.55);
      assert.strictEqual(data?.bestAsk, 0.56);
      assert.strictEqual(data?.source, "WS");
    });

    it("should calculate mid price and spread correctly", () => {
      const tokenId = "test-token-2";
      const { bids, asks } = createTestLevels();

      store.updateFromWs(tokenId, bids, asks);
      const data = store.get(tokenId);

      assert.strictEqual(data?.mid, 0.555);
      // Use approximate comparison for floating point
      assert.ok(
        Math.abs(data!.spreadCents - 1) < 0.0001,
        `Spread should be ~1 cent, got ${data!.spreadCents}`,
      );
    });

    it("should return null for unknown token", () => {
      const data = store.get("unknown-token");
      assert.strictEqual(data, null);
    });
  });

  describe("Staleness detection", () => {
    it("should detect fresh data as not stale", () => {
      const tokenId = "test-token-stale";
      const { bids, asks } = createTestLevels();

      store.updateFromWs(tokenId, bids, asks);

      assert.strictEqual(store.isStale(tokenId), false);
    });

    it("should detect old data as stale", async () => {
      const store = new MarketDataStore({
        maxTokens: 10,
        staleMs: 50, // Very short for testing
        depthWindowCents: 5,
      });

      const tokenId = "test-token-stale";
      const { bids, asks } = createTestLevels();

      store.updateFromWs(tokenId, bids, asks);
      assert.strictEqual(store.isStale(tokenId), false);

      // Wait for data to become stale
      await new Promise((resolve) => setTimeout(resolve, 60));

      assert.strictEqual(store.isStale(tokenId), true);
    });

    it("should return true for unknown token staleness", () => {
      assert.strictEqual(store.isStale("unknown"), true);
    });
  });

  describe("Deduplication", () => {
    it("should not report update when data unchanged", () => {
      const tokenId = "test-token-dedup";
      const { bids, asks } = createTestLevels();

      // First update
      const first = store.updateFromWs(tokenId, bids, asks);
      assert.strictEqual(first, true);

      // Second update with same data
      const second = store.updateFromWs(tokenId, bids, asks);
      assert.strictEqual(second, false);
    });

    it("should report update when data changes", () => {
      const tokenId = "test-token-dedup-change";
      const { bids, asks } = createTestLevels();

      store.updateFromWs(tokenId, bids, asks);

      // Change best bid
      const newBids = [{ price: 0.54, size: 100 }, ...bids.slice(1)];
      const updated = store.updateFromWs(tokenId, newBids, asks);
      assert.strictEqual(updated, true);
    });
  });

  describe("REST fallback", () => {
    it("should update from REST and track source", () => {
      const tokenId = "test-token-rest";
      const { bids, asks } = createTestLevels();

      store.updateFromRest(tokenId, bids, asks);
      const data = store.get(tokenId);

      assert.strictEqual(data?.source, "REST");
    });

    it("should track REST fallback count", () => {
      const tokenId = "test-token-rest-count";
      const { bids, asks } = createTestLevels();

      store.updateFromRest(tokenId, bids, asks);
      store.updateFromRest("test-token-rest-2", bids, asks);

      const metrics = store.getMetrics();
      assert.strictEqual(metrics.restFallbacks, 2);
    });
  });

  describe("LRU eviction", () => {
    it("should evict oldest tokens when at capacity", () => {
      const store = new MarketDataStore({
        maxTokens: 3,
        staleMs: 10000,
        depthWindowCents: 5,
      });

      const { bids, asks } = createTestLevels();

      // Add 3 tokens
      store.updateFromWs("token-1", bids, asks);
      store.updateFromWs("token-2", bids, asks);
      store.updateFromWs("token-3", bids, asks);

      // All should exist
      assert.strictEqual(store.has("token-1"), true);
      assert.strictEqual(store.has("token-2"), true);
      assert.strictEqual(store.has("token-3"), true);

      // Add a 4th token - should evict token-1 (oldest)
      store.updateFromWs("token-4", bids, asks);

      assert.strictEqual(store.has("token-1"), false);
      assert.strictEqual(store.has("token-4"), true);
    });

    it("should update LRU order on access", () => {
      const store = new MarketDataStore({
        maxTokens: 3,
        staleMs: 10000,
        depthWindowCents: 5,
      });

      const { bids, asks } = createTestLevels();

      store.updateFromWs("token-1", bids, asks);
      store.updateFromWs("token-2", bids, asks);
      store.updateFromWs("token-3", bids, asks);

      // Access token-1 to make it most recently used
      store.get("token-1");

      // Add token-4 - should evict token-2 (now oldest)
      store.updateFromWs("token-4", bids, asks);

      assert.strictEqual(store.has("token-1"), true); // Accessed recently
      assert.strictEqual(store.has("token-2"), false); // Evicted
    });
  });

  describe("Metrics and mode", () => {
    it("should track WS updates count", () => {
      const { bids, asks } = createTestLevels();

      store.updateFromWs("token-1", bids, asks);
      store.updateFromWs("token-2", bids, asks);

      const metrics = store.getMetrics();
      assert.strictEqual(metrics.wsUpdates, 2);
    });

    it("should report correct mode based on state", () => {
      const { bids, asks } = createTestLevels();

      // Initially REST_ONLY (no WS connection)
      assert.strictEqual(store.getMode(), "REST_ONLY");

      // Connect WS
      store.setWsConnected(true);
      assert.strictEqual(store.getMode(), "WS_OK");

      // Add some data
      store.updateFromWs("token-1", bids, asks);
      assert.strictEqual(store.getMode(), "WS_OK");
    });

    it("should count stale tokens correctly", async () => {
      const store = new MarketDataStore({
        maxTokens: 10,
        staleMs: 50,
        depthWindowCents: 5,
      });

      const { bids, asks } = createTestLevels();

      store.updateFromWs("token-1", bids, asks);
      store.updateFromWs("token-2", bids, asks);

      assert.strictEqual(store.getStaleCount(), 0);

      // Wait for staleness
      await new Promise((resolve) => setTimeout(resolve, 60));

      assert.strictEqual(store.getStaleCount(), 2);
    });
  });

  describe("Singleton management", () => {
    it("should return same instance from getMarketDataStore", () => {
      const store1 = getMarketDataStore();
      const store2 = getMarketDataStore();
      assert.strictEqual(store1, store2);
    });

    it("should create new instance with initMarketDataStore", () => {
      const store1 = getMarketDataStore();
      const store2 = initMarketDataStore({ maxTokens: 100 });
      assert.notStrictEqual(store1, store2);

      // New get should return the new instance
      const store3 = getMarketDataStore();
      assert.strictEqual(store2, store3);
    });
  });
});
