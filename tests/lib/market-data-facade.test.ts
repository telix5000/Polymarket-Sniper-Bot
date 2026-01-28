/**
 * MarketDataFacade Tests
 * 
 * Tests for:
 * - Rate limiting behavior
 * - REST fallback mechanism
 * - WS cache hits
 * - Error handling and recovery
 */

import assert from "node:assert";
import { describe, it, beforeEach, mock } from "node:test";

import {
  MarketDataFacade,
  initMarketDataFacade,
  getMarketDataFacade,
  isMarketDataFacadeInitialized,
} from "../../src/lib/market-data-facade";

import {
  MarketDataStore,
  initMarketDataStore,
  getMarketDataStore,
} from "../../src/lib/market-data-store";

// ============================================================================
// Mock ClobClient
// ============================================================================

function createMockClobClient(orderbooks: Map<string, { bids: any[]; asks: any[] }>) {
  return {
    getOrderBook: async (tokenId: string) => {
      const book = orderbooks.get(tokenId);
      if (!book) {
        throw new Error("No orderbook exists for this token");
      }
      return book;
    },
  } as any;
}

function createTestOrderbook() {
  return {
    bids: [
      { price: "0.55", size: "100" },
      { price: "0.54", size: "200" },
    ],
    asks: [
      { price: "0.56", size: "100" },
      { price: "0.57", size: "200" },
    ],
  };
}

// ============================================================================
// MarketDataFacade Tests
// ============================================================================

describe("MarketDataFacade", () => {
  let facade: MarketDataFacade;
  let store: MarketDataStore;
  let orderbooks: Map<string, { bids: any[]; asks: any[] }>;

  beforeEach(() => {
    // Reset store
    store = initMarketDataStore({
      maxTokens: 10,
      staleMs: 100, // Short for testing
      depthWindowCents: 5,
    });
    
    // Setup mock orderbooks
    orderbooks = new Map();
    orderbooks.set("token-1", createTestOrderbook());
    orderbooks.set("token-2", createTestOrderbook());
    
    const client = createMockClobClient(orderbooks);
    facade = new MarketDataFacade(client, {
      staleMs: 100,
      restMinIntervalMs: 50,
    });
  });

  describe("getOrderbookState", () => {
    it("should return data from WS cache when fresh", async () => {
      const tokenId = "token-1";
      
      // Populate store with fresh WS data
      store.updateFromWs(tokenId, [
        { price: 0.55, size: 100 },
      ], [
        { price: 0.56, size: 100 },
      ]);
      
      const state = await facade.getOrderbookState(tokenId);
      
      assert.notStrictEqual(state, null);
      // Use approximate comparison for floating point
      assert.ok(Math.abs(state!.bestBidCents - 55) < 0.01, `Best bid should be ~55, got ${state!.bestBidCents}`);
      assert.ok(Math.abs(state!.bestAskCents - 56) < 0.01, `Best ask should be ~56, got ${state!.bestAskCents}`);
      
      // Check that it was a WS hit
      const metrics = facade.getMetrics();
      assert.strictEqual(metrics.wsHits, 1);
      assert.strictEqual(metrics.restFallbacks, 0);
    });

    it("should fallback to REST when data is stale", async () => {
      const tokenId = "token-1";
      
      // Populate store with data that will become stale
      store.updateFromWs(tokenId, [
        { price: 0.50, size: 100 },
      ], [
        { price: 0.51, size: 100 },
      ]);
      
      // Wait for data to become stale
      await new Promise(resolve => setTimeout(resolve, 150));
      
      const state = await facade.getOrderbookState(tokenId);
      
      assert.notStrictEqual(state, null);
      // Should have REST data (0.55/0.56 from mock)
      // Use approximate comparison for floating point
      assert.ok(Math.abs(state!.bestBidCents - 55) < 0.01, `Best bid should be ~55, got ${state!.bestBidCents}`);
      assert.ok(Math.abs(state!.bestAskCents - 56) < 0.01, `Best ask should be ~56, got ${state!.bestAskCents}`);
      
      // Check that it was a REST fallback
      const metrics = facade.getMetrics();
      assert.strictEqual(metrics.restFallbacks, 1);
    });

    it("should return null when token has no orderbook", async () => {
      const state = await facade.getOrderbookState("unknown-token");
      assert.strictEqual(state, null);
    });
  });

  describe("Rate limiting", () => {
    it("should rate limit REST calls for the same token", async () => {
      const tokenId = "token-1";
      
      // First call should succeed (REST fallback)
      const state1 = await facade.getOrderbookState(tokenId);
      assert.notStrictEqual(state1, null);
      
      // Clear WS data to force REST attempt
      store.clear();
      
      // Second call immediately should be rate limited (no data available)
      const state2 = await facade.getOrderbookState(tokenId);
      // Should return null since rate limited and no cache
      assert.strictEqual(state2, null);
    });

    it("should allow REST call after interval passes", async () => {
      const tokenId = "token-1";
      
      // First call - populate store via REST
      const state1 = await facade.getOrderbookState(tokenId);
      assert.notStrictEqual(state1, null);
      
      // Wait for staleness threshold AND rate limit to expire
      await new Promise(resolve => setTimeout(resolve, 150));
      
      // Second call should succeed (data is now stale, rate limit expired)
      const state2 = await facade.getOrderbookState(tokenId);
      assert.notStrictEqual(state2, null);
    });
  });

  describe("Metrics", () => {
    it("should track WS hits and REST fallbacks", async () => {
      const tokenId = "token-1";
      
      // Fresh WS data - should be WS hit
      store.updateFromWs(tokenId, [
        { price: 0.55, size: 100 },
      ], [
        { price: 0.56, size: 100 },
      ]);
      
      await facade.getOrderbookState(tokenId);
      
      let metrics = facade.getMetrics();
      assert.strictEqual(metrics.wsHits, 1);
      assert.strictEqual(metrics.restFallbacks, 0);
      
      // Make data stale
      store.clear();
      await new Promise(resolve => setTimeout(resolve, 60));
      
      // This should be REST fallback
      await facade.getOrderbookState(tokenId);
      
      metrics = facade.getMetrics();
      assert.strictEqual(metrics.restFallbacks, 1);
    });
  });

  describe("Mode detection", () => {
    it("should report REST_ONLY when WS not connected", () => {
      const mode = facade.getMode();
      assert.strictEqual(mode, "REST_ONLY");
    });

    it("should report WS_OK when WS connected and data fresh", () => {
      store.setWsConnected(true);
      store.updateFromWs("token-1", [
        { price: 0.55, size: 100 },
      ], [
        { price: 0.56, size: 100 },
      ]);
      
      const mode = facade.getMode();
      assert.strictEqual(mode, "WS_OK");
    });
  });
});
