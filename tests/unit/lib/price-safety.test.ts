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
  computeLimitPrice,
  MIN_PRICE,
  MAX_PRICE,
  STRATEGY_MIN_PRICE,
  STRATEGY_MAX_PRICE,
  HARD_MIN_PRICE,
  HARD_MAX_PRICE,
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

  describe("computeLimitPrice", () => {
    describe("BUY orders", () => {
      it("should compute correct BUY price with 5.9% slippage for bestAsk=0.60", () => {
        const result = computeLimitPrice({
          bestBid: 0.59,
          bestAsk: 0.60,
          side: "BUY",
          slippageFrac: 0.059, // 5.9%
        });

        // Expected: 0.60 * 1.059 = 0.6354
        assert.ok(
          result.limitPrice <= MAX_PRICE,
          `BUY price ${result.limitPrice} should be <= ${MAX_PRICE}`,
        );
        assert.ok(
          Math.abs(result.limitPrice - 0.6354) < 0.001,
          `BUY price ${result.limitPrice} should be ~0.6354`,
        );
        assert.strictEqual(result.wasClamped, false);
      });

      it("should compute correct BUY price with 5.9% slippage for bestAsk=0.46", () => {
        const result = computeLimitPrice({
          bestBid: 0.43,
          bestAsk: 0.46,
          side: "BUY",
          slippageFrac: 0.059, // 5.9%
        });

        // Expected: 0.46 * 1.059 = 0.48714
        assert.ok(
          result.limitPrice <= MAX_PRICE,
          `BUY price ${result.limitPrice} should be <= ${MAX_PRICE}`,
        );
        assert.ok(
          Math.abs(result.limitPrice - 0.48714) < 0.001,
          `BUY price ${result.limitPrice} should be ~0.4871`,
        );
        assert.strictEqual(result.wasClamped, false);
      });

      it("should clamp BUY price to MAX_PRICE when slippage would exceed 0.99", () => {
        const result = computeLimitPrice({
          bestBid: 0.94,
          bestAsk: 0.95,
          side: "BUY",
          slippageFrac: 0.059, // 5.9% → 0.95 * 1.059 = 1.006 > 0.99
        });

        assert.strictEqual(
          result.limitPrice,
          MAX_PRICE,
          `BUY price should be clamped to ${MAX_PRICE}`,
        );
        assert.strictEqual(result.wasClamped, true);
        assert.strictEqual(result.clampDirection, "max");
        assert.ok(
          result.rawPrice > MAX_PRICE,
          `Raw price ${result.rawPrice} should exceed MAX_PRICE`,
        );
      });

      it("should never exceed 0.99 for any valid bestAsk + slippage", () => {
        const testCases = [
          { bestAsk: 0.99, slippage: 0.01 }, // Edge case
          { bestAsk: 0.98, slippage: 0.05 },
          { bestAsk: 0.95, slippage: 0.10 },
          { bestAsk: 0.90, slippage: 0.15 },
        ];

        for (const tc of testCases) {
          const result = computeLimitPrice({
            bestBid: tc.bestAsk - 0.02,
            bestAsk: tc.bestAsk,
            side: "BUY",
            slippageFrac: tc.slippage,
          });

          assert.ok(
            result.limitPrice <= MAX_PRICE,
            `BUY @ bestAsk=${tc.bestAsk}, slippage=${tc.slippage} → ${result.limitPrice} should be <= ${MAX_PRICE}`,
          );
        }
      });
    });

    describe("SELL orders", () => {
      it("should compute correct SELL price with 5.9% slippage for bestBid=0.59", () => {
        const result = computeLimitPrice({
          bestBid: 0.59,
          bestAsk: 0.60,
          side: "SELL",
          slippageFrac: 0.059, // 5.9%
        });

        // Expected: 0.59 * 0.941 = 0.55519
        assert.ok(
          result.limitPrice >= MIN_PRICE,
          `SELL price ${result.limitPrice} should be >= ${MIN_PRICE}`,
        );
        assert.ok(
          Math.abs(result.limitPrice - 0.55519) < 0.001,
          `SELL price ${result.limitPrice} should be ~0.5552`,
        );
        assert.strictEqual(result.wasClamped, false);
      });

      it("should clamp SELL price to MIN_PRICE when slippage would go below 0.01", () => {
        const result = computeLimitPrice({
          bestBid: 0.02,
          bestAsk: 0.05,
          side: "SELL",
          slippageFrac: 0.60, // 60% → 0.02 * 0.40 = 0.008 < 0.01
        });

        assert.strictEqual(
          result.limitPrice,
          MIN_PRICE,
          `SELL price should be clamped to ${MIN_PRICE}`,
        );
        assert.strictEqual(result.wasClamped, true);
        assert.strictEqual(result.clampDirection, "min");
        assert.ok(
          result.rawPrice < MIN_PRICE,
          `Raw price ${result.rawPrice} should be below MIN_PRICE`,
        );
      });

      it("should never go below 0.01 for any valid bestBid + slippage", () => {
        const testCases = [
          { bestBid: 0.01, slippage: 0.01 }, // Edge case
          { bestBid: 0.02, slippage: 0.50 },
          { bestBid: 0.05, slippage: 0.80 },
          { bestBid: 0.10, slippage: 0.95 },
        ];

        for (const tc of testCases) {
          const result = computeLimitPrice({
            bestBid: tc.bestBid,
            bestAsk: tc.bestBid + 0.02,
            side: "SELL",
            slippageFrac: tc.slippage,
          });

          assert.ok(
            result.limitPrice >= MIN_PRICE,
            `SELL @ bestBid=${tc.bestBid}, slippage=${tc.slippage} → ${result.limitPrice} should be >= ${MIN_PRICE}`,
          );
        }
      });
    });

    describe("Edge cases", () => {
      it("should handle slippageFrac that looks like percentage (warn but still work)", () => {
        // If someone passes 5.9 instead of 0.059, it should still clamp
        const result = computeLimitPrice({
          bestBid: 0.50,
          bestAsk: 0.51,
          side: "BUY",
          slippageFrac: 5.9, // WRONG - this is percentage, not fraction
        });

        // 0.51 * 6.9 = 3.519, should clamp to 0.99
        assert.strictEqual(result.limitPrice, MAX_PRICE);
        assert.strictEqual(result.wasClamped, true);
      });

      it("should handle zero slippage (use best price directly)", () => {
        const resultBuy = computeLimitPrice({
          bestBid: 0.50,
          bestAsk: 0.51,
          side: "BUY",
          slippageFrac: 0,
        });
        assert.strictEqual(resultBuy.limitPrice, 0.51);
        assert.strictEqual(resultBuy.wasClamped, false);

        const resultSell = computeLimitPrice({
          bestBid: 0.50,
          bestAsk: 0.51,
          side: "SELL",
          slippageFrac: 0,
        });
        assert.strictEqual(resultSell.limitPrice, 0.50);
        assert.strictEqual(resultSell.wasClamped, false);
      });
    });
  });

  describe("computeExecutionLimitPrice", () => {
    // Import the function for testing
    const {
      computeExecutionLimitPrice,
      isBookHealthyForExecution,
      roundToTick,
    } = require("../../../src/lib/price-safety");

    describe("roundToTick", () => {
      it("should round to nearest tick when no side specified (legacy)", () => {
        assert.strictEqual(roundToTick(0.634, 0.01), 0.63);
        assert.strictEqual(roundToTick(0.636, 0.01), 0.64);
        assert.strictEqual(roundToTick(0.635, 0.01), 0.64); // round half up
      });

      it("should round UP (ceiling) for BUY orders", () => {
        assert.strictEqual(roundToTick(0.631, 0.01, "BUY"), 0.64); // ceiling
        assert.strictEqual(roundToTick(0.639, 0.01, "BUY"), 0.64); // ceiling
        assert.strictEqual(roundToTick(0.640, 0.01, "BUY"), 0.64); // exact
        assert.strictEqual(roundToTick(0.641, 0.01, "BUY"), 0.65); // ceiling
      });

      it("should round DOWN (floor) for SELL orders", () => {
        assert.strictEqual(roundToTick(0.631, 0.01, "SELL"), 0.63); // floor
        assert.strictEqual(roundToTick(0.639, 0.01, "SELL"), 0.63); // floor
        assert.strictEqual(roundToTick(0.640, 0.01, "SELL"), 0.64); // exact
        assert.strictEqual(roundToTick(0.649, 0.01, "SELL"), 0.64); // floor
      });

      it("should handle edge cases", () => {
        assert.strictEqual(roundToTick(NaN, 0.01), NaN);
        assert.strictEqual(roundToTick(0.5, 0), 0.5); // invalid tick
        assert.strictEqual(roundToTick(0.5, -0.01), 0.5); // negative tick
      });
    });

    describe("isBookHealthyForExecution", () => {
      it("should return healthy for normal book", () => {
        const result = isBookHealthyForExecution(0.59, 0.60);
        assert.strictEqual(result.healthy, true);
        assert.strictEqual(result.reason, undefined);
      });

      it("should reject empty book (bid<=1¢, ask>=99¢)", () => {
        const result = isBookHealthyForExecution(0.01, 0.99);
        assert.strictEqual(result.healthy, false);
        assert.strictEqual(result.reason, "EMPTY_BOOK");
      });

      it("should reject dust book (bid<=2¢, ask>=98¢)", () => {
        const result = isBookHealthyForExecution(0.02, 0.98);
        assert.strictEqual(result.healthy, false);
        assert.strictEqual(result.reason, "DUST_BOOK");
      });

      it("should reject invalid book", () => {
        assert.strictEqual(isBookHealthyForExecution(null, 0.5).healthy, false);
        assert.strictEqual(isBookHealthyForExecution(0.5, undefined).healthy, false);
        assert.strictEqual(isBookHealthyForExecution(0, 0.5).healthy, false);
        assert.strictEqual(isBookHealthyForExecution(NaN, 0.5).healthy, false);
      });

      it("should reject crossed book (bid > ask)", () => {
        const result = isBookHealthyForExecution(0.60, 0.55); // bid > ask
        assert.strictEqual(result.healthy, false);
        assert.strictEqual(result.reason, "CROSSED_BOOK");
      });
    });

    describe("base price selection", () => {
      it("should use bestAsk as base price for BUY", () => {
        const result = computeExecutionLimitPrice({
          bestBid: 0.59,
          bestAsk: 0.60,
          side: "BUY",
          slippageFrac: 0,
        });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.basePrice, 0.60);
        assert.strictEqual(result.limitPrice, 0.60);
      });

      it("should use bestBid as base price for SELL", () => {
        const result = computeExecutionLimitPrice({
          bestBid: 0.59,
          bestAsk: 0.60,
          side: "SELL",
          slippageFrac: 0,
        });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.basePrice, 0.59);
        assert.strictEqual(result.limitPrice, 0.59);
      });
    });

    describe("price bounds enforcement", () => {
      it("should REJECT BUY when bestAsk > STRATEGY_MAX_PRICE (SKIP)", () => {
        // If STRATEGY_MAX is 0.65, and bestAsk is 0.70, SKIP immediately
        const result = computeExecutionLimitPrice({
          bestBid: 0.68,
          bestAsk: 0.70, // Above STRATEGY_MAX (0.65)
          side: "BUY",
          slippageFrac: 0.061,
        });
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.basePrice, 0.70);
        assert.strictEqual(result.rejectionReason, "ASK_ABOVE_MAX");
      });

      it("should REJECT SELL when bestBid < STRATEGY_MIN_PRICE (SKIP)", () => {
        // If STRATEGY_MIN is 0.35, and bestBid is 0.30, SKIP immediately
        const result = computeExecutionLimitPrice({
          bestBid: 0.30, // Below STRATEGY_MIN (0.35)
          bestAsk: 0.32,
          side: "SELL",
          slippageFrac: 0.061,
        });
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.basePrice, 0.30);
        assert.strictEqual(result.rejectionReason, "BID_BELOW_MIN");
      });

      it("should clamp BUY slippage-adjusted price to STRATEGY_MAX_PRICE", () => {
        // bestAsk=0.62 is within bounds, but with 6.1% slippage:
        // rawPrice = 0.62 * 1.061 = 0.6578 > STRATEGY_MAX (0.65)
        const result = computeExecutionLimitPrice({
          bestBid: 0.60,
          bestAsk: 0.62,
          side: "BUY",
          slippageFrac: 0.061,
        });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.wasClamped, true);
        assert.strictEqual(result.clampDirection, "max");
        assert.strictEqual(result.limitPrice, STRATEGY_MAX_PRICE);
      });

      it("should clamp SELL slippage-adjusted price to STRATEGY_MIN_PRICE", () => {
        // bestBid=0.36 is within bounds, but with 6.1% slippage:
        // rawPrice = 0.36 * 0.939 = 0.338 < STRATEGY_MIN (0.35)
        const result = computeExecutionLimitPrice({
          bestBid: 0.36,
          bestAsk: 0.38,
          side: "SELL",
          slippageFrac: 0.061,
        });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.wasClamped, true);
        assert.strictEqual(result.clampDirection, "min");
        // Use approximate comparison for floating point
        assert.ok(
          Math.abs(result.limitPrice - STRATEGY_MIN_PRICE) < 0.0001,
          `limitPrice ${result.limitPrice} should be ~${STRATEGY_MIN_PRICE}`,
        );
      });

      it("should enforce BUY limit >= bestAsk (never below ask)", () => {
        // With negative slippage (which shouldn't happen but test the guard)
        // The limit should never go below bestAsk
        const result = computeExecutionLimitPrice({
          bestBid: 0.58,
          bestAsk: 0.60,
          side: "BUY",
          slippageFrac: -0.05, // This would make rawPrice < basePrice
        });
        assert.strictEqual(result.success, true);
        // Should be clamped to at least bestAsk
        assert.ok(result.limitPrice >= 0.60, `BUY limit ${result.limitPrice} should be >= bestAsk 0.60`);
      });

      it("should enforce SELL limit <= bestBid (never above bid)", () => {
        // With negative slippage (which shouldn't happen but test the guard)
        // The limit should never go above bestBid
        const result = computeExecutionLimitPrice({
          bestBid: 0.55,
          bestAsk: 0.57,
          side: "SELL",
          slippageFrac: -0.05, // This would make rawPrice > basePrice
        });
        assert.strictEqual(result.success, true);
        // Should be clamped to at most bestBid
        assert.ok(result.limitPrice <= 0.55, `SELL limit ${result.limitPrice} should be <= bestBid 0.55`);
      });
    });

    describe("acceptance criteria from issue", () => {
      it("for book bid=0.59 ask=0.60, slippage=0.061 => BUY limit around 0.636 (not 0.99, not forced to 0.65)", () => {
        // This is the key test case from the issue
        const result = computeExecutionLimitPrice({
          bestBid: 0.59,
          bestAsk: 0.60,
          side: "BUY",
          slippageFrac: 0.061, // 6.1%
        });
        
        // Expected: 0.60 * 1.061 = 0.6366, rounded to 0.64
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.basePrice, 0.60); // NOT 0.99!
        assert.ok(
          Math.abs(result.rawPrice - 0.6366) < 0.001,
          `rawPrice ${result.rawPrice} should be ~0.6366`,
        );
        // 0.6366 < STRATEGY_MAX (0.65), so not clamped to strategy
        assert.strictEqual(result.wasClamped, false);
        assert.strictEqual(result.limitPrice, 0.64); // rounded to tick
      });
    });

    describe("dust/empty book rejection", () => {
      it("should reject dust book instead of defaulting to 0.99", () => {
        const result = computeExecutionLimitPrice({
          bestBid: 0.01,
          bestAsk: 0.99,
          side: "BUY",
          slippageFrac: 0.061,
        });
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.rejectionReason, "EMPTY_BOOK");
        assert.strictEqual(result.limitPrice, 0); // NOT 0.99 or any default!
      });
    });

    describe("two-layer bounds system", () => {
      it("should have HARD bounds at 0.01-0.99", () => {
        assert.strictEqual(HARD_MIN_PRICE, 0.01);
        assert.strictEqual(HARD_MAX_PRICE, 0.99);
      });

      it("should have STRATEGY bounds at default 0.35-0.65", () => {
        // Unless overridden by env vars
        assert.strictEqual(STRATEGY_MIN_PRICE, 0.35);
        assert.strictEqual(STRATEGY_MAX_PRICE, 0.65);
      });

      it("should maintain backward compatibility aliases", () => {
        assert.strictEqual(MIN_PRICE, STRATEGY_MIN_PRICE);
        assert.strictEqual(MAX_PRICE, STRATEGY_MAX_PRICE);
      });
    });

    describe("sanity tests (from feedback)", () => {
      it("BUY with bestAsk=0.60, strategyMax=0.65, slippage=6% => raw=0.636, final >= 0.60", () => {
        const result = computeExecutionLimitPrice({
          bestBid: 0.58,
          bestAsk: 0.60,
          side: "BUY",
          slippageFrac: 0.06, // 6%
        });
        // raw = 0.60 * 1.06 = 0.636
        assert.strictEqual(result.success, true);
        assert.ok(
          Math.abs(result.rawPrice - 0.636) < 0.001,
          `rawPrice ${result.rawPrice} should be ~0.636`,
        );
        // final must be >= bestAsk (0.60) to not guarantee no fill
        assert.ok(result.limitPrice >= 0.60, `final ${result.limitPrice} should be >= bestAsk 0.60`);
        // final should be 0.64 (rounded to tick)
        assert.strictEqual(result.limitPrice, 0.64);
      });

      it("BUY with bestAsk=0.70, strategyMax=0.65 => SKIP", () => {
        const result = computeExecutionLimitPrice({
          bestBid: 0.68,
          bestAsk: 0.70, // Above STRATEGY_MAX (0.65)
          side: "BUY",
          slippageFrac: 0.06,
        });
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.rejectionReason, "ASK_ABOVE_MAX");
      });

      it("SELL with bestBid=0.34, strategyMin=0.35 => SKIP", () => {
        const result = computeExecutionLimitPrice({
          bestBid: 0.34, // Below STRATEGY_MIN (0.35)
          bestAsk: 0.36,
          side: "SELL",
          slippageFrac: 0.06,
        });
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.rejectionReason, "BID_BELOW_MIN");
      });

      it("Dust book bid=0.01 ask=0.99 => SKIP before pricing", () => {
        const result = computeExecutionLimitPrice({
          bestBid: 0.01,
          bestAsk: 0.99,
          side: "BUY",
          slippageFrac: 0.06,
        });
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.rejectionReason, "EMPTY_BOOK");
      });
    });

    describe("must not cross rule after rounding", () => {
      it("BUY: if rounding would drop below bestAsk, bump up to next tick", () => {
        // Edge case: bestAsk=0.595 with small slippage could round down below ask
        const result = computeExecutionLimitPrice({
          bestBid: 0.58,
          bestAsk: 0.595, // 59.5¢
          side: "BUY",
          slippageFrac: 0.001, // 0.1% slippage
        });
        // raw = 0.595 * 1.001 = 0.595595, would round to 0.60
        // But if it somehow rounded to 0.59 (below ask), it should be bumped to 0.60
        assert.strictEqual(result.success, true);
        assert.ok(
          result.limitPrice >= 0.595,
          `BUY final ${result.limitPrice} must be >= bestAsk 0.595`,
        );
      });

      it("SELL: if rounding would rise above bestBid, bump down to next tick", () => {
        // Edge case: bestBid=0.505 with small slippage could round up above bid
        const result = computeExecutionLimitPrice({
          bestBid: 0.505, // 50.5¢
          bestAsk: 0.52,
          side: "SELL",
          slippageFrac: 0.001, // 0.1% slippage
        });
        // raw = 0.505 * 0.999 = 0.504495, would round to 0.50
        // But if it somehow rounded to 0.51 (above bid), it should be bumped to 0.50
        assert.strictEqual(result.success, true);
        assert.ok(
          result.limitPrice <= 0.505,
          `SELL final ${result.limitPrice} must be <= bestBid 0.505`,
        );
      });
    });
  });

  describe("getTickSizeForToken", () => {
    const {
      getTickSizeForToken,
      clearTickSizeCache,
      DEFAULT_TICK_SIZE,
    } = require("../../../src/lib/price-safety");

    it("should return default tick size when no API tick size provided", () => {
      clearTickSizeCache();
      const result = getTickSizeForToken("test-token-123");
      assert.strictEqual(result.tickSize, DEFAULT_TICK_SIZE);
      assert.strictEqual(result.isDefault, true);
    });

    it("should use API-provided tick size when valid", () => {
      clearTickSizeCache();
      const result = getTickSizeForToken("test-token-456", 0.001);
      assert.strictEqual(result.tickSize, 0.001);
      assert.strictEqual(result.isDefault, false);
    });

    it("should fall back to default for invalid API tick size", () => {
      clearTickSizeCache();
      const result1 = getTickSizeForToken("test-token-789", 0);
      assert.strictEqual(result1.tickSize, DEFAULT_TICK_SIZE);
      assert.strictEqual(result1.isDefault, true);

      clearTickSizeCache();
      const result2 = getTickSizeForToken("test-token-abc", -0.01);
      assert.strictEqual(result2.tickSize, DEFAULT_TICK_SIZE);
      assert.strictEqual(result2.isDefault, true);

      clearTickSizeCache();
      const result3 = getTickSizeForToken("test-token-def", NaN);
      assert.strictEqual(result3.tickSize, DEFAULT_TICK_SIZE);
      assert.strictEqual(result3.isDefault, true);
    });

    it("should cache tick size results", () => {
      clearTickSizeCache();
      // First call with API tick size
      const result1 = getTickSizeForToken("cached-token", 0.005);
      assert.strictEqual(result1.tickSize, 0.005);

      // Second call without API tick size should use cached value
      const result2 = getTickSizeForToken("cached-token");
      assert.strictEqual(result2.tickSize, 0.005);
      assert.strictEqual(result2.isDefault, false);
    });
  });

  describe("toApiPriceUnits and fromApiPriceUnits", () => {
    const {
      toApiPriceUnits,
      fromApiPriceUnits,
    } = require("../../../src/lib/price-safety");

    it("should pass through valid prices", () => {
      assert.strictEqual(toApiPriceUnits(0.5), 0.5);
      assert.strictEqual(toApiPriceUnits(0.01), 0.01);
      assert.strictEqual(toApiPriceUnits(0.99), 0.99);
    });

    it("should throw for prices outside HARD bounds", () => {
      assert.throws(() => toApiPriceUnits(0.001), /outside API bounds/);
      assert.throws(() => toApiPriceUnits(1.0), /outside API bounds/);
      assert.throws(() => toApiPriceUnits(-0.1), /outside API bounds/);
    });

    it("should throw for non-finite prices", () => {
      assert.throws(() => toApiPriceUnits(NaN), /not finite/);
      assert.throws(() => toApiPriceUnits(Infinity), /not finite/);
    });

    it("fromApiPriceUnits should be identity for valid prices", () => {
      assert.strictEqual(fromApiPriceUnits(0.65), 0.65);
      assert.strictEqual(fromApiPriceUnits(0.35), 0.35);
    });

    it("fromApiPriceUnits should return 0 for non-finite prices", () => {
      assert.strictEqual(fromApiPriceUnits(NaN), 0);
    });
  });

  describe("classifyRejectionReason", () => {
    const { classifyRejectionReason } = require("../../../src/lib/price-safety");

    it("should classify price increment errors", () => {
      assert.strictEqual(
        classifyRejectionReason("Invalid price increment"),
        "PRICE_INCREMENT",
      );
      assert.strictEqual(
        classifyRejectionReason("INVALID_TICK size error"),
        "PRICE_INCREMENT",
      );
    });

    it("should classify balance errors", () => {
      assert.strictEqual(
        classifyRejectionReason("Insufficient balance to place order"),
        "INSUFFICIENT_BALANCE",
      );
      assert.strictEqual(
        classifyRejectionReason("not enough balance"),
        "INSUFFICIENT_BALANCE",
      );
    });

    it("should classify allowance errors", () => {
      assert.strictEqual(
        classifyRejectionReason("Insufficient allowance"),
        "INSUFFICIENT_ALLOWANCE",
      );
    });

    it("should classify post-only errors", () => {
      assert.strictEqual(
        classifyRejectionReason("Post only order would trade"),
        "POST_ONLY_WOULD_TRADE",
      );
      assert.strictEqual(
        classifyRejectionReason("TAKER_NOT_ALLOWED for postOnly"),
        "POST_ONLY_WOULD_TRADE",
      );
    });

    it("should classify min size errors", () => {
      assert.strictEqual(
        classifyRejectionReason("Order size too small"),
        "MIN_SIZE",
      );
      assert.strictEqual(
        classifyRejectionReason("Below minimum size"),
        "MIN_SIZE",
      );
    });

    it("should classify stale orderbook errors", () => {
      assert.strictEqual(
        classifyRejectionReason("Stale nonce"),
        "STALE_ORDERBOOK",
      );
      assert.strictEqual(
        classifyRejectionReason("Order expired"),
        "STALE_ORDERBOOK",
      );
    });

    it("should classify market closed errors", () => {
      assert.strictEqual(
        classifyRejectionReason("Market closed"),
        "MARKET_CLOSED",
      );
      assert.strictEqual(
        classifyRejectionReason("No orderbook exists"),
        "MARKET_CLOSED",
      );
    });

    it("should return UNKNOWN for unrecognized errors", () => {
      assert.strictEqual(
        classifyRejectionReason("Some random error message"),
        "UNKNOWN",
      );
    });
  });

  describe("roundToTick with non-standard tick sizes (directional)", () => {
    const { roundToTick } = require("../../../src/lib/price-safety");

    it("should round to 0.001 tick size correctly with BUY (ceiling)", () => {
      assert.strictEqual(roundToTick(0.6341, 0.001, "BUY"), 0.635); // ceiling
      assert.strictEqual(roundToTick(0.6349, 0.001, "BUY"), 0.635); // ceiling
      assert.strictEqual(roundToTick(0.635, 0.001, "BUY"), 0.635); // exact
    });

    it("should round to 0.001 tick size correctly with SELL (floor)", () => {
      assert.strictEqual(roundToTick(0.6341, 0.001, "SELL"), 0.634); // floor
      assert.strictEqual(roundToTick(0.6349, 0.001, "SELL"), 0.634); // floor
      assert.strictEqual(roundToTick(0.635, 0.001, "SELL"), 0.635); // exact
    });

    it("should round to 0.005 tick size correctly with BUY (ceiling)", () => {
      assert.strictEqual(roundToTick(0.631, 0.005, "BUY"), 0.635); // ceiling
      assert.strictEqual(roundToTick(0.634, 0.005, "BUY"), 0.635); // ceiling
      assert.strictEqual(roundToTick(0.635, 0.005, "BUY"), 0.635); // exact
    });

    it("should round to 0.005 tick size correctly with SELL (floor)", () => {
      assert.strictEqual(roundToTick(0.631, 0.005, "SELL"), 0.630); // floor
      assert.strictEqual(roundToTick(0.634, 0.005, "SELL"), 0.630); // floor
      assert.strictEqual(roundToTick(0.635, 0.005, "SELL"), 0.635); // exact
    });

    it("should round to 0.1 tick size correctly with BUY (ceiling)", () => {
      // Use approximate comparison for floating point
      const result1 = roundToTick(0.61, 0.1, "BUY");
      assert.ok(Math.abs(result1 - 0.7) < 0.0001, `Expected ~0.7, got ${result1}`);
      const result2 = roundToTick(0.69, 0.1, "BUY");
      assert.ok(Math.abs(result2 - 0.7) < 0.0001, `Expected ~0.7, got ${result2}`);
    });

    it("should round to 0.1 tick size correctly with SELL (floor)", () => {
      // Use approximate comparison for floating point
      const result1 = roundToTick(0.61, 0.1, "SELL");
      assert.ok(Math.abs(result1 - 0.6) < 0.0001, `Expected ~0.6, got ${result1}`);
      const result2 = roundToTick(0.69, 0.1, "SELL");
      assert.ok(Math.abs(result2 - 0.6) < 0.0001, `Expected ~0.6, got ${result2}`);
    });
  });

  describe("computeExecutionLimitPrice with custom tick size", () => {
    const { computeExecutionLimitPrice } = require("../../../src/lib/price-safety");

    it("should apply non-0.01 tick size correctly for BUY (ceiling)", () => {
      const result = computeExecutionLimitPrice({
        bestBid: 0.59,
        bestAsk: 0.60,
        side: "BUY",
        slippageFrac: 0.05, // 5% → 0.60 * 1.05 = 0.63
        tickSize: 0.005,
      });
      assert.strictEqual(result.success, true);
      // 0.63 is exact with 0.005 tick, but BUY uses ceiling so 0.63 stays 0.63
      assert.strictEqual(result.limitPrice, 0.63);
    });

    it("should apply non-0.01 tick size correctly for SELL (floor)", () => {
      const result = computeExecutionLimitPrice({
        bestBid: 0.50,
        bestAsk: 0.52,
        side: "SELL",
        slippageFrac: 0.05, // 5% → 0.50 * 0.95 = 0.475
        tickSize: 0.005,
      });
      assert.strictEqual(result.success, true);
      // 0.475 is exact with 0.005 tick for SELL (floor)
      // Use approximate comparison for floating point
      assert.ok(
        Math.abs(result.limitPrice - 0.475) < 0.0001,
        `Expected ~0.475, got ${result.limitPrice}`,
      );
    });

    it("should bump to tick boundary for must-not-cross rule (BUY)", () => {
      // Edge case: bestAsk=0.603 with tiny slippage, tick=0.005
      const result = computeExecutionLimitPrice({
        bestBid: 0.59,
        bestAsk: 0.603,
        side: "BUY",
        slippageFrac: 0.001, // 0.1% → 0.603 * 1.001 = 0.603603
        tickSize: 0.005,
      });
      assert.strictEqual(result.success, true);
      // 0.603603 with BUY ceiling rounds to 0.605
      // Must be >= bestAsk (0.603)
      assert.ok(
        result.limitPrice >= 0.603,
        `BUY limit ${result.limitPrice} must be >= bestAsk 0.603`,
      );
    });
  });

  describe("assertValidLimitPrice", () => {
    const { assertValidLimitPrice } = require("../../../src/lib/price-safety");

    it("should pass for valid prices within HARD bounds", () => {
      assert.doesNotThrow(() => assertValidLimitPrice(0.50, "BUY"));
      assert.doesNotThrow(() => assertValidLimitPrice(0.01, "SELL"));
      assert.doesNotThrow(() => assertValidLimitPrice(0.99, "BUY"));
    });

    it("should throw for prices outside HARD bounds", () => {
      assert.throws(() => assertValidLimitPrice(0.001, "BUY"), /outside HARD bounds/);
      assert.throws(() => assertValidLimitPrice(1.0, "SELL"), /outside HARD bounds/);
    });

    it("should throw for non-finite prices", () => {
      assert.throws(() => assertValidLimitPrice(NaN, "BUY"), /not finite/);
      assert.throws(() => assertValidLimitPrice(Infinity, "SELL"), /not finite/);
    });
  });
});
