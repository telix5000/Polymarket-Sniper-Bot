/**
 * Tests for price safety module
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  clampPrice,
  isLiquidOrderbook,
  isDustBook,
  calculateSafeLimitPrice,
  isWithinEntryBounds,
  MIN_PRICE,
  MAX_PRICE,
} from "../../../src/lib/price-safety";

describe("Price Safety Module", () => {
  describe("clampPrice", () => {
    it("should clamp prices above MAX_PRICE to MAX_PRICE", () => {
      assert.strictEqual(clampPrice(1.0), MAX_PRICE);
      assert.strictEqual(clampPrice(1.5), MAX_PRICE);
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
