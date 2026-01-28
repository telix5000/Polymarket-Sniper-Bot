/**
 * Persistence Module Tests
 *
 * Tests for:
 * - BaseStore: LRU eviction, TTL, metrics
 * - MarketCache: Market caching with multi-key indexing
 * - PositionStore: Position storage with staleness tracking
 * - StoreRegistry: Health check aggregation
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";

import {
  BaseStore,
  MarketCache,
  PositionStore,
  StoreRegistry,
  getMarketCache,
  initMarketCache,
  getPositionStore,
  initPositionStore,
  getStoreRegistry,
  initStoreRegistry,
} from "../../src/infra/persistence";

// ============================================================================
// Test Helpers
// ============================================================================

/** Concrete implementation of BaseStore for testing */
class TestStore extends BaseStore<string, string> {
  constructor(
    nameOrEntries: string | number = "TestStore",
    maxEntries = 100,
    ttlMs = 0,
  ) {
    // Handle both old (maxEntries first) and new (name first) signatures
    const name =
      typeof nameOrEntries === "string" ? nameOrEntries : "TestStore";
    const entries =
      typeof nameOrEntries === "number" ? nameOrEntries : maxEntries;
    super(name, { maxEntries: entries, ttlMs, trackMetrics: true });
  }
}

/** TestStore with TTL support */
class TTLTestStore extends BaseStore<string, string> {
  constructor(ttlMs: number, maxEntries = 100) {
    super("TTLTestStore", { maxEntries, ttlMs, trackMetrics: true });
  }
}

// ============================================================================
// BaseStore Tests
// ============================================================================

describe("BaseStore", () => {
  let store: TestStore;

  beforeEach(() => {
    store = new TestStore(10);
  });

  describe("Basic operations", () => {
    it("should store and retrieve values", () => {
      store.set("key1", "value1");
      assert.strictEqual(store.get("key1"), "value1");
    });

    it("should return null for missing keys", () => {
      assert.strictEqual(store.get("missing"), null);
    });

    it("should check key existence", () => {
      store.set("key1", "value1");
      assert.strictEqual(store.has("key1"), true);
      assert.strictEqual(store.has("missing"), false);
    });

    it("should delete values", () => {
      store.set("key1", "value1");
      assert.strictEqual(store.delete("key1"), true);
      assert.strictEqual(store.has("key1"), false);
    });

    it("should clear all values", () => {
      store.set("key1", "value1");
      store.set("key2", "value2");
      store.clear();
      assert.strictEqual(store.size(), 0);
    });

    it("should return all keys", () => {
      store.set("key1", "value1");
      store.set("key2", "value2");
      const keys = store.keys();
      assert.deepStrictEqual(keys.sort(), ["key1", "key2"]);
    });
  });

  describe("LRU eviction", () => {
    it("should evict oldest entry when at capacity", () => {
      const smallStore = new TestStore(3);

      smallStore.set("key1", "value1");
      smallStore.set("key2", "value2");
      smallStore.set("key3", "value3");

      // All should exist
      assert.strictEqual(smallStore.has("key1"), true);
      assert.strictEqual(smallStore.has("key2"), true);
      assert.strictEqual(smallStore.has("key3"), true);

      // Add a 4th entry - should evict key1
      smallStore.set("key4", "value4");

      assert.strictEqual(smallStore.has("key1"), false);
      assert.strictEqual(smallStore.has("key4"), true);
    });

    it("should update LRU order on access", () => {
      const smallStore = new TestStore(3);

      smallStore.set("key1", "value1");
      smallStore.set("key2", "value2");
      smallStore.set("key3", "value3");

      // Access key1 to make it most recently used
      smallStore.get("key1");

      // Add key4 - should evict key2 (now oldest)
      smallStore.set("key4", "value4");

      assert.strictEqual(smallStore.has("key1"), true);
      assert.strictEqual(smallStore.has("key2"), false);
    });

    it("should track eviction count in metrics", () => {
      const smallStore = new TestStore(2);

      smallStore.set("key1", "value1");
      smallStore.set("key2", "value2");
      smallStore.set("key3", "value3"); // Evicts key1

      const metrics = smallStore.getMetrics();
      assert.strictEqual(metrics.evictions, 1);
    });
  });

  describe("TTL expiration", () => {
    it("should expire entries after TTL", async () => {
      const ttlStore = new TTLTestStore(50, 10); // 50ms TTL, 10 max entries

      ttlStore.set("key1", "value1");
      assert.strictEqual(ttlStore.get("key1"), "value1");

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 60));

      assert.strictEqual(ttlStore.get("key1"), null);
    });

    it("should track expiration count in metrics", async () => {
      const ttlStore = new TTLTestStore(50, 10);

      ttlStore.set("key1", "value1");
      await new Promise((resolve) => setTimeout(resolve, 60));

      ttlStore.get("key1"); // Triggers expiration check

      const metrics = ttlStore.getMetrics();
      assert.strictEqual(metrics.expirations, 1);
    });
  });

  describe("Metrics", () => {
    it("should track hits and misses", () => {
      store.set("key1", "value1");

      store.get("key1"); // Hit
      store.get("key1"); // Hit
      store.get("missing"); // Miss

      const metrics = store.getMetrics();
      assert.strictEqual(metrics.hits, 2);
      assert.strictEqual(metrics.misses, 1);
      assert.strictEqual(metrics.hitRatio, 2 / 3);
    });

    it("should reset metrics", () => {
      store.set("key1", "value1");
      store.get("key1");

      store.resetMetrics();

      const metrics = store.getMetrics();
      assert.strictEqual(metrics.hits, 0);
      assert.strictEqual(metrics.misses, 0);
    });
  });

  describe("Health check", () => {
    it("should report healthy when not near capacity", () => {
      store.set("key1", "value1");
      const health = store.healthCheck();
      assert.strictEqual(health.healthy, true);
    });

    it("should report unhealthy when near capacity", () => {
      const smallStore = new TestStore(2);
      smallStore.set("key1", "value1");
      smallStore.set("key2", "value2");

      const health = smallStore.healthCheck();
      // 2/2 = 100% utilization > 95% threshold
      assert.strictEqual(health.healthy, false);
    });

    it("should include checkedAt timestamp", () => {
      const before = Date.now();
      const health = store.healthCheck();
      const after = Date.now();

      assert.ok(health.checkedAt >= before);
      assert.ok(health.checkedAt <= after);
    });
  });
});

// ============================================================================
// MarketCache Tests
// ============================================================================

describe("MarketCache", () => {
  let cache: MarketCache;

  beforeEach(() => {
    cache = initMarketCache({ maxEntries: 100 });
  });

  describe("Market caching", () => {
    it("should cache market by both token IDs", () => {
      const market = {
        yesTokenId: "yes-123",
        noTokenId: "no-123",
        conditionId: "cond-123",
        marketId: "market-123",
      };

      cache.cacheMarket(market);

      assert.deepStrictEqual(cache.getByTokenId("yes-123"), market);
      assert.deepStrictEqual(cache.getByTokenId("no-123"), market);
    });

    it("should cache market by condition ID", () => {
      const market = {
        yesTokenId: "yes-123",
        noTokenId: "no-123",
        conditionId: "cond-123",
        marketId: "market-123",
      };

      cache.cacheMarket(market);

      assert.deepStrictEqual(cache.getByConditionId("cond-123"), market);
    });

    it("should return null for unknown tokens", () => {
      assert.strictEqual(cache.getByTokenId("unknown"), null);
      assert.strictEqual(cache.getByConditionId("unknown"), null);
    });
  });

  describe("Token utilities", () => {
    it("should get opposite token ID", () => {
      const market = {
        yesTokenId: "yes-123",
        noTokenId: "no-123",
        conditionId: "cond-123",
        marketId: "market-123",
      };

      cache.cacheMarket(market);

      assert.strictEqual(cache.getOppositeTokenId("yes-123"), "no-123");
      assert.strictEqual(cache.getOppositeTokenId("no-123"), "yes-123");
    });

    it("should get token outcome", () => {
      const market = {
        yesTokenId: "yes-123",
        noTokenId: "no-123",
        conditionId: "cond-123",
        marketId: "market-123",
      };

      cache.cacheMarket(market);

      assert.strictEqual(cache.getTokenOutcome("yes-123"), "YES");
      assert.strictEqual(cache.getTokenOutcome("no-123"), "NO");
      assert.strictEqual(cache.getTokenOutcome("unknown"), null);
    });
  });

  describe("Singleton management", () => {
    it("should return same instance from getMarketCache", () => {
      const cache1 = getMarketCache();
      const cache2 = getMarketCache();
      assert.strictEqual(cache1, cache2);
    });

    it("should create new instance with initMarketCache", () => {
      const cache1 = getMarketCache();
      const cache2 = initMarketCache();
      assert.notStrictEqual(cache1, cache2);
    });
  });

  describe("LRU eviction with conditionIndex cleanup", () => {
    it("should clean up conditionIndex when market is evicted", () => {
      // Create a small cache that will trigger eviction
      const smallCache = initMarketCache({ maxEntries: 4 }); // 2 markets (4 token entries)

      const market1 = {
        yesTokenId: "yes-1",
        noTokenId: "no-1",
        conditionId: "cond-1",
        marketId: "market-1",
      };

      const market2 = {
        yesTokenId: "yes-2",
        noTokenId: "no-2",
        conditionId: "cond-2",
        marketId: "market-2",
      };

      const market3 = {
        yesTokenId: "yes-3",
        noTokenId: "no-3",
        conditionId: "cond-3",
        marketId: "market-3",
      };

      // Cache first two markets (4 entries, at capacity)
      smallCache.cacheMarket(market1);
      smallCache.cacheMarket(market2);

      // Verify both are cached
      assert.ok(smallCache.hasCondition("cond-1"));
      assert.ok(smallCache.hasCondition("cond-2"));

      // Cache third market - should evict market1's tokens
      smallCache.cacheMarket(market3);

      // market1 should be evicted, conditionIndex should be cleaned
      assert.strictEqual(smallCache.hasToken("yes-1"), false);
      assert.strictEqual(smallCache.hasToken("no-1"), false);
      assert.strictEqual(smallCache.hasCondition("cond-1"), false);

      // market2 and market3 should still exist
      assert.ok(smallCache.hasCondition("cond-2"));
      assert.ok(smallCache.hasCondition("cond-3"));
    });

    it("should clean up conditionIndex when market is explicitly deleted", () => {
      const market = {
        yesTokenId: "yes-del",
        noTokenId: "no-del",
        conditionId: "cond-del",
        marketId: "market-del",
      };

      cache.cacheMarket(market);
      assert.ok(cache.hasCondition("cond-del"));

      // Delete one token
      cache.delete("yes-del");

      // conditionIndex should still have the entry (other token exists)
      assert.ok(cache.hasToken("no-del"));
      // But getByConditionId might return null since yes token is gone
      // Actually, let's check hasCondition which checks yesTokenId
      // The conditionIndex entry should be cleaned when both are gone

      // Delete the other token
      cache.delete("no-del");

      // Now conditionIndex should be cleaned
      assert.strictEqual(cache.hasCondition("cond-del"), false);
      assert.strictEqual(cache.getByConditionId("cond-del"), null);
    });

    it("should handle caching the same market multiple times", () => {
      const market = {
        yesTokenId: "yes-dup",
        noTokenId: "no-dup",
        conditionId: "cond-dup",
        marketId: "market-dup",
      };

      cache.cacheMarket(market);
      cache.cacheMarket(market); // Cache again

      // Should still work correctly
      assert.deepStrictEqual(cache.getByTokenId("yes-dup"), market);
      assert.deepStrictEqual(cache.getByConditionId("cond-dup"), market);

      // Metrics should reflect the operations
      const metrics = cache.getMetrics();
      assert.ok(metrics.entryCount >= 2); // At least 2 entries for the market
    });
  });
});

// ============================================================================
// PositionStore Tests
// ============================================================================

describe("PositionStore", () => {
  let store: PositionStore;

  beforeEach(() => {
    store = initPositionStore({ staleThresholdMs: 100 });
  });

  describe("Position management", () => {
    it("should sync positions", () => {
      const positions = [
        {
          tokenId: "token-1",
          outcome: "YES",
          size: 100,
          avgPrice: 0.5,
          curPrice: 0.55,
          pnlPct: 10,
          pnlUsd: 5,
          gainCents: 5,
          value: 55,
        },
        {
          tokenId: "token-2",
          outcome: "NO",
          size: 50,
          avgPrice: 0.3,
          curPrice: 0.35,
          pnlPct: 16.67,
          pnlUsd: 2.5,
          gainCents: 5,
          value: 17.5,
        },
      ];

      store.syncPositions(positions);

      assert.strictEqual(store.size(), 2);
      assert.deepStrictEqual(store.getPosition("token-1"), positions[0]);
    });

    it("should get all positions", () => {
      const positions = [
        {
          tokenId: "token-1",
          outcome: "YES",
          size: 100,
          avgPrice: 0.5,
          curPrice: 0.55,
          pnlPct: 10,
          pnlUsd: 5,
          gainCents: 5,
          value: 55,
        },
      ];

      store.syncPositions(positions);

      const all = store.getAllPositions();
      assert.strictEqual(all.length, 1);
      assert.deepStrictEqual(all[0], positions[0]);
    });
  });

  describe("Staleness tracking", () => {
    it("should start as stale before any sync", () => {
      assert.strictEqual(store.isStale(), true);
    });

    it("should be fresh after sync", () => {
      store.syncPositions([]);
      assert.strictEqual(store.isStale(), false);
    });

    it("should become stale after threshold", async () => {
      store.syncPositions([]);
      assert.strictEqual(store.isStale(), false);

      // Wait for staleness
      await new Promise((resolve) => setTimeout(resolve, 110));

      assert.strictEqual(store.isStale(), true);
    });
  });

  describe("Metrics", () => {
    it("should calculate total value", () => {
      store.syncPositions([
        {
          tokenId: "token-1",
          outcome: "YES",
          size: 100,
          avgPrice: 0.5,
          curPrice: 0.55,
          pnlPct: 10,
          pnlUsd: 5,
          gainCents: 5,
          value: 55,
        },
        {
          tokenId: "token-2",
          outcome: "NO",
          size: 50,
          avgPrice: 0.3,
          curPrice: 0.35,
          pnlPct: 16.67,
          pnlUsd: 2.5,
          gainCents: 5,
          value: 17.5,
        },
      ]);

      assert.strictEqual(store.getTotalValue(), 72.5);
    });

    it("should calculate profitability breakdown", () => {
      store.syncPositions([
        {
          tokenId: "token-1",
          outcome: "YES",
          size: 100,
          avgPrice: 0.5,
          curPrice: 0.55,
          pnlPct: 10,
          pnlUsd: 5,
          gainCents: 5,
          value: 55,
        },
        {
          tokenId: "token-2",
          outcome: "NO",
          size: 50,
          avgPrice: 0.5,
          curPrice: 0.45,
          pnlPct: -10,
          pnlUsd: -2.5,
          gainCents: -5,
          value: 22.5,
        },
      ]);

      const breakdown = store.getProfitabilityBreakdown();
      assert.strictEqual(breakdown.profitable, 1);
      assert.strictEqual(breakdown.losing, 1);
    });
  });

  describe("Singleton management", () => {
    it("should return same instance from getPositionStore", () => {
      const store1 = getPositionStore();
      const store2 = getPositionStore();
      assert.strictEqual(store1, store2);
    });

    it("should create new instance with initPositionStore", () => {
      const store1 = getPositionStore();
      const store2 = initPositionStore();
      assert.notStrictEqual(store1, store2);
    });
  });
});

// ============================================================================
// StoreRegistry Tests
// ============================================================================

describe("StoreRegistry", () => {
  let registry: StoreRegistry;

  beforeEach(() => {
    registry = initStoreRegistry();
  });

  describe("Registration", () => {
    it("should register stores", () => {
      const store = new TestStore();
      registry.register(store);

      assert.strictEqual(registry.getStoreCount(), 1);
      assert.deepStrictEqual(registry.getStoreNames(), ["TestStore"]);
    });

    it("should unregister stores", () => {
      const store = new TestStore();
      registry.register(store);
      registry.unregister("TestStore");

      assert.strictEqual(registry.getStoreCount(), 0);
    });

    it("should get registered store by name", () => {
      const store = new TestStore();
      registry.register(store);

      const retrieved = registry.getStore<TestStore>("TestStore");
      assert.strictEqual(retrieved, store);
    });
  });

  describe("Health checks", () => {
    it("should aggregate health status", () => {
      const store1 = new TestStore("Store1", 100);
      const store2 = new TestStore("Store2", 100);

      store1.set("key1", "value1");
      store2.set("key1", "value1");

      registry.register(store1);
      registry.register(store2);

      const health = registry.healthCheck();
      assert.strictEqual(health.healthy, true);
      assert.strictEqual(health.healthyCount, 2);
      assert.strictEqual(health.unhealthyCount, 0);
    });

    it("should report unhealthy when any store is unhealthy", () => {
      const healthyStore = new TestStore("HealthyStore", 100);
      const unhealthyStore = new TestStore("UnhealthyStore", 2); // Small capacity

      healthyStore.set("key1", "value1");
      unhealthyStore.set("key1", "value1");
      unhealthyStore.set("key2", "value2"); // At capacity

      registry.register(healthyStore);
      registry.register(unhealthyStore);

      const health = registry.healthCheck();
      assert.strictEqual(health.healthy, false);
      assert.strictEqual(health.healthyCount, 1);
      assert.strictEqual(health.unhealthyCount, 1);
    });
  });

  describe("Metrics aggregation", () => {
    it("should aggregate metrics from all stores", () => {
      const store1 = new TestStore("MetricsStore1");
      const store2 = new TestStore("MetricsStore2");

      store1.set("key1", "value1");
      store1.set("key2", "value2");
      store2.set("key1", "value1");

      registry.register(store1);
      registry.register(store2);

      const metrics = registry.getMetrics();
      assert.strictEqual(metrics.totalEntries, 3);
      assert.strictEqual(metrics.storeCount, 2);
    });
  });

  describe("Lifecycle", () => {
    it("should clear all stores", () => {
      const store1 = new TestStore("LifecycleStore1");
      const store2 = new TestStore("LifecycleStore2");

      store1.set("key1", "value1");
      store2.set("key1", "value1");

      registry.register(store1);
      registry.register(store2);

      registry.clearAll();

      assert.strictEqual(store1.size(), 0);
      assert.strictEqual(store2.size(), 0);
    });

    it("should reset registry", () => {
      const store = new TestStore();
      registry.register(store);

      registry.reset();

      assert.strictEqual(registry.getStoreCount(), 0);
    });
  });

  describe("Singleton management", () => {
    it("should return same instance from getStoreRegistry", () => {
      const reg1 = getStoreRegistry();
      const reg2 = getStoreRegistry();
      assert.strictEqual(reg1, reg2);
    });

    it("should create new instance with initStoreRegistry", () => {
      const reg1 = getStoreRegistry();
      const reg2 = initStoreRegistry();
      assert.notStrictEqual(reg1, reg2);
    });
  });
});
