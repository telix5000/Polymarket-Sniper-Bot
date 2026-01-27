import { describe, test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import axios from "axios";

// Import the module we're testing
import {
  fetchMarketByTokenId,
  fetchMarketByConditionId,
  getOppositeTokenId,
  getTokenOutcome,
  clearMarketCache,
  getMarketCacheStats,
  type MarketTokenPair,
} from "../../src/lib/market";

describe("Market Token Lookup", () => {
  // Sample market data similar to what Gamma API returns
  const mockMarketResponse = {
    id: "market-123",
    question: "Will Bitcoin reach $100k?",
    conditionId: "0xcondition123",
    clobTokenIds: '["yes-token-id-12345", "no-token-id-67890"]',
    outcomes: '["Yes", "No"]',
    outcomePrices: '["0.65", "0.35"]',
    endDate: "2024-12-31T23:59:59Z",
    active: true,
    closed: false,
    acceptingOrders: true,
  };

  // Clear cache before each test
  beforeEach(() => {
    clearMarketCache();
  });

  describe("getOppositeTokenId", () => {
    test("should return NO token when given YES token", async () => {
      // Mock axios
      const originalGet = axios.get;
      axios.get = async () => ({ data: [mockMarketResponse] });

      try {
        const opposite = await getOppositeTokenId("yes-token-id-12345");
        assert.strictEqual(opposite, "no-token-id-67890", "Should return the NO token");
      } finally {
        axios.get = originalGet;
      }
    });

    test("should return YES token when given NO token", async () => {
      const originalGet = axios.get;
      axios.get = async () => ({ data: [mockMarketResponse] });

      try {
        const opposite = await getOppositeTokenId("no-token-id-67890");
        assert.strictEqual(opposite, "yes-token-id-12345", "Should return the YES token");
      } finally {
        axios.get = originalGet;
      }
    });

    test("should return null when market not found", async () => {
      const originalGet = axios.get;
      axios.get = async () => ({ data: [] });

      try {
        const opposite = await getOppositeTokenId("unknown-token");
        assert.strictEqual(opposite, null, "Should return null for unknown token");
      } finally {
        axios.get = originalGet;
      }
    });

    test("should cache results to avoid repeated API calls", async () => {
      let callCount = 0;
      const originalGet = axios.get;
      axios.get = async () => {
        callCount++;
        return { data: [mockMarketResponse] };
      };

      try {
        // First call should hit API
        await getOppositeTokenId("yes-token-id-12345");
        assert.strictEqual(callCount, 1, "Should make 1 API call");

        // Second call should use cache
        await getOppositeTokenId("yes-token-id-12345");
        assert.strictEqual(callCount, 1, "Should still be 1 API call (cached)");

        // Looking up opposite token should also use cache
        await getOppositeTokenId("no-token-id-67890");
        assert.strictEqual(callCount, 1, "Should still be 1 API call (both tokens cached)");
      } finally {
        axios.get = originalGet;
      }
    });
  });

  describe("getTokenOutcome", () => {
    test("should return YES for the YES token", async () => {
      const originalGet = axios.get;
      axios.get = async () => ({ data: [mockMarketResponse] });

      try {
        const outcome = await getTokenOutcome("yes-token-id-12345");
        assert.strictEqual(outcome, "YES");
      } finally {
        axios.get = originalGet;
      }
    });

    test("should return NO for the NO token", async () => {
      const originalGet = axios.get;
      axios.get = async () => ({ data: [mockMarketResponse] });

      try {
        const outcome = await getTokenOutcome("no-token-id-67890");
        assert.strictEqual(outcome, "NO");
      } finally {
        axios.get = originalGet;
      }
    });
  });

  describe("clearMarketCache", () => {
    test("should clear all cached data", async () => {
      const originalGet = axios.get;
      let callCount = 0;
      axios.get = async () => {
        callCount++;
        return { data: [mockMarketResponse] };
      };

      try {
        // Populate cache
        await getOppositeTokenId("yes-token-id-12345");
        assert.strictEqual(callCount, 1);

        const statsBefore = getMarketCacheStats();
        assert.ok(statsBefore.size > 0, "Cache should have entries");

        // Clear cache
        clearMarketCache();

        const statsAfter = getMarketCacheStats();
        assert.strictEqual(statsAfter.size, 0, "Cache should be empty after clear");

        // Next call should hit API again
        await getOppositeTokenId("yes-token-id-12345");
        assert.strictEqual(callCount, 2, "Should make new API call after cache clear");
      } finally {
        axios.get = originalGet;
      }
    });
  });

  describe("fetchMarketByConditionId", () => {
    test("should fetch market by condition ID", async () => {
      const originalGet = axios.get;
      axios.get = async (url: string) => {
        assert.ok(url.includes("condition_id="), "Should query by condition_id");
        return { data: [mockMarketResponse] };
      };

      try {
        const market = await fetchMarketByConditionId("0xcondition123");
        assert.ok(market, "Should return market data");
        assert.strictEqual(market?.yesTokenId, "yes-token-id-12345");
        assert.strictEqual(market?.noTokenId, "no-token-id-67890");
      } finally {
        axios.get = originalGet;
      }
    });
  });

  describe("Error handling", () => {
    test("should handle API errors gracefully", async () => {
      const originalGet = axios.get;
      axios.get = async () => {
        throw new Error("Network error");
      };

      try {
        const result = await getOppositeTokenId("some-token");
        assert.strictEqual(result, null, "Should return null on error");
      } finally {
        axios.get = originalGet;
      }
    });

    test("should handle malformed clobTokenIds", async () => {
      const originalGet = axios.get;
      axios.get = async () => ({
        data: [{
          ...mockMarketResponse,
          clobTokenIds: "not valid json",
        }],
      });

      try {
        const result = await getOppositeTokenId("some-token");
        assert.strictEqual(result, null, "Should return null for malformed data");
      } finally {
        axios.get = originalGet;
      }
    });
  });
});
