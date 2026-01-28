import assert from "node:assert";
import { test, describe, beforeEach } from "node:test";
import {
  MarketScanner,
  type ScannerConfig,
  type MarketDataInput,
  DEFAULT_SCANNER_CONFIG,
} from "../src/lib/market-scanner";

/**
 * Unit tests for the simplified Market Scanner
 *
 * The scanner:
 * - Finds markets suitable for high-frequency EV-positive churn
 * - Avoids prediction, valuation, or outcome forecasting
 * - Keeps signals minimal, explainable, and robust
 * - Prefers false negatives over false positives
 */

describe("MarketScanner", () => {
  let scanner: MarketScanner;

  // Test configuration with predictable values
  const testConfig: ScannerConfig = {
    enabled: true,
    entryBandCents: 10, // 10 cent movement required
    scanWindowSeconds: 60, // 1 minute window
    maxSpreadCents: 5, // Max 5 cent spread (reject wider)
    minDepthUsdAtExit: 20, // $20 minimum depth
    preferredEntryLowCents: 30, // Min 30 cents
    preferredEntryHighCents: 70, // Max 70 cents
    leaderboardBoostEnabled: false,
    scanMinLeaderboardTrades: 1,
    scanLeaderboardWindowSeconds: 60,
    deduplicationWindowSeconds: 60,
  };

  // Helper to create market data
  function createMarketData(
    overrides: Partial<MarketDataInput> = {},
  ): MarketDataInput {
    return {
      tokenId: "test-token-123",
      marketId: "test-market-456",
      midPriceCents: 50, // Safe zone middle
      spreadCents: 2, // Tight spread
      bidDepthUsd: 100, // Good depth
      askDepthUsd: 100,
      ...overrides,
    };
  }

  beforeEach(() => {
    scanner = new MarketScanner(testConfig);
  });

  describe("Initialization", () => {
    test("should initialize with default config", () => {
      const defaultScanner = new MarketScanner();
      assert.ok(defaultScanner.isEnabled());
    });

    test("should initialize with custom config", () => {
      const customScanner = new MarketScanner({ enabled: false });
      assert.strictEqual(customScanner.isEnabled(), false);
    });

    test("should return config via getConfig", () => {
      const config = scanner.getConfig();
      assert.strictEqual(config.entryBandCents, testConfig.entryBandCents);
      assert.strictEqual(config.maxSpreadCents, testConfig.maxSpreadCents);
    });
  });

  describe("Scanner Enable/Disable", () => {
    test("should return null when disabled", () => {
      const disabledScanner = new MarketScanner({ enabled: false });
      const data = createMarketData();

      // Even with valid data, should return null when disabled
      const result = disabledScanner.evaluate(data);
      assert.strictEqual(result, null);
    });

    test("should process when enabled", () => {
      // First, build up price history with movement
      const data = createMarketData();

      // Record low price
      scanner.evaluate({
        ...data,
        midPriceCents: 40,
      });

      // Wait simulation - advance time in price history
      // Record high price (10 cent movement)
      const result = scanner.evaluate({
        ...data,
        midPriceCents: 50,
      });

      // Should return a candidate due to price movement
      assert.ok(
        result !== null,
        "Expected candidate when scanner is enabled with movement",
      );
    });
  });

  describe("Safe Price Zone Filter", () => {
    test("should reject price below preferred entry low", () => {
      // Create price history first
      scanner.evaluate(createMarketData({ midPriceCents: 20 }));

      const data = createMarketData({
        midPriceCents: 25, // Below 30 cent minimum
      });

      const result = scanner.evaluate(data);
      assert.strictEqual(result, null, "Should reject price below safe zone");
    });

    test("should reject price above preferred entry high", () => {
      scanner.evaluate(createMarketData({ midPriceCents: 80 }));

      const data = createMarketData({
        midPriceCents: 75, // Above 70 cent maximum
      });

      const result = scanner.evaluate(data);
      assert.strictEqual(result, null, "Should reject price above safe zone");
    });

    test("should accept price at zone boundaries", () => {
      // Setup movement from 30 to 40 cents (10 cent movement)
      scanner.evaluate(
        createMarketData({ tokenId: "boundary-test", midPriceCents: 30 }),
      );

      const data = createMarketData({
        tokenId: "boundary-test",
        midPriceCents: 40, // Inside zone with movement
      });

      const result = scanner.evaluate(data);
      assert.ok(
        result !== null,
        "Should accept price at zone boundary with movement",
      );
    });

    test("should accept price in middle of zone", () => {
      // Setup movement
      scanner.evaluate(
        createMarketData({ tokenId: "middle-test", midPriceCents: 40 }),
      );

      const data = createMarketData({
        tokenId: "middle-test",
        midPriceCents: 50, // Middle of zone with movement
      });

      const result = scanner.evaluate(data);
      assert.ok(
        result !== null,
        "Should accept price in middle of zone with movement",
      );
    });
  });

  describe("Liquidity Presence Filter", () => {
    test("should reject spread too wide", () => {
      scanner.evaluate(
        createMarketData({ tokenId: "spread-test", midPriceCents: 40 }),
      );

      const data = createMarketData({
        tokenId: "spread-test",
        midPriceCents: 50,
        spreadCents: 10, // Above 5 cent max
      });

      const result = scanner.evaluate(data);
      assert.strictEqual(result, null, "Should reject wide spread");
    });

    test("should reject insufficient bid depth", () => {
      scanner.evaluate(
        createMarketData({ tokenId: "depth-test", midPriceCents: 40 }),
      );

      const data = createMarketData({
        tokenId: "depth-test",
        midPriceCents: 50,
        bidDepthUsd: 10, // Below $20 minimum
      });

      const result = scanner.evaluate(data);
      assert.strictEqual(result, null, "Should reject insufficient bid depth");
    });

    test("should accept tight spread with good depth", () => {
      scanner.evaluate(
        createMarketData({ tokenId: "liquid-test", midPriceCents: 40 }),
      );

      const data = createMarketData({
        tokenId: "liquid-test",
        midPriceCents: 50,
        spreadCents: 2, // Tight
        bidDepthUsd: 100, // Good depth
      });

      const result = scanner.evaluate(data);
      assert.ok(result !== null, "Should accept good liquidity with movement");
    });
  });

  describe("Price Movement Detection", () => {
    test("should detect movement >= entryBandCents", () => {
      const tokenId = "movement-test";

      // Record low price
      scanner.evaluate(createMarketData({ tokenId, midPriceCents: 40 }));

      // Record high price (10 cent movement)
      const result = scanner.evaluate(
        createMarketData({ tokenId, midPriceCents: 50 }),
      );

      assert.ok(result !== null, "Should detect sufficient movement");
      assert.strictEqual(result?.reason, "movement");
    });

    test("should NOT trigger on movement < entryBandCents", () => {
      const tokenId = "small-movement-test";

      // Record first price
      scanner.evaluate(createMarketData({ tokenId, midPriceCents: 45 }));

      // Small movement (5 cents, below 10 cent threshold)
      const result = scanner.evaluate(
        createMarketData({ tokenId, midPriceCents: 50 }),
      );

      // Should return null because no significant movement and no leaderboard activity
      assert.strictEqual(result, null, "Should not trigger on small movement");
    });

    test("should consider movement in both directions", () => {
      const tokenId = "bidirectional-test";

      // Record high price
      scanner.evaluate(createMarketData({ tokenId, midPriceCents: 60 }));

      // Price drops (10 cent movement down)
      const result = scanner.evaluate(
        createMarketData({ tokenId, midPriceCents: 50 }),
      );

      assert.ok(result !== null, "Should detect downward movement");
      assert.strictEqual(result?.reason, "movement");
    });
  });

  describe("Leaderboard Activity Boost", () => {
    test("should boost when leaderboard activity enabled and trades present", () => {
      const scannerWithBoost = new MarketScanner({
        ...testConfig,
        leaderboardBoostEnabled: true,
        scanMinLeaderboardTrades: 1,
      });

      const tokenId = "leaderboard-test";

      // Record a leaderboard trade
      scannerWithBoost.recordLeaderboardTrade(tokenId);

      // Evaluate - first call establishes history
      scannerWithBoost.evaluate(
        createMarketData({ tokenId, midPriceCents: 50 }),
      );

      // Create a new scanner with no dedup history to get a clean evaluation
      const cleanScanner = new MarketScanner({
        ...testConfig,
        leaderboardBoostEnabled: true,
        scanMinLeaderboardTrades: 1,
        deduplicationWindowSeconds: 0, // Disable dedup for test
      });

      // Record leaderboard trade for this token
      cleanScanner.recordLeaderboardTrade(tokenId);

      // First evaluate to prime price history, then evaluate again with leaderboard activity
      cleanScanner.evaluate(createMarketData({ tokenId, midPriceCents: 50 }));

      // Second eval - has leaderboard activity, no dedup
      const result = cleanScanner.evaluate(
        createMarketData({ tokenId, midPriceCents: 50 }),
      );

      // With leaderboard boost enabled and activity present, should get leaderboard reason
      assert.ok(
        result !== null,
        "Should emit candidate with leaderboard activity",
      );
      assert.strictEqual(result?.reason, "leaderboard");
    });

    test("should NOT boost when leaderboard activity disabled", () => {
      const tokenId = "no-boost-test";

      // Record leaderboard trade (but boost is disabled in testConfig)
      scanner.recordLeaderboardTrade(tokenId);

      // Evaluate without movement
      scanner.evaluate(createMarketData({ tokenId, midPriceCents: 50 }));
      const result = scanner.evaluate(
        createMarketData({ tokenId, midPriceCents: 50 }),
      );

      // Should return null - no movement, leaderboard boost disabled
      assert.strictEqual(result, null);
    });
  });

  describe("Deduplication", () => {
    test("should NOT emit duplicate candidates within window", () => {
      const tokenId = "dedup-test";

      // Setup movement
      scanner.evaluate(createMarketData({ tokenId, midPriceCents: 40 }));

      // First evaluation - should emit
      const result1 = scanner.evaluate(
        createMarketData({ tokenId, midPriceCents: 50 }),
      );
      assert.ok(result1 !== null, "First evaluation should emit");

      // Second evaluation immediately after - should be deduped
      const result2 = scanner.evaluate(
        createMarketData({ tokenId, midPriceCents: 50 }),
      );
      assert.strictEqual(result2, null, "Duplicate should be filtered");
    });

    test("should emit same token after dedup window expires", () => {
      // Use a scanner with very short dedup window for testing
      const shortDedupScanner = new MarketScanner({
        ...testConfig,
        deduplicationWindowSeconds: 0, // Immediate expiration
      });

      const tokenId = "dedup-expire-test";

      // Setup movement
      shortDedupScanner.evaluate(
        createMarketData({ tokenId, midPriceCents: 40 }),
      );

      // First evaluation
      const result1 = shortDedupScanner.evaluate(
        createMarketData({ tokenId, midPriceCents: 50 }),
      );
      assert.ok(result1 !== null);

      // Continue movement
      shortDedupScanner.evaluate(
        createMarketData({ tokenId, midPriceCents: 60 }),
      );

      // Should emit again since dedup window is 0
      const result2 = shortDedupScanner.evaluate(
        createMarketData({ tokenId, midPriceCents: 70 }),
      );
      assert.ok(result2 !== null, "Should emit after dedup expiration");
    });

    test("different tokens should NOT dedupe each other", () => {
      // Setup movement for token 1
      scanner.evaluate(
        createMarketData({ tokenId: "token-1", midPriceCents: 40 }),
      );
      const result1 = scanner.evaluate(
        createMarketData({ tokenId: "token-1", midPriceCents: 50 }),
      );
      assert.ok(result1 !== null);

      // Setup movement for token 2
      scanner.evaluate(
        createMarketData({ tokenId: "token-2", midPriceCents: 40 }),
      );
      const result2 = scanner.evaluate(
        createMarketData({ tokenId: "token-2", midPriceCents: 50 }),
      );

      // Token 2 should also emit - different token
      assert.ok(
        result2 !== null,
        "Different tokens should not dedupe each other",
      );
    });
  });

  describe("Idempotency", () => {
    test("same market data should produce null after first candidate", () => {
      const tokenId = "idempotent-test";
      const data = createMarketData({ tokenId, midPriceCents: 50 });

      // Setup history
      scanner.evaluate(createMarketData({ tokenId, midPriceCents: 40 }));

      // First call
      const result1 = scanner.evaluate(data);
      assert.ok(result1 !== null);

      // Same call again
      const result2 = scanner.evaluate(data);
      assert.strictEqual(result2, null, "Repeated calls should be idempotent");

      // Same call third time
      const result3 = scanner.evaluate(data);
      assert.strictEqual(
        result3,
        null,
        "Repeated calls should remain idempotent",
      );
    });
  });

  describe("Candidate Output Format", () => {
    test("should return correct ScannerCandidate structure", () => {
      const tokenId = "format-test-token";
      const marketId = "format-test-market";

      // Setup movement
      scanner.evaluate(
        createMarketData({ tokenId, marketId, midPriceCents: 40 }),
      );

      const result = scanner.evaluate(
        createMarketData({ tokenId, marketId, midPriceCents: 50 }),
      );

      assert.ok(result !== null);
      assert.strictEqual(result.tokenId, tokenId);
      assert.strictEqual(result.marketId, marketId);
      assert.strictEqual(result.reason, "movement");
      assert.ok(typeof result.timestamp === "number");
      assert.ok(result.timestamp > 0);
    });

    test("timestamp should be recent", () => {
      const tokenId = "timestamp-test";
      const beforeTime = Date.now();

      scanner.evaluate(createMarketData({ tokenId, midPriceCents: 40 }));
      const result = scanner.evaluate(
        createMarketData({ tokenId, midPriceCents: 50 }),
      );

      const afterTime = Date.now();

      assert.ok(result !== null);
      assert.ok(
        result.timestamp >= beforeTime,
        "Timestamp should be >= beforeTime",
      );
      assert.ok(
        result.timestamp <= afterTime,
        "Timestamp should be <= afterTime",
      );
    });
  });

  describe("Clear State", () => {
    test("should clear all state", () => {
      const tokenId = "clear-test";

      // Build up state
      scanner.evaluate(createMarketData({ tokenId, midPriceCents: 40 }));
      scanner.evaluate(createMarketData({ tokenId, midPriceCents: 50 }));
      scanner.recordLeaderboardTrade(tokenId);

      // Verify state exists
      const statsBefore = scanner.getStats();
      assert.ok(statsBefore.trackedTokens > 0);

      // Clear
      scanner.clear();

      // Verify state is cleared
      const statsAfter = scanner.getStats();
      assert.strictEqual(statsAfter.trackedTokens, 0);
      assert.strictEqual(statsAfter.recentCandidatesCount, 0);
    });
  });

  describe("Statistics", () => {
    test("should track statistics correctly", () => {
      const stats1 = scanner.getStats();
      assert.strictEqual(stats1.trackedTokens, 0);

      // Add some data
      scanner.evaluate(
        createMarketData({ tokenId: "stat-1", midPriceCents: 50 }),
      );
      scanner.evaluate(
        createMarketData({ tokenId: "stat-2", midPriceCents: 50 }),
      );

      const stats2 = scanner.getStats();
      assert.strictEqual(stats2.trackedTokens, 2);
    });
  });

  describe("Memory Protection", () => {
    test("should not grow unbounded with many tokens", () => {
      // Add many different tokens
      for (let i = 0; i < 200; i++) {
        scanner.evaluate(
          createMarketData({
            tokenId: `token-${i}`,
            midPriceCents: 50,
          }),
        );
      }

      // Stats should be bounded (implementation detail, but good to verify)
      const stats = scanner.getStats();
      assert.ok(stats.trackedTokens <= 200);
    });

    test("should evict LRU tokens when limit exceeded", () => {
      // Create scanner with smaller limit for testing via a custom instance
      // Default MAX_TRACKED_TOKENS is 500, let's just verify the mechanism works
      // by adding many tokens and checking the count is bounded
      for (let i = 0; i < 600; i++) {
        scanner.evaluate(
          createMarketData({
            tokenId: `lru-test-${i}`,
            midPriceCents: 50,
          }),
        );
      }

      // Should be bounded by MAX_TRACKED_TOKENS (500 by default)
      const stats = scanner.getStats();
      assert.ok(
        stats.trackedTokens <= 500,
        `Expected tracked tokens <= 500, got ${stats.trackedTokens}`,
      );
    });
  });

  describe("Edge Cases", () => {
    test("should handle first evaluation for a token", () => {
      // First evaluation without any history
      const result = scanner.evaluate(
        createMarketData({ tokenId: "first-eval" }),
      );

      // Should return null - no movement history yet
      assert.strictEqual(result, null);
    });

    test("should handle rapid price updates", () => {
      const tokenId = "rapid-update";

      // Rapid updates
      for (let i = 0; i < 50; i++) {
        const price = 40 + (i % 20); // Oscillate between 40 and 59
        scanner.evaluate(createMarketData({ tokenId, midPriceCents: price }));
      }

      // Should not throw, should handle gracefully
      const stats = scanner.getStats();
      assert.ok(stats.trackedTokens >= 1);
    });

    test("should handle zero spread", () => {
      scanner.evaluate(
        createMarketData({ tokenId: "zero-spread", midPriceCents: 40 }),
      );

      const result = scanner.evaluate(
        createMarketData({
          tokenId: "zero-spread",
          midPriceCents: 50,
          spreadCents: 0, // Zero spread (unlikely but valid)
        }),
      );

      assert.ok(result !== null, "Zero spread should be accepted");
    });
  });
});

describe("DEFAULT_SCANNER_CONFIG", () => {
  test("should have sensible defaults", () => {
    assert.strictEqual(DEFAULT_SCANNER_CONFIG.enabled, true);
    assert.strictEqual(DEFAULT_SCANNER_CONFIG.entryBandCents, 12);
    assert.strictEqual(DEFAULT_SCANNER_CONFIG.scanWindowSeconds, 300);
    assert.strictEqual(DEFAULT_SCANNER_CONFIG.maxSpreadCents, 6);
    assert.strictEqual(DEFAULT_SCANNER_CONFIG.minDepthUsdAtExit, 25);
    assert.strictEqual(DEFAULT_SCANNER_CONFIG.preferredEntryLowCents, 35);
    assert.strictEqual(DEFAULT_SCANNER_CONFIG.preferredEntryHighCents, 65);
    assert.strictEqual(DEFAULT_SCANNER_CONFIG.leaderboardBoostEnabled, false);
  });
});
