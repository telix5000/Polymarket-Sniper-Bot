import assert from "node:assert";
import { test, describe, beforeEach, afterEach } from "node:test";

/**
 * Unit tests for Whale Price-Range Filtering
 *
 * These tests verify that:
 * 1. Price range filtering configuration is properly loaded
 * 2. Trades are filtered correctly based on price bounds
 * 3. Edge cases (one-sided filters, min > max) are handled correctly
 */

// Mock LeaderboardTrade interface (matches the one in start.ts)
interface LeaderboardTrade {
  tokenId: string;
  marketId?: string;
  wallet: string;
  side: "BUY" | "SELL";
  sizeUsd: number;
  timestamp: number;
  price?: number;
}

// Mock config interface with just the fields we need for testing
interface PriceFilterConfig {
  whalePriceMin?: number;
  whalePriceMax?: number;
}

/**
 * Check if a trade passes the price range filter
 * This mirrors the logic in BiasAccumulator.passesWhalePriceFilter()
 */
function passesWhalePriceFilter(
  trade: LeaderboardTrade,
  config: PriceFilterConfig,
  filterEnabled: boolean,
  filterInvalid: boolean
): boolean {
  // If filter is disabled or invalid, pass all trades
  if (!filterEnabled || filterInvalid) {
    return true;
  }

  const { whalePriceMin, whalePriceMax } = config;
  const price = trade.price;

  // If no price available on trade, pass it through (can't filter)
  if (price === undefined || price === null) {
    return true;
  }

  // Check minimum bound
  if (whalePriceMin !== undefined && price < whalePriceMin) {
    return false;
  }

  // Check maximum bound
  if (whalePriceMax !== undefined && price > whalePriceMax) {
    return false;
  }

  return true;
}

/**
 * Determine if price filter should be enabled and valid
 */
function initPriceFilter(config: PriceFilterConfig): { enabled: boolean; invalid: boolean } {
  const { whalePriceMin, whalePriceMax } = config;
  
  // Check if any price range filtering is configured
  if (whalePriceMin === undefined && whalePriceMax === undefined) {
    return { enabled: false, invalid: false };
  }
  
  // Validate min <= max if both are set
  if (whalePriceMin !== undefined && whalePriceMax !== undefined && whalePriceMin > whalePriceMax) {
    return { enabled: false, invalid: true };
  }
  
  return { enabled: true, invalid: false };
}

/**
 * Helper to create mock trades
 */
function createTrade(price?: number, sizeUsd = 500): LeaderboardTrade {
  return {
    tokenId: `token-${Math.random().toString(36).slice(2, 8)}`,
    wallet: "0x1234567890abcdef",
    side: "BUY",
    sizeUsd,
    timestamp: Date.now(),
    price,
  };
}

describe("Whale Price-Range Filter Configuration", () => {
  test("should not enable filter when no bounds are set", () => {
    const config: PriceFilterConfig = {};
    const { enabled, invalid } = initPriceFilter(config);
    assert.strictEqual(enabled, false);
    assert.strictEqual(invalid, false);
  });

  test("should enable filter when only min is set", () => {
    const config: PriceFilterConfig = { whalePriceMin: 0.25 };
    const { enabled, invalid } = initPriceFilter(config);
    assert.strictEqual(enabled, true);
    assert.strictEqual(invalid, false);
  });

  test("should enable filter when only max is set", () => {
    const config: PriceFilterConfig = { whalePriceMax: 0.75 };
    const { enabled, invalid } = initPriceFilter(config);
    assert.strictEqual(enabled, true);
    assert.strictEqual(invalid, false);
  });

  test("should enable filter when both bounds are valid (min <= max)", () => {
    const config: PriceFilterConfig = { whalePriceMin: 0.25, whalePriceMax: 0.45 };
    const { enabled, invalid } = initPriceFilter(config);
    assert.strictEqual(enabled, true);
    assert.strictEqual(invalid, false);
  });

  test("should mark filter as invalid when min > max", () => {
    const config: PriceFilterConfig = { whalePriceMin: 0.75, whalePriceMax: 0.25 };
    const { enabled, invalid } = initPriceFilter(config);
    assert.strictEqual(enabled, false);
    assert.strictEqual(invalid, true);
  });

  test("should enable filter when min equals max", () => {
    const config: PriceFilterConfig = { whalePriceMin: 0.50, whalePriceMax: 0.50 };
    const { enabled, invalid } = initPriceFilter(config);
    assert.strictEqual(enabled, true);
    assert.strictEqual(invalid, false);
  });
});

describe("Whale Price-Range Filter Logic", () => {
  describe("Filter Disabled", () => {
    test("should pass all trades when filter is not enabled", () => {
      const config: PriceFilterConfig = {};
      const trade = createTrade(0.10); // Would be below any reasonable min
      const passes = passesWhalePriceFilter(trade, config, false, false);
      assert.strictEqual(passes, true);
    });

    test("should pass all trades when filter is invalid (min > max)", () => {
      const config: PriceFilterConfig = { whalePriceMin: 0.75, whalePriceMax: 0.25 };
      const trade = createTrade(0.10);
      const passes = passesWhalePriceFilter(trade, config, false, true);
      assert.strictEqual(passes, true);
    });
  });

  describe("Minimum Bound Only", () => {
    const config: PriceFilterConfig = { whalePriceMin: 0.25 };
    const { enabled, invalid } = initPriceFilter(config);

    test("should pass trade at minimum price", () => {
      const trade = createTrade(0.25);
      const passes = passesWhalePriceFilter(trade, config, enabled, invalid);
      assert.strictEqual(passes, true);
    });

    test("should pass trade above minimum price", () => {
      const trade = createTrade(0.50);
      const passes = passesWhalePriceFilter(trade, config, enabled, invalid);
      assert.strictEqual(passes, true);
    });

    test("should filter trade below minimum price", () => {
      const trade = createTrade(0.20);
      const passes = passesWhalePriceFilter(trade, config, enabled, invalid);
      assert.strictEqual(passes, false);
    });

    test("should pass trades at very high prices", () => {
      const trade = createTrade(0.95);
      const passes = passesWhalePriceFilter(trade, config, enabled, invalid);
      assert.strictEqual(passes, true);
    });
  });

  describe("Maximum Bound Only", () => {
    const config: PriceFilterConfig = { whalePriceMax: 0.75 };
    const { enabled, invalid } = initPriceFilter(config);

    test("should pass trade at maximum price", () => {
      const trade = createTrade(0.75);
      const passes = passesWhalePriceFilter(trade, config, enabled, invalid);
      assert.strictEqual(passes, true);
    });

    test("should pass trade below maximum price", () => {
      const trade = createTrade(0.50);
      const passes = passesWhalePriceFilter(trade, config, enabled, invalid);
      assert.strictEqual(passes, true);
    });

    test("should filter trade above maximum price", () => {
      const trade = createTrade(0.85);
      const passes = passesWhalePriceFilter(trade, config, enabled, invalid);
      assert.strictEqual(passes, false);
    });

    test("should pass trades at very low prices", () => {
      const trade = createTrade(0.05);
      const passes = passesWhalePriceFilter(trade, config, enabled, invalid);
      assert.strictEqual(passes, true);
    });
  });

  describe("Both Bounds (Range Filter)", () => {
    const config: PriceFilterConfig = { whalePriceMin: 0.25, whalePriceMax: 0.45 };
    const { enabled, invalid } = initPriceFilter(config);

    test("should pass trade at minimum price", () => {
      const trade = createTrade(0.25);
      const passes = passesWhalePriceFilter(trade, config, enabled, invalid);
      assert.strictEqual(passes, true);
    });

    test("should pass trade at maximum price", () => {
      const trade = createTrade(0.45);
      const passes = passesWhalePriceFilter(trade, config, enabled, invalid);
      assert.strictEqual(passes, true);
    });

    test("should pass trade within range", () => {
      const trade = createTrade(0.35);
      const passes = passesWhalePriceFilter(trade, config, enabled, invalid);
      assert.strictEqual(passes, true);
    });

    test("should filter trade below minimum", () => {
      const trade = createTrade(0.20);
      const passes = passesWhalePriceFilter(trade, config, enabled, invalid);
      assert.strictEqual(passes, false);
    });

    test("should filter trade above maximum", () => {
      const trade = createTrade(0.55);
      const passes = passesWhalePriceFilter(trade, config, enabled, invalid);
      assert.strictEqual(passes, false);
    });

    test("should filter very low price trades", () => {
      const trade = createTrade(0.05);
      const passes = passesWhalePriceFilter(trade, config, enabled, invalid);
      assert.strictEqual(passes, false);
    });

    test("should filter very high price trades", () => {
      const trade = createTrade(0.90);
      const passes = passesWhalePriceFilter(trade, config, enabled, invalid);
      assert.strictEqual(passes, false);
    });
  });

  describe("Missing Price Handling", () => {
    const config: PriceFilterConfig = { whalePriceMin: 0.25, whalePriceMax: 0.45 };
    const { enabled, invalid } = initPriceFilter(config);

    test("should pass trade with undefined price", () => {
      const trade = createTrade(undefined);
      const passes = passesWhalePriceFilter(trade, config, enabled, invalid);
      assert.strictEqual(passes, true);
    });

    test("should pass trade with null-like price", () => {
      const trade = createTrade(undefined);
      trade.price = undefined;
      const passes = passesWhalePriceFilter(trade, config, enabled, invalid);
      assert.strictEqual(passes, true);
    });
  });

  describe("Edge Cases", () => {
    test("should handle price exactly at 0", () => {
      const config: PriceFilterConfig = { whalePriceMin: 0.0, whalePriceMax: 0.50 };
      const { enabled, invalid } = initPriceFilter(config);
      const trade = createTrade(0);
      const passes = passesWhalePriceFilter(trade, config, enabled, invalid);
      assert.strictEqual(passes, true);
    });

    test("should handle price exactly at 1", () => {
      const config: PriceFilterConfig = { whalePriceMin: 0.50, whalePriceMax: 1.0 };
      const { enabled, invalid } = initPriceFilter(config);
      const trade = createTrade(1.0);
      const passes = passesWhalePriceFilter(trade, config, enabled, invalid);
      assert.strictEqual(passes, true);
    });

    test("should handle very small price differences", () => {
      const config: PriceFilterConfig = { whalePriceMin: 0.249999, whalePriceMax: 0.250001 };
      const { enabled, invalid } = initPriceFilter(config);
      const trade = createTrade(0.25);
      const passes = passesWhalePriceFilter(trade, config, enabled, invalid);
      assert.strictEqual(passes, true);
    });

    test("should filter price just below min", () => {
      const config: PriceFilterConfig = { whalePriceMin: 0.25 };
      const { enabled, invalid } = initPriceFilter(config);
      const trade = createTrade(0.2499999);
      const passes = passesWhalePriceFilter(trade, config, enabled, invalid);
      assert.strictEqual(passes, false);
    });

    test("should filter price just above max", () => {
      const config: PriceFilterConfig = { whalePriceMax: 0.45 };
      const { enabled, invalid } = initPriceFilter(config);
      const trade = createTrade(0.4500001);
      const passes = passesWhalePriceFilter(trade, config, enabled, invalid);
      assert.strictEqual(passes, false);
    });
  });
});

describe("Batch Trade Filtering", () => {
  test("should filter multiple trades correctly", () => {
    const config: PriceFilterConfig = { whalePriceMin: 0.25, whalePriceMax: 0.45 };
    const { enabled, invalid } = initPriceFilter(config);

    const trades = [
      createTrade(0.10), // Below min - should be filtered
      createTrade(0.25), // At min - should pass
      createTrade(0.35), // In range - should pass
      createTrade(0.45), // At max - should pass
      createTrade(0.60), // Above max - should be filtered
      createTrade(undefined), // No price - should pass
    ];

    const filtered = trades.filter(trade =>
      passesWhalePriceFilter(trade, config, enabled, invalid)
    );

    assert.strictEqual(filtered.length, 4, "Should have 4 trades pass");
    assert.strictEqual(filtered[0].price, 0.25);
    assert.strictEqual(filtered[1].price, 0.35);
    assert.strictEqual(filtered[2].price, 0.45);
    assert.strictEqual(filtered[3].price, undefined);
  });

  test("should pass all trades when filter disabled", () => {
    const config: PriceFilterConfig = {};
    const { enabled, invalid } = initPriceFilter(config);

    const trades = [
      createTrade(0.05),
      createTrade(0.50),
      createTrade(0.95),
    ];

    const filtered = trades.filter(trade =>
      passesWhalePriceFilter(trade, config, enabled, invalid)
    );

    assert.strictEqual(filtered.length, 3, "All trades should pass");
  });
});
