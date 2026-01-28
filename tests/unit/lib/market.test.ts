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
} from "../../../src/lib/market";

describe("Market Token Lookup", () => {
  // Sample market data similar to what Gamma API returns
  // Standard case: YES at index 0, NO at index 1
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

  // Reversed case: NO at index 0, YES at index 1
  // This tests that we use outcomes, not position, to determine YES/NO
  const mockReversedOutcomesResponse = {
    id: "market-456",
    question: "Will ETH reach $5k?",
    conditionId: "0xcondition456",
    clobTokenIds: '["first-token", "second-token"]',
    outcomes: '["No", "Yes"]', // Note: reversed order!
    outcomePrices: '["0.35", "0.65"]',
    endDate: "2024-12-31T23:59:59Z",
    active: true,
    closed: false,
    acceptingOrders: true,
  };

  // Non-binary market (e.g., Trump vs Biden)
  const mockNonBinaryMarketResponse = {
    id: "market-789",
    question: "Who will win the election?",
    conditionId: "0xcondition789",
    clobTokenIds: '["trump-token", "biden-token"]',
    outcomes: '["Trump", "Biden"]', // Not YES/NO
    outcomePrices: '["0.45", "0.55"]',
    endDate: "2024-11-05T23:59:59Z",
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
        assert.strictEqual(
          opposite,
          "no-token-id-67890",
          "Should return the NO token",
        );
      } finally {
        axios.get = originalGet;
      }
    });

    test("should return YES token when given NO token", async () => {
      const originalGet = axios.get;
      axios.get = async () => ({ data: [mockMarketResponse] });

      try {
        const opposite = await getOppositeTokenId("no-token-id-67890");
        assert.strictEqual(
          opposite,
          "yes-token-id-12345",
          "Should return the YES token",
        );
      } finally {
        axios.get = originalGet;
      }
    });

    test("should return null when market not found", async () => {
      const originalGet = axios.get;
      axios.get = async () => ({ data: [] });

      try {
        const opposite = await getOppositeTokenId("unknown-token");
        assert.strictEqual(
          opposite,
          null,
          "Should return null for unknown token",
        );
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
        assert.strictEqual(
          callCount,
          1,
          "Should still be 1 API call (both tokens cached)",
        );
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
        assert.strictEqual(
          statsAfter.size,
          0,
          "Cache should be empty after clear",
        );

        // Next call should hit API again
        await getOppositeTokenId("yes-token-id-12345");
        assert.strictEqual(
          callCount,
          2,
          "Should make new API call after cache clear",
        );
      } finally {
        axios.get = originalGet;
      }
    });
  });

  describe("fetchMarketByConditionId", () => {
    test("should fetch market by condition ID", async () => {
      const originalGet = axios.get;
      axios.get = async (url: string) => {
        assert.ok(
          url.includes("condition_id="),
          "Should query by condition_id",
        );
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
        data: [
          {
            ...mockMarketResponse,
            clobTokenIds: "not valid json",
          },
        ],
      });

      try {
        const result = await getOppositeTokenId("some-token");
        assert.strictEqual(
          result,
          null,
          "Should return null for malformed data",
        );
      } finally {
        axios.get = originalGet;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Gamma API Outcomes Field Tests
  // These tests ensure correct YES/NO token mapping based on outcomes array
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Gamma API Outcomes-Based Mapping", () => {
    test("should correctly map YES/NO when outcomes are in standard order", async () => {
      const originalGet = axios.get;
      axios.get = async () => ({ data: [mockMarketResponse] });

      try {
        const market = await fetchMarketByTokenId("yes-token-id-12345");
        assert.ok(market, "Should return market data");
        // outcomes: ["Yes", "No"] => tokenIds[0]=YES, tokenIds[1]=NO
        assert.strictEqual(market?.yesTokenId, "yes-token-id-12345");
        assert.strictEqual(market?.noTokenId, "no-token-id-67890");
      } finally {
        axios.get = originalGet;
      }
    });

    test("should correctly map YES/NO when outcomes are REVERSED order", async () => {
      const originalGet = axios.get;
      axios.get = async () => ({ data: [mockReversedOutcomesResponse] });

      try {
        // Query for first-token (which is NO in this market)
        const market = await fetchMarketByTokenId("first-token");
        assert.ok(market, "Should return market data");
        // outcomes: ["No", "Yes"] => tokenIds[1]=YES, tokenIds[0]=NO
        // So: first-token=NO, second-token=YES
        assert.strictEqual(
          market?.yesTokenId,
          "second-token",
          "YES should be second-token",
        );
        assert.strictEqual(
          market?.noTokenId,
          "first-token",
          "NO should be first-token",
        );
      } finally {
        axios.get = originalGet;
      }
    });

    test("should return correct opposite token for REVERSED outcomes", async () => {
      const originalGet = axios.get;
      axios.get = async () => ({ data: [mockReversedOutcomesResponse] });

      try {
        // first-token is NO in this market (outcomes[0] = "No")
        // So the opposite should be second-token (YES)
        const opposite = await getOppositeTokenId("first-token");
        assert.strictEqual(
          opposite,
          "second-token",
          "Opposite of NO should be YES",
        );

        // Clear cache to test the other direction
        clearMarketCache();

        // second-token is YES in this market (outcomes[1] = "Yes")
        // So the opposite should be first-token (NO)
        const opposite2 = await getOppositeTokenId("second-token");
        assert.strictEqual(
          opposite2,
          "first-token",
          "Opposite of YES should be NO",
        );
      } finally {
        axios.get = originalGet;
      }
    });

    test("should return null for non-binary markets (non-YES/NO outcomes)", async () => {
      const originalGet = axios.get;
      axios.get = async () => ({ data: [mockNonBinaryMarketResponse] });

      try {
        const result = await getOppositeTokenId("trump-token");
        assert.strictEqual(
          result,
          null,
          "Should return null for non-binary markets",
        );
      } finally {
        axios.get = originalGet;
      }
    });

    test("should handle case-insensitive YES matching", async () => {
      const originalGet = axios.get;
      const mixedCaseResponse = {
        ...mockMarketResponse,
        outcomes: '["YES", "no"]', // Different case
        clobTokenIds: '["upper-yes-token", "lower-no-token"]',
      };
      axios.get = async () => ({ data: [mixedCaseResponse] });

      try {
        const market = await fetchMarketByTokenId("upper-yes-token");
        assert.ok(market, "Should return market data");
        assert.strictEqual(market?.yesTokenId, "upper-yes-token");
        assert.strictEqual(market?.noTokenId, "lower-no-token");
      } finally {
        axios.get = originalGet;
      }
    });

    test("should handle missing outcomes field with legacy fallback", async () => {
      const originalGet = axios.get;
      const noOutcomesResponse = {
        ...mockMarketResponse,
        outcomes: undefined, // Missing outcomes field
        clobTokenIds: '["legacy-first", "legacy-second"]',
      };
      axios.get = async () => ({ data: [noOutcomesResponse] });

      try {
        const market = await fetchMarketByTokenId("legacy-first");
        assert.ok(market, "Should return market data with legacy fallback");
        // Legacy behavior: index 0 = YES, index 1 = NO
        assert.strictEqual(market?.yesTokenId, "legacy-first");
        assert.strictEqual(market?.noTokenId, "legacy-second");
      } finally {
        axios.get = originalGet;
      }
    });

    test("should return null for missing outcomes with more than 2 tokens", async () => {
      const originalGet = axios.get;
      const multiTokenNoOutcomesResponse = {
        ...mockMarketResponse,
        outcomes: undefined, // Missing outcomes field
        clobTokenIds: '["token-1", "token-2", "token-3"]', // 3+ tokens without outcomes
      };
      axios.get = async () => ({ data: [multiTokenNoOutcomesResponse] });

      try {
        const result = await getOppositeTokenId("token-1");
        assert.strictEqual(
          result,
          null,
          "Should return null for non-binary markets without outcomes field",
        );
      } finally {
        axios.get = originalGet;
      }
    });

    test("should handle malformed outcomes field gracefully", async () => {
      const originalGet = axios.get;
      const malformedOutcomesResponse = {
        ...mockMarketResponse,
        outcomes: "not valid json",
      };
      axios.get = async () => ({ data: [malformedOutcomesResponse] });

      try {
        const result = await getOppositeTokenId("some-token");
        assert.strictEqual(
          result,
          null,
          "Should return null for malformed outcomes",
        );
      } finally {
        axios.get = originalGet;
      }
    });

    test("should handle outcomes array with fewer than 2 elements", async () => {
      const originalGet = axios.get;
      const singleOutcomeResponse = {
        ...mockMarketResponse,
        outcomes: '["Yes"]', // Only one outcome
      };
      axios.get = async () => ({ data: [singleOutcomeResponse] });

      try {
        const result = await getOppositeTokenId("some-token");
        assert.strictEqual(
          result,
          null,
          "Should return null for single-outcome markets",
        );
      } finally {
        axios.get = originalGet;
      }
    });

    test("should handle outcomes that are not strings", async () => {
      const originalGet = axios.get;
      const nonStringOutcomesResponse = {
        ...mockMarketResponse,
        outcomes: "[123, 456]", // Numbers instead of strings
      };
      axios.get = async () => ({ data: [nonStringOutcomesResponse] });

      try {
        const result = await getOppositeTokenId("some-token");
        assert.strictEqual(
          result,
          null,
          "Should return null for non-string outcomes",
        );
      } finally {
        axios.get = originalGet;
      }
    });

    test("should return null when tokenIds and outcomes array lengths mismatch", async () => {
      const originalGet = axios.get;
      const mismatchedLengthsResponse = {
        ...mockMarketResponse,
        clobTokenIds: '["token-1", "token-2"]',
        outcomes: '["Yes", "No", "Maybe"]', // 3 outcomes but only 2 tokens
      };
      axios.get = async () => ({ data: [mismatchedLengthsResponse] });

      try {
        const result = await getOppositeTokenId("token-1");
        assert.strictEqual(
          result,
          null,
          "Should return null for array length mismatch",
        );
      } finally {
        axios.get = originalGet;
      }
    });

    test("should return null for markets with more than 2 outcomes", async () => {
      const originalGet = axios.get;
      const threeOutcomeResponse = {
        ...mockMarketResponse,
        clobTokenIds: '["token-1", "token-2", "token-3"]',
        outcomes: '["Yes", "No", "Maybe"]', // 3 outcomes - non-binary
      };
      axios.get = async () => ({ data: [threeOutcomeResponse] });

      try {
        const result = await getOppositeTokenId("token-1");
        assert.strictEqual(
          result,
          null,
          "Should return null for non-binary markets with >2 outcomes",
        );
      } finally {
        axios.get = originalGet;
      }
    });

    test("should return correct outcome type for reversed market", async () => {
      const originalGet = axios.get;
      axios.get = async () => ({ data: [mockReversedOutcomesResponse] });

      try {
        // first-token has outcome "No" at index 0
        const outcome1 = await getTokenOutcome("first-token");
        assert.strictEqual(outcome1, "NO", "first-token should be NO outcome");

        clearMarketCache();

        // second-token has outcome "Yes" at index 1
        const outcome2 = await getTokenOutcome("second-token");
        assert.strictEqual(
          outcome2,
          "YES",
          "second-token should be YES outcome",
        );
      } finally {
        axios.get = originalGet;
      }
    });
  });
});
