/**
 * Tests for price safety module
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  clampPrice,
  isLiquidOrderbook,
  isDustBook,
  isDeadBook,
  isEmptyBook,
  checkBookHealth,
  DEAD_BOOK_THRESHOLDS,
  calculateSafeLimitPrice,
  isWithinEntryBounds,
  MIN_PRICE,
  MAX_PRICE,
} from "../../../src/lib/price-safety";

describe("Price Safety Module", () => {
  describe("clampPrice", () => {
    it("should clamp prices above MAX_PRICE to MAX_PRICE", () => {
      // 1.0 should be clamped to MAX_PRICE (0.99)
      assert.strictEqual(clampPrice(1.0), MAX_PRICE);
      assert.strictEqual(clampPrice(1.5), MAX_PRICE);
      // 0.999 is greater than MAX_PRICE (0.99), so it should also be clamped
      assert.strictEqual(clampPrice(0.999), MAX_PRICE);
    });

    it("should clamp prices below MIN_PRICE to MIN_PRICE", () => {
      assert.strictEqual(clampPrice(0), MIN_PRICE);
      assert.strictEqual(clampPrice(0.005), MIN_PRICE);
      assert.strictEqual(clampPrice(-0.1), MIN_PRICE);
    });

    it("should not clamp prices within valid range", () => {
      assert.strictEqual(clampPrice(0.5), 0.5);
      assert.strictEqual(clampPrice(0.35), 0.35);
      assert.strictEqual(clampPrice(0.65), 0.65);
    });

    it("should support custom min/max bounds", () => {
      assert.strictEqual(clampPrice(0.3, 0.35, 0.65), 0.35);
      assert.strictEqual(clampPrice(0.7, 0.35, 0.65), 0.65);
      assert.strictEqual(clampPrice(0.5, 0.35, 0.65), 0.5);
    });
  });

  describe("isLiquidOrderbook", () => {
    it("should return true for liquid orderbook", () => {
      const orderbook = {
        bestBid: 0.49,
        bestAsk: 0.51,
        bidDepthUsd: 100,
        askDepthUsd: 100,
      };
      assert.strictEqual(isLiquidOrderbook(orderbook), true);
    });

    it("should return false for spread > maxSpreadCents", () => {
      const orderbook = {
        bestBid: 0.2,
        bestAsk: 0.8, // 60¢ spread
      };
      assert.strictEqual(isLiquidOrderbook(orderbook, 50), false);
    });

    it("should return false for invalid prices", () => {
      assert.strictEqual(
        isLiquidOrderbook({ bestBid: 0, bestAsk: 0.5 }),
        false,
      );
      assert.strictEqual(
        isLiquidOrderbook({ bestBid: 0.5, bestAsk: 0 }),
        false,
      );
      assert.strictEqual(
        isLiquidOrderbook({ bestBid: -0.1, bestAsk: 0.5 }),
        false,
      );
    });

    it("should return false for insufficient depth", () => {
      const orderbook = {
        bestBid: 0.49,
        bestAsk: 0.51,
        bidDepthUsd: 5, // Too low
        askDepthUsd: 100,
      };
      assert.strictEqual(isLiquidOrderbook(orderbook, 50, 10), false);
    });
  });

  describe("isDustBook", () => {
    it("should return true for dust book (bid<=2¢, ask>=98¢)", () => {
      assert.strictEqual(isDustBook({ bestBid: 0.01, bestAsk: 0.99 }), true);
      assert.strictEqual(isDustBook({ bestBid: 0.02, bestAsk: 0.98 }), true);
    });

    it("should return false for normal orderbooks", () => {
      assert.strictEqual(isDustBook({ bestBid: 0.49, bestAsk: 0.51 }), false);
      assert.strictEqual(isDustBook({ bestBid: 0.1, bestAsk: 0.9 }), false);
    });

    it("should return false when only one side is dust", () => {
      assert.strictEqual(isDustBook({ bestBid: 0.01, bestAsk: 0.5 }), false);
      assert.strictEqual(isDustBook({ bestBid: 0.5, bestAsk: 0.99 }), false);
    });
  });

  describe("isDeadBook", () => {
    it("should return true for dead book (bid<=2¢, ask>=98¢)", () => {
      // Classic dead book scenario (0.01/0.99)
      assert.strictEqual(isDeadBook(0.01, 0.99), true);
      // Boundary case
      assert.strictEqual(isDeadBook(0.02, 0.98), true);
    });

    it("should return false for normal orderbooks", () => {
      assert.strictEqual(isDeadBook(0.49, 0.51), false);
      assert.strictEqual(isDeadBook(0.1, 0.9), false);
      assert.strictEqual(isDeadBook(0.3, 0.7), false);
    });

    it("should return false when only one side is at extreme", () => {
      assert.strictEqual(isDeadBook(0.01, 0.5), false);
      assert.strictEqual(isDeadBook(0.5, 0.99), false);
    });

    it("should support custom thresholds", () => {
      // With custom thresholds (3¢, 97¢)
      assert.strictEqual(isDeadBook(0.02, 0.98, 3, 97), true);
      assert.strictEqual(isDeadBook(0.03, 0.97, 3, 97), true);
      assert.strictEqual(isDeadBook(0.04, 0.96, 3, 97), false);
    });

    it("should have same behavior as isDustBook for standard thresholds", () => {
      // Both functions use same 2¢/98¢ thresholds
      const testCases = [
        { bid: 0.01, ask: 0.99 },
        { bid: 0.02, ask: 0.98 },
        { bid: 0.49, ask: 0.51 },
        { bid: 0.1, ask: 0.9 },
      ];
      for (const tc of testCases) {
        const dustResult = isDustBook({ bestBid: tc.bid, bestAsk: tc.ask });
        const deadResult = isDeadBook(tc.bid, tc.ask);
        assert.strictEqual(
          dustResult,
          deadResult,
          `Mismatch for bid=${tc.bid}, ask=${tc.ask}`,
        );
      }
    });
  });

  describe("isEmptyBook", () => {
    it("should return true for empty book (bid<=1¢, ask>=99¢)", () => {
      // Most extreme case
      assert.strictEqual(isEmptyBook(0.01, 0.99), true);
      assert.strictEqual(isEmptyBook(0.005, 0.995), true);
    });

    it("should return false for dead book that is not empty", () => {
      // This is dead (2¢/98¢) but not empty (1¢/99¢)
      assert.strictEqual(isEmptyBook(0.02, 0.98), false);
    });

    it("should return false for normal orderbooks", () => {
      assert.strictEqual(isEmptyBook(0.49, 0.51), false);
      assert.strictEqual(isEmptyBook(0.1, 0.9), false);
    });
  });

  describe("checkBookHealth", () => {
    it("should classify healthy book correctly", () => {
      const result = checkBookHealth(0.49, 0.51);
      assert.strictEqual(result.status, "HEALTHY");
      assert.strictEqual(result.healthy, true);
      assert.strictEqual(result.reason, undefined);
    });

    it("should classify dead book correctly", () => {
      const result = checkBookHealth(0.02, 0.98);
      assert.strictEqual(result.status, "DEAD_BOOK");
      assert.strictEqual(result.healthy, false);
      assert.ok(result.reason?.includes("Dead book"));
    });

    it("should classify empty book correctly (prioritized over dead)", () => {
      // Empty book (1¢/99¢) should be classified as EMPTY_BOOK, not DEAD_BOOK
      const result = checkBookHealth(0.01, 0.99);
      assert.strictEqual(result.status, "EMPTY_BOOK");
      assert.strictEqual(result.healthy, false);
      assert.ok(result.reason?.includes("Empty book"));
    });

    it("should return correct cents values", () => {
      const result = checkBookHealth(0.45, 0.55);
      assert.strictEqual(result.bestBidCents, 45);
      // Use approximate comparison for floating point
      assert.ok(
        Math.abs(result.bestAskCents - 55) < 0.001,
        `Expected ~55, got ${result.bestAskCents}`,
      );
      assert.ok(
        Math.abs(result.spreadCents - 10) < 0.001,
        `Expected ~10, got ${result.spreadCents}`,
      );
    });

    it("should support custom thresholds", () => {
      // With looser thresholds, 3¢/97¢ is now considered dead
      const result = checkBookHealth(0.03, 0.97, {
        deadBidCents: 5,
        deadAskCents: 95,
      });
      assert.strictEqual(result.status, "DEAD_BOOK");
    });

    it("should use default thresholds from DEAD_BOOK_THRESHOLDS", () => {
      assert.strictEqual(DEAD_BOOK_THRESHOLDS.DEAD_BID_CENTS, 2);
      assert.strictEqual(DEAD_BOOK_THRESHOLDS.DEAD_ASK_CENTS, 98);
      assert.strictEqual(DEAD_BOOK_THRESHOLDS.EMPTY_BID_CENTS, 1);
      assert.strictEqual(DEAD_BOOK_THRESHOLDS.EMPTY_ASK_CENTS, 99);
    });
  });

  describe("calculateSafeLimitPrice", () => {
    it("should calculate BUY price with slippage clamped to MAX_PRICE", () => {
      const orderbook = {
        bestBid: 0.95,
        bestAsk: 0.98,
      };
      const result = calculateSafeLimitPrice(orderbook, {
        slippagePct: 5, // 5% slippage would push 0.98 to 1.029
        side: "BUY",
      });

      // Should be clamped to MAX_PRICE (0.99)
      assert.strictEqual(result.limitPrice, MAX_PRICE);
      assert.strictEqual(result.wasClamped, true);
      assert.strictEqual(result.clampDirection, "max");
      assert.strictEqual(result.rejectionReason, "PRICE_CLAMPED_TO_MAX");
    });

    it("should calculate BUY price without clamping when within bounds", () => {
      const orderbook = {
        bestBid: 0.49,
        bestAsk: 0.51,
      };
      const result = calculateSafeLimitPrice(orderbook, {
        slippagePct: 2, // 2% slippage → 0.51 * 1.02 = 0.5202
        side: "BUY",
      });

      assert.ok(result.limitPrice > 0.51 && result.limitPrice < 0.53);
      assert.strictEqual(result.wasClamped, false);
      assert.strictEqual(result.rejectionReason, undefined);
    });

    it("should calculate SELL price with slippage clamped to MIN_PRICE", () => {
      const orderbook = {
        bestBid: 0.02,
        bestAsk: 0.05,
      };
      const result = calculateSafeLimitPrice(orderbook, {
        slippagePct: 60, // 60% slippage would push 0.02 to 0.008
        side: "SELL",
      });

      // Should be clamped to MIN_PRICE (0.01)
      assert.strictEqual(result.limitPrice, MIN_PRICE);
      assert.strictEqual(result.wasClamped, true);
      assert.strictEqual(result.clampDirection, "min");
      assert.strictEqual(result.rejectionReason, "PRICE_CLAMPED_TO_MIN");
    });

    it("should reject SPREAD_TOO_WIDE for dust books", () => {
      const orderbook = {
        bestBid: 0.01,
        bestAsk: 0.99,
      };
      const result = calculateSafeLimitPrice(orderbook, {
        slippagePct: 2,
        side: "BUY",
      });

      assert.strictEqual(result.limitPrice, 0);
      assert.strictEqual(result.rejectionReason, "SPREAD_TOO_WIDE");
    });

    it("should reject SPREAD_TOO_WIDE for spreads exceeding max", () => {
      const orderbook = {
        bestBid: 0.2,
        bestAsk: 0.8, // 60¢ spread
      };
      const result = calculateSafeLimitPrice(orderbook, {
        slippagePct: 2,
        side: "BUY",
        maxSpreadCents: 50,
      });

      assert.strictEqual(result.limitPrice, 0);
      assert.strictEqual(result.rejectionReason, "SPREAD_TOO_WIDE");
    });

    it("should reject INVALID_ORDERBOOK for zero prices", () => {
      const orderbook = {
        bestBid: 0,
        bestAsk: 0.5,
      };
      const result = calculateSafeLimitPrice(orderbook, {
        slippagePct: 2,
        side: "BUY",
      });

      assert.strictEqual(result.limitPrice, 0);
      assert.strictEqual(result.rejectionReason, "INVALID_ORDERBOOK");
    });

    it("should use signal price when provided for BUY", () => {
      const orderbook = {
        bestBid: 0.49,
        bestAsk: 0.51,
      };
      const result = calculateSafeLimitPrice(orderbook, {
        slippagePct: 2,
        side: "BUY",
        signalPrice: 0.48, // Whale traded at 0.48
      });

      // With signal: min(0.48 * 1.02, 0.51) = min(0.4896, 0.51) = 0.4896
      assert.ok(result.limitPrice < 0.5);
      assert.strictEqual(result.diagnostics.method, "signal");
    });

    it("should use signal price when provided for SELL", () => {
      const orderbook = {
        bestBid: 0.49,
        bestAsk: 0.51,
      };
      const result = calculateSafeLimitPrice(orderbook, {
        slippagePct: 2,
        side: "SELL",
        signalPrice: 0.5,
      });

      // With signal: max(0.50 * 0.98, 0.49) = max(0.49, 0.49) = 0.49
      assert.ok(result.limitPrice >= 0.49);
      assert.strictEqual(result.diagnostics.method, "signal");
    });

    it("should include diagnostics with all relevant info", () => {
      const orderbook = {
        bestBid: 0.49,
        bestAsk: 0.51,
      };
      const result = calculateSafeLimitPrice(orderbook, {
        slippagePct: 2,
        side: "BUY",
      });

      assert.strictEqual(result.diagnostics.bestBid, 0.49);
      assert.strictEqual(result.diagnostics.bestAsk, 0.51);
      // Use approximate comparison for floating point spread calculation
      assert.ok(
        Math.abs(result.diagnostics.spreadCents - 2) < 0.001,
        `Expected spreadCents ~2, got ${result.diagnostics.spreadCents}`,
      );
      assert.strictEqual(result.diagnostics.slippagePct, 2);
      assert.strictEqual(result.diagnostics.side, "BUY");
      assert.ok(result.diagnostics.rawLimitPrice > 0);
      assert.ok(result.diagnostics.clampedLimitPrice > 0);
    });
  });

  describe("isWithinEntryBounds", () => {
    it("should return true for prices within bounds", () => {
      assert.strictEqual(isWithinEntryBounds(0.5, 35, 65), true);
      assert.strictEqual(isWithinEntryBounds(0.35, 35, 65), true);
      assert.strictEqual(isWithinEntryBounds(0.65, 35, 65), true);
    });

    it("should return false for prices outside bounds", () => {
      assert.strictEqual(isWithinEntryBounds(0.3, 35, 65), false);
      assert.strictEqual(isWithinEntryBounds(0.7, 35, 65), false);
      assert.strictEqual(isWithinEntryBounds(0.9, 35, 65), false);
    });

    it("should work with different bounds", () => {
      assert.strictEqual(isWithinEntryBounds(0.25, 20, 80), true);
      assert.strictEqual(isWithinEntryBounds(0.15, 20, 80), false);
    });
  });

  describe("price formation never exceeds 0.99", () => {
    it("should never return limitPrice >= 1.0 for any slippage", () => {
      const testCases = [
        { bestAsk: 0.99, slippagePct: 5 },
        { bestAsk: 0.95, slippagePct: 10 },
        { bestAsk: 0.9, slippagePct: 20 },
        { bestAsk: 0.8, slippagePct: 50 },
        { bestAsk: 0.7, slippagePct: 100 },
      ];

      for (const tc of testCases) {
        const result = calculateSafeLimitPrice(
          { bestBid: tc.bestAsk - 0.02, bestAsk: tc.bestAsk },
          { slippagePct: tc.slippagePct, side: "BUY" },
        );
        assert.ok(
          result.limitPrice <= MAX_PRICE,
          `Limit price ${result.limitPrice} exceeded MAX_PRICE for bestAsk=${tc.bestAsk}, slippage=${tc.slippagePct}%`,
        );
      }
    });

    it("should never return limitPrice <= 0.0 for any slippage", () => {
      const testCases = [
        { bestBid: 0.01, slippagePct: 5 },
        { bestBid: 0.05, slippagePct: 10 },
        { bestBid: 0.1, slippagePct: 50 },
        { bestBid: 0.2, slippagePct: 100 },
      ];

      for (const tc of testCases) {
        const result = calculateSafeLimitPrice(
          { bestBid: tc.bestBid, bestAsk: tc.bestBid + 0.02 },
          { slippagePct: tc.slippagePct, side: "SELL" },
        );
        // For SELL, limitPrice may be 0 if orderbook is rejected (dust book)
        // But if valid, should be >= MIN_PRICE
        if (result.rejectionReason === undefined) {
          assert.ok(
            result.limitPrice >= MIN_PRICE,
            `Limit price ${result.limitPrice} below MIN_PRICE for bestBid=${tc.bestBid}, slippage=${tc.slippagePct}%`,
          );
        }
      }
    });
  });
});
