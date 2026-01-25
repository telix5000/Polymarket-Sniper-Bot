import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  validateOrderbookQuality,
  ORDERBOOK_QUALITY_THRESHOLDS,
  CIRCUIT_BREAKER_COOLDOWNS_MS,
  CIRCUIT_BREAKER_ESCALATION_WINDOW_MS,
  DUST_COOLDOWN_MS,
  type OrderbookQualityStatus,
  type OrderbookQualityResult,
} from "../../src/strategies/scalp-take-profit";
import {
  OrderbookQualityError,
  extractOrderbookPrices,
} from "../../src/utils/post-order.util";

// === ORDERBOOK PRICE EXTRACTION TESTS ===

describe("Orderbook Price Extraction", () => {
  describe("bestBid extraction", () => {
    test("should extract best bid from sorted bids array (descending)", () => {
      const result = extractOrderbookPrices({
        bids: [
          { price: "0.65", size: "100" },
          { price: "0.64", size: "200" },
          { price: "0.63", size: "150" },
        ],
        asks: [{ price: "0.66", size: "100" }],
      });

      assert.equal(result.bestBid, 0.65);
      assert.equal(result.bidCount, 3);
    });

    test("should find best bid even if array is not sorted", () => {
      // If API returns unsorted, we should still find the max
      const result = extractOrderbookPrices({
        bids: [
          { price: "0.63", size: "150" },
          { price: "0.65", size: "100" }, // Max is not first
          { price: "0.64", size: "200" },
        ],
        asks: [],
      });

      assert.equal(result.bestBid, 0.65);
    });

    test("should return null for empty bids array", () => {
      const result = extractOrderbookPrices({
        bids: [],
        asks: [{ price: "0.66", size: "100" }],
      });

      assert.equal(result.bestBid, null);
      assert.equal(result.bidCount, 0);
    });
  });

  describe("bestAsk extraction", () => {
    test("should extract best ask from sorted asks array (ascending)", () => {
      const result = extractOrderbookPrices({
        bids: [{ price: "0.64", size: "100" }],
        asks: [
          { price: "0.66", size: "100" },
          { price: "0.67", size: "200" },
          { price: "0.68", size: "150" },
        ],
      });

      assert.equal(result.bestAsk, 0.66);
      assert.equal(result.askCount, 3);
    });

    test("should find best ask even if array is not sorted", () => {
      // If API returns unsorted, we should still find the min
      const result = extractOrderbookPrices({
        bids: [],
        asks: [
          { price: "0.68", size: "150" },
          { price: "0.66", size: "100" }, // Min is not first
          { price: "0.67", size: "200" },
        ],
      });

      assert.equal(result.bestAsk, 0.66);
    });

    test("should return null for empty asks array", () => {
      const result = extractOrderbookPrices({
        bids: [{ price: "0.64", size: "100" }],
        asks: [],
      });

      assert.equal(result.bestAsk, null);
      assert.equal(result.askCount, 0);
    });
  });

  describe("anomaly detection", () => {
    test("should detect crossed book anomaly", () => {
      const result = extractOrderbookPrices({
        bids: [{ price: "0.70", size: "100" }],
        asks: [{ price: "0.65", size: "100" }],
      });

      assert.equal(result.hasAnomaly, true);
      assert.ok(result.anomalyReason?.includes("Crossed book"));
      assert.equal(result.bestBid, 0.7);
      assert.equal(result.bestAsk, 0.65);
    });

    test("should detect extreme spread anomaly", () => {
      const result = extractOrderbookPrices({
        bids: [{ price: "0.01", size: "100" }],
        asks: [{ price: "0.99", size: "100" }],
      });

      assert.equal(result.hasAnomaly, true);
      assert.ok(result.anomalyReason?.includes("Extreme spread"));
    });

    test("should not flag normal spread as anomaly", () => {
      const result = extractOrderbookPrices({
        bids: [{ price: "0.64", size: "100" }],
        asks: [{ price: "0.66", size: "100" }],
      });

      assert.equal(result.hasAnomaly, false);
      assert.equal(result.anomalyReason, undefined);
    });
  });

  describe("edge cases", () => {
    test("should handle undefined bids/asks gracefully", () => {
      const result = extractOrderbookPrices({});

      assert.equal(result.bestBid, null);
      assert.equal(result.bestAsk, null);
      assert.equal(result.bidCount, 0);
      assert.equal(result.askCount, 0);
      assert.equal(result.hasAnomaly, false);
    });

    test("should handle single bid/ask", () => {
      const result = extractOrderbookPrices({
        bids: [{ price: "0.50", size: "100" }],
        asks: [{ price: "0.51", size: "100" }],
      });

      assert.equal(result.bestBid, 0.5);
      assert.equal(result.bestAsk, 0.51);
      assert.equal(result.bidCount, 1);
      assert.equal(result.askCount, 1);
    });

    test("should handle large orderbook (>5 levels)", () => {
      const bids = Array.from({ length: 20 }, (_, i) => ({
        price: (0.5 - i * 0.01).toFixed(2),
        size: "100",
      }));
      // Insert a higher bid at position 15 to test full scan
      bids[15] = { price: "0.55", size: "100" };

      const result = extractOrderbookPrices({ bids, asks: [] });

      // Should find 0.55 as best bid even though it's deep in the array
      assert.equal(result.bestBid, 0.55);
      assert.equal(result.bidCount, 20);
    });
  });
});

// === ORDERBOOK QUALITY VALIDATION TESTS ===

describe("Orderbook Quality Validation", () => {
  describe("INVALID_BOOK detection", () => {
    test("bestBid=0.01, bestAsk=0.99 => INVALID_BOOK (extreme spread)", () => {
      const result = validateOrderbookQuality(0.01, 0.99);

      assert.equal(result.status, "INVALID_BOOK");
      assert.ok(result.reason?.includes("Extreme spread"));
      assert.ok(result.reason?.includes("bestBid=1.0¢"));
      assert.ok(result.reason?.includes("bestAsk=99.0¢"));
    });

    test("bestBid=0.01, bestAsk=0.99 with dataApiPrice=0.62 => INVALID_BOOK", () => {
      // Even with data API price showing 62¢, the extreme spread indicates corrupted book
      const result = validateOrderbookQuality(0.01, 0.99, 0.62);

      assert.equal(result.status, "INVALID_BOOK");
      assert.ok(result.diagnostics?.bestBid === 0.01);
      assert.ok(result.diagnostics?.bestAsk === 0.99);
      assert.ok(result.diagnostics?.dataApiPrice === 0.62);
    });

    test("bestBid=0.04, bestAsk=0.96 => INVALID_BOOK (below/above thresholds)", () => {
      // Both conditions met: bid < 5¢ AND ask > 95¢
      const result = validateOrderbookQuality(0.04, 0.96);

      assert.equal(result.status, "INVALID_BOOK");
    });

    test("bestBid=0.05, bestAsk=0.96 => VALID (bid at threshold)", () => {
      // bid = 5¢ (at threshold, not below), ask > 95¢
      // Does not meet BOTH conditions, so not INVALID_BOOK
      const result = validateOrderbookQuality(0.05, 0.96);

      assert.equal(result.status, "VALID");
    });

    test("bestBid=0.04, bestAsk=0.95 => VALID (ask at threshold)", () => {
      // bid < 5¢, ask = 95¢ (at threshold, not above)
      // Does not meet BOTH conditions, so not INVALID_BOOK
      const result = validateOrderbookQuality(0.04, 0.95);

      assert.equal(result.status, "VALID");
    });
  });

  describe("EXEC_PRICE_UNTRUSTED detection", () => {
    test("dataApiPrice=0.62, bestBid=0.01 => EXEC_PRICE_UNTRUSTED (deviation > 30¢)", () => {
      // This scenario: Data-API says position is at 62¢, but CLOB shows bestBid=1¢
      // This 61¢ deviation is clearly untrusted
      // Note: This test doesn't trigger INVALID_BOOK because bestAsk is null
      const result = validateOrderbookQuality(0.01, null, 0.62);

      assert.equal(result.status, "EXEC_PRICE_UNTRUSTED");
      assert.ok(result.reason?.includes("deviates from dataApiPrice"));
      assert.ok(result.diagnostics?.priceDeviation !== undefined);
      assert.ok(result.diagnostics!.priceDeviation! > 0.3);
    });

    test("dataApiPrice=0.60, bestBid=0.25 => EXEC_PRICE_UNTRUSTED (35¢ deviation)", () => {
      const result = validateOrderbookQuality(0.25, 0.3, 0.6);

      assert.equal(result.status, "EXEC_PRICE_UNTRUSTED");
      assert.ok(Math.abs(result.diagnostics!.priceDeviation! - 0.35) < 0.001);
    });

    test("dataApiPrice=0.60, bestBid=0.35 => VALID (25¢ deviation, within threshold)", () => {
      const result = validateOrderbookQuality(0.35, 0.4, 0.6);

      assert.equal(result.status, "VALID");
    });

    test("dataApiPrice=0.62, bestBid=0.62 => VALID (no deviation)", () => {
      const result = validateOrderbookQuality(0.62, 0.64, 0.62);

      assert.equal(result.status, "VALID");
      assert.equal(result.diagnostics?.priceDeviation, 0);
    });
  });

  describe("NO_EXECUTION_PRICE detection", () => {
    test("bestBid=null => NO_EXECUTION_PRICE", () => {
      const result = validateOrderbookQuality(null, 0.65);

      assert.equal(result.status, "NO_EXECUTION_PRICE");
      assert.ok(result.reason?.includes("No bestBid available"));
    });

    test("bestBid=0 => NO_EXECUTION_PRICE", () => {
      const result = validateOrderbookQuality(0, 0.65);

      assert.equal(result.status, "NO_EXECUTION_PRICE");
    });
  });

  describe("VALID orderbook", () => {
    test("normal book bestBid=0.63, bestAsk=0.64 => VALID", () => {
      const result = validateOrderbookQuality(0.63, 0.64);

      assert.equal(result.status, "VALID");
    });

    test("normal book with dataApiPrice matching => VALID", () => {
      const result = validateOrderbookQuality(0.63, 0.65, 0.64);

      assert.equal(result.status, "VALID");
    });

    test("wide spread but not extreme: bestBid=0.30, bestAsk=0.70 => VALID", () => {
      // 40¢ spread is wide but doesn't trigger INVALID_BOOK
      // (bid not < 5¢, ask not > 95¢)
      const result = validateOrderbookQuality(0.3, 0.7);

      assert.equal(result.status, "VALID");
    });

    test("low bid only (no extreme ask): bestBid=0.02, bestAsk=0.10 => VALID", () => {
      // Low bid but ask is also low, not INVALID_BOOK
      const result = validateOrderbookQuality(0.02, 0.1);

      assert.equal(result.status, "VALID");
    });

    test("high ask only (no extreme bid): bestBid=0.90, bestAsk=0.98 => VALID", () => {
      // High ask but bid is also high, not INVALID_BOOK
      const result = validateOrderbookQuality(0.9, 0.98);

      assert.equal(result.status, "VALID");
    });
  });
});

// === THRESHOLD CONSTANTS TESTS ===

describe("Orderbook Quality Thresholds", () => {
  test("INVALID_BID_THRESHOLD is 0.05 (5¢)", () => {
    assert.equal(ORDERBOOK_QUALITY_THRESHOLDS.INVALID_BID_THRESHOLD, 0.05);
  });

  test("INVALID_ASK_THRESHOLD is 0.95 (95¢)", () => {
    assert.equal(ORDERBOOK_QUALITY_THRESHOLDS.INVALID_ASK_THRESHOLD, 0.95);
  });

  test("MAX_PRICE_DEVIATION is 0.30 (30¢)", () => {
    assert.equal(ORDERBOOK_QUALITY_THRESHOLDS.MAX_PRICE_DEVIATION, 0.3);
  });
});

// === CIRCUIT BREAKER COOLDOWN TESTS ===

describe("Circuit Breaker Cooldowns", () => {
  test("cooldown escalation ladder: 1m -> 5m -> 15m -> 60m", () => {
    assert.equal(CIRCUIT_BREAKER_COOLDOWNS_MS.length, 4);
    assert.equal(CIRCUIT_BREAKER_COOLDOWNS_MS[0], 60_000); // 1 minute
    assert.equal(CIRCUIT_BREAKER_COOLDOWNS_MS[1], 300_000); // 5 minutes
    assert.equal(CIRCUIT_BREAKER_COOLDOWNS_MS[2], 900_000); // 15 minutes
    assert.equal(CIRCUIT_BREAKER_COOLDOWNS_MS[3], 3_600_000); // 60 minutes
  });

  test("first failure gets 1 minute cooldown", () => {
    const failureCount = 1;
    const cooldownMs =
      CIRCUIT_BREAKER_COOLDOWNS_MS[
        Math.min(failureCount - 1, CIRCUIT_BREAKER_COOLDOWNS_MS.length - 1)
      ];
    assert.equal(cooldownMs, 60_000);
  });

  test("second failure gets 5 minute cooldown", () => {
    const failureCount = 2;
    const cooldownMs =
      CIRCUIT_BREAKER_COOLDOWNS_MS[
        Math.min(failureCount - 1, CIRCUIT_BREAKER_COOLDOWNS_MS.length - 1)
      ];
    assert.equal(cooldownMs, 300_000);
  });

  test("third failure gets 15 minute cooldown", () => {
    const failureCount = 3;
    const cooldownMs =
      CIRCUIT_BREAKER_COOLDOWNS_MS[
        Math.min(failureCount - 1, CIRCUIT_BREAKER_COOLDOWNS_MS.length - 1)
      ];
    assert.equal(cooldownMs, 900_000);
  });

  test("fourth+ failure gets 60 minute cooldown (max)", () => {
    const failureCount = 4;
    const cooldownMs =
      CIRCUIT_BREAKER_COOLDOWNS_MS[
        Math.min(failureCount - 1, CIRCUIT_BREAKER_COOLDOWNS_MS.length - 1)
      ];
    assert.equal(cooldownMs, 3_600_000);

    // Higher failure counts still get max
    const failureCount10 = 10;
    const cooldownMs10 =
      CIRCUIT_BREAKER_COOLDOWNS_MS[
        Math.min(failureCount10 - 1, CIRCUIT_BREAKER_COOLDOWNS_MS.length - 1)
      ];
    assert.equal(cooldownMs10, 3_600_000);
  });

  test("escalation window is 2 hours", () => {
    // Consecutive failures within this window will escalate cooldown
    assert.equal(CIRCUIT_BREAKER_ESCALATION_WINDOW_MS, 7_200_000); // 2 hours
  });
});

// === DUST COOLDOWN TESTS ===

describe("Dust Cooldown", () => {
  test("DUST_COOLDOWN_MS is 10 minutes", () => {
    assert.equal(DUST_COOLDOWN_MS, 600_000);
  });
});

// === EDGE CASE TESTS ===

describe("Edge Cases", () => {
  test("bestAsk=null with valid bestBid => VALID (no INVALID_BOOK check possible)", () => {
    const result = validateOrderbookQuality(0.5, null);
    assert.equal(result.status, "VALID");
  });

  test("bestAsk=0 with valid bestBid => VALID (zero ask treated as no ask)", () => {
    const result = validateOrderbookQuality(0.5, 0);
    assert.equal(result.status, "VALID");
  });

  test("dataApiPrice=0 is ignored for deviation check", () => {
    const result = validateOrderbookQuality(0.5, 0.55, 0);
    assert.equal(result.status, "VALID");
  });

  test("dataApiPrice=undefined skips deviation check", () => {
    const result = validateOrderbookQuality(0.01, 0.1, undefined);
    // bestBid=1¢ with no dataApiPrice for comparison
    // Not INVALID_BOOK (ask not > 95¢), not EXEC_PRICE_UNTRUSTED (no reference)
    assert.equal(result.status, "VALID");
  });
});

// === ORDERBOOK QUALITY ERROR CLASS TESTS ===

describe("OrderbookQualityError", () => {
  test("should be an instance of Error", () => {
    const qualityResult: OrderbookQualityResult = {
      status: "INVALID_BOOK",
      reason: "Extreme spread",
      diagnostics: {
        bestBid: 0.01,
        bestAsk: 0.99,
      },
    };

    const error = new OrderbookQualityError(
      "Test error message",
      qualityResult,
      "test-token-id",
    );

    assert.ok(error instanceof Error);
    assert.ok(error instanceof OrderbookQualityError);
  });

  test("should store quality result and tokenId", () => {
    const qualityResult: OrderbookQualityResult = {
      status: "INVALID_BOOK",
      reason: "Wide spread: bid=1.0¢ ask=99.0¢",
      diagnostics: {
        bestBid: 0.01,
        bestAsk: 0.99,
        dataApiPrice: 0.62,
      },
    };

    const tokenId = "0x1234567890abcdef";
    const error = new OrderbookQualityError(
      "Orderbook quality error",
      qualityResult,
      tokenId,
    );

    assert.equal(error.qualityResult, qualityResult);
    assert.equal(error.tokenId, tokenId);
    assert.equal(error.qualityResult.status, "INVALID_BOOK");
    assert.equal(error.name, "OrderbookQualityError");
  });

  test("should have correct message", () => {
    const qualityResult: OrderbookQualityResult = {
      status: "EXEC_PRICE_UNTRUSTED",
      reason: "Price deviation too large",
      diagnostics: {
        bestBid: 0.25,
        bestAsk: 0.3,
        dataApiPrice: 0.6,
        priceDeviation: 0.35,
      },
    };

    const message = "CLOB orderbook quality failure: EXEC_PRICE_UNTRUSTED";
    const error = new OrderbookQualityError(message, qualityResult, "token123");

    assert.equal(error.message, message);
  });

  test("can be used with instanceof for error handling", () => {
    const qualityResult: OrderbookQualityResult = {
      status: "NO_EXECUTION_PRICE",
      reason: "No bestBid available from orderbook",
      diagnostics: {
        bestBid: null,
        bestAsk: 0.65,
      },
    };

    const error = new OrderbookQualityError(
      "No bid",
      qualityResult,
      "token456",
    );

    // Simulate catch block usage
    try {
      throw error;
    } catch (err) {
      if (err instanceof OrderbookQualityError) {
        assert.equal(err.qualityResult.status, "NO_EXECUTION_PRICE");
        assert.equal(err.tokenId, "token456");
      } else {
        assert.fail("Should have caught OrderbookQualityError");
      }
    }
  });
});

// === CROSSED BOOK DETECTION TESTS ===

describe("Crossed Book Detection", () => {
  test("bestBid > bestAsk => INVALID_BOOK (impossible state)", () => {
    // This should never happen in a valid orderbook
    const result = validateOrderbookQuality(0.65, 0.6);

    assert.equal(result.status, "INVALID_BOOK");
    assert.ok(result.reason?.includes("Crossed book"));
    assert.ok(result.reason?.includes("bestBid=65.0¢"));
    assert.ok(result.reason?.includes("bestAsk=60.0¢"));
  });

  test("bestBid = bestAsk => VALID (locked book is acceptable)", () => {
    // A locked book (bid == ask) is valid, just means no spread
    const result = validateOrderbookQuality(0.65, 0.65);

    assert.equal(result.status, "VALID");
  });

  test("crossed book detected before extreme spread check", () => {
    // Even at extreme prices, crossed book should be caught first
    const result = validateOrderbookQuality(0.99, 0.01);

    assert.equal(result.status, "INVALID_BOOK");
    assert.ok(result.reason?.includes("Crossed book"));
  });
});
