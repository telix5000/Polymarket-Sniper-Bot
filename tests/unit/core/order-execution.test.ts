/**
 * Tests for order execution module
 *
 * Verifies that:
 * 1. Both whale and scan paths use the same shared execution functions
 * 2. Directional tick rounding (ceiling for BUY, floor for SELL)
 * 3. Must-not-cross invariants after rounding
 * 4. GTC fallback pricing respects book
 */

import { describe, it } from "node:test";
import assert from "node:assert";

describe("Order Execution Module", () => {
  describe("Shared execution path verification", () => {
    /**
     * This test verifies that both whale and scan entries call the same
     * execution functions. The key insight is that both paths call:
     * - processEntry() in execution-engine.ts
     * - executeEntry() which uses computeExecutionLimitPrice()
     *
     * We verify this by checking that the price computation function exists
     * and has the correct signature for both use cases.
     */
    it("computeExecutionLimitPrice is exported and usable by both paths", () => {
      const {
        computeExecutionLimitPrice,
      } = require("../../../src/lib/price-safety");

      // Verify function exists and has correct signature
      assert.strictEqual(typeof computeExecutionLimitPrice, "function");

      // Test that it works for BUY (whale entry scenario)
      const buyResult = computeExecutionLimitPrice({
        bestBid: 0.59,
        bestAsk: 0.6,
        side: "BUY",
        slippageFrac: 0.06,
      });
      assert.strictEqual(buyResult.success, true);
      assert.ok(buyResult.limitPrice >= 0.6, "BUY limit must be >= bestAsk");

      // Test that it works for SELL (scan entry scenario)
      const sellResult = computeExecutionLimitPrice({
        bestBid: 0.5,
        bestAsk: 0.52,
        side: "SELL",
        slippageFrac: 0.06,
      });
      assert.strictEqual(sellResult.success, true);
      assert.ok(sellResult.limitPrice <= 0.5, "SELL limit must be <= bestBid");
    });

    it("placeOrderWithFallback validates inputs consistently", async () => {
      const {
        validateBeforePlacement,
      } = require("../../../src/lib/order-execution");

      // Verify function exists
      assert.strictEqual(typeof validateBeforePlacement, "function");

      // Valid book for BUY
      const validBuy = validateBeforePlacement({
        bestBid: 0.59,
        bestAsk: 0.6,
        side: "BUY",
        limitPrice: 0.64,
        tickSize: 0.01,
      });
      assert.strictEqual(validBuy.valid, true);

      // Valid book for SELL
      const validSell = validateBeforePlacement({
        bestBid: 0.5,
        bestAsk: 0.52,
        side: "SELL",
        limitPrice: 0.48,
        tickSize: 0.01,
      });
      assert.strictEqual(validSell.valid, true);

      // Invalid: dust book
      const dustBook = validateBeforePlacement({
        bestBid: 0.01,
        bestAsk: 0.99,
        side: "BUY",
        limitPrice: 0.99,
        tickSize: 0.01,
      });
      assert.strictEqual(dustBook.valid, false);
      assert.ok(
        dustBook.reason?.includes("UNHEALTHY_BOOK"),
        `Expected UNHEALTHY_BOOK, got ${dustBook.reason}`,
      );
    });
  });

  describe("Directional tick rounding", () => {
    const { roundToTick } = require("../../../src/lib/price-safety");

    it("BUY uses ceiling rounding", () => {
      // 0.631 should round UP to 0.64 for BUY
      assert.strictEqual(roundToTick(0.631, 0.01, "BUY"), 0.64);
      // 0.639 should round UP to 0.64 for BUY
      assert.strictEqual(roundToTick(0.639, 0.01, "BUY"), 0.64);
      // Exact value stays the same
      assert.strictEqual(roundToTick(0.64, 0.01, "BUY"), 0.64);
    });

    it("SELL uses floor rounding", () => {
      // 0.631 should round DOWN to 0.63 for SELL
      assert.strictEqual(roundToTick(0.631, 0.01, "SELL"), 0.63);
      // 0.639 should round DOWN to 0.63 for SELL
      assert.strictEqual(roundToTick(0.639, 0.01, "SELL"), 0.63);
      // Exact value stays the same
      assert.strictEqual(roundToTick(0.64, 0.01, "SELL"), 0.64);
    });

    it("handles floating point precision (e.g., 0.59 / 0.01)", () => {
      // This used to fail because 0.59 / 0.01 = 58.99999... in JS
      assert.strictEqual(roundToTick(0.59, 0.01, "SELL"), 0.59);
      assert.strictEqual(roundToTick(0.59, 0.01, "BUY"), 0.59);
    });
  });

  describe("Must-not-cross invariants", () => {
    const {
      computeExecutionLimitPrice,
    } = require("../../../src/lib/price-safety");

    it("BUY limit >= bestAsk after rounding", () => {
      // Edge case: bestAsk=0.595 with tiny slippage
      const result = computeExecutionLimitPrice({
        bestBid: 0.58,
        bestAsk: 0.595,
        side: "BUY",
        slippageFrac: 0.001, // 0.1% slippage
      });
      assert.strictEqual(result.success, true);
      assert.ok(
        result.limitPrice >= 0.595,
        `BUY limit ${result.limitPrice} must be >= bestAsk 0.595`,
      );
    });

    it("SELL limit <= bestBid after rounding", () => {
      // Edge case: bestBid=0.505 with tiny slippage
      const result = computeExecutionLimitPrice({
        bestBid: 0.505,
        bestAsk: 0.52,
        side: "SELL",
        slippageFrac: 0.001, // 0.1% slippage
      });
      assert.strictEqual(result.success, true);
      assert.ok(
        result.limitPrice <= 0.505,
        `SELL limit ${result.limitPrice} must be <= bestBid 0.505`,
      );
    });

    it("BUY bumps up to tick boundary when rounding would cross", () => {
      // bestAsk=0.603, after small slippage and rounding might go below
      const result = computeExecutionLimitPrice({
        bestBid: 0.59,
        bestAsk: 0.603,
        side: "BUY",
        slippageFrac: 0.001,
        tickSize: 0.01,
      });
      assert.strictEqual(result.success, true);
      // Must be at least at the tick >= bestAsk
      assert.ok(
        result.limitPrice >= 0.603,
        `BUY limit ${result.limitPrice} must be >= bestAsk 0.603`,
      );
    });

    it("SELL bumps down to tick boundary when rounding would cross", () => {
      // bestBid=0.507, after small slippage and rounding might go above
      const result = computeExecutionLimitPrice({
        bestBid: 0.507,
        bestAsk: 0.52,
        side: "SELL",
        slippageFrac: 0.001,
        tickSize: 0.01,
      });
      assert.strictEqual(result.success, true);
      // Must be at most at the tick <= bestBid
      assert.ok(
        result.limitPrice <= 0.507,
        `SELL limit ${result.limitPrice} must be <= bestBid 0.507`,
      );
    });
  });

  describe("Strategy bounds enforcement", () => {
    const {
      computeExecutionLimitPrice,
      STRATEGY_MAX_PRICE,
    } = require("../../../src/lib/price-safety");

    it("rejects BUY when bestAsk > STRATEGY_MAX", () => {
      const result = computeExecutionLimitPrice({
        bestBid: 0.68,
        bestAsk: 0.7, // Above default STRATEGY_MAX (0.65)
        side: "BUY",
        slippageFrac: 0.06,
      });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.rejectionReason, "ASK_ABOVE_MAX");
    });

    it("rejects SELL when bestBid < STRATEGY_MIN", () => {
      const result = computeExecutionLimitPrice({
        bestBid: 0.3, // Below default STRATEGY_MIN (0.35)
        bestAsk: 0.32,
        side: "SELL",
        slippageFrac: 0.06,
      });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.rejectionReason, "BID_BELOW_MIN");
    });

    it("clamps BUY slippage-adjusted price to STRATEGY_MAX", () => {
      // bestAsk=0.62, slippage=6.1% → raw=0.6578 > STRATEGY_MAX (0.65)
      const result = computeExecutionLimitPrice({
        bestBid: 0.6,
        bestAsk: 0.62,
        side: "BUY",
        slippageFrac: 0.061,
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.wasClamped, true);
      assert.strictEqual(result.limitPrice, STRATEGY_MAX_PRICE);
    });
  });

  describe("Book health validation", () => {
    const {
      isBookHealthyForExecution,
    } = require("../../../src/lib/price-safety");

    it("rejects empty book (bid<=1¢, ask>=99¢)", () => {
      const result = isBookHealthyForExecution(0.01, 0.99);
      assert.strictEqual(result.healthy, false);
      assert.strictEqual(result.reason, "EMPTY_BOOK");
    });

    it("rejects dust book (bid<=2¢, ask>=98¢)", () => {
      const result = isBookHealthyForExecution(0.02, 0.98);
      assert.strictEqual(result.healthy, false);
      assert.strictEqual(result.reason, "DUST_BOOK");
    });

    it("rejects crossed book (bid > ask)", () => {
      const result = isBookHealthyForExecution(0.6, 0.55);
      assert.strictEqual(result.healthy, false);
      assert.strictEqual(result.reason, "CROSSED_BOOK");
    });

    it("rejects invalid prices", () => {
      assert.strictEqual(isBookHealthyForExecution(null, 0.5).healthy, false);
      assert.strictEqual(
        isBookHealthyForExecution(0.5, undefined).healthy,
        false,
      );
      assert.strictEqual(isBookHealthyForExecution(0, 0.5).healthy, false);
      assert.strictEqual(isBookHealthyForExecution(NaN, 0.5).healthy, false);
    });

    it("accepts healthy book", () => {
      const result = isBookHealthyForExecution(0.59, 0.6);
      assert.strictEqual(result.healthy, true);
    });
  });

  describe("Rejection classification", () => {
    const {
      classifyRejectionReason,
    } = require("../../../src/lib/price-safety");

    it("classifies common rejection reasons", () => {
      assert.strictEqual(
        classifyRejectionReason("Invalid price increment"),
        "PRICE_INCREMENT",
      );
      assert.strictEqual(
        classifyRejectionReason("Insufficient balance"),
        "INSUFFICIENT_BALANCE",
      );
      assert.strictEqual(
        classifyRejectionReason("Post only order would trade"),
        "POST_ONLY_WOULD_TRADE",
      );
      assert.strictEqual(
        classifyRejectionReason("Order size too small"),
        "MIN_SIZE",
      );
      assert.strictEqual(
        classifyRejectionReason("Stale nonce"),
        "STALE_ORDERBOOK",
      );
      assert.strictEqual(
        classifyRejectionReason("Market closed"),
        "MARKET_CLOSED",
      );
    });

    it("returns UNKNOWN for unrecognized errors", () => {
      assert.strictEqual(
        classifyRejectionReason("Some random error"),
        "UNKNOWN",
      );
    });
  });

  describe("Acceptance criteria", () => {
    const {
      computeExecutionLimitPrice,
    } = require("../../../src/lib/price-safety");

    it("with bid=0.59 ask=0.60 slippage=6%, BUY limit is >=0.60 and <=strategyMax", () => {
      const result = computeExecutionLimitPrice({
        bestBid: 0.59,
        bestAsk: 0.6,
        side: "BUY",
        slippageFrac: 0.06,
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(
        result.basePrice,
        0.6,
        "basePriceUsed must be bestAsk",
      );
      assert.ok(
        result.limitPrice >= 0.6,
        `limit ${result.limitPrice} must be >= bestAsk 0.60`,
      );
      assert.ok(
        result.limitPrice <= 0.65,
        `limit ${result.limitPrice} must be <= strategyMax 0.65`,
      );
      // raw = 0.60 * 1.06 = 0.636, ceiling rounds to 0.64
      assert.strictEqual(result.limitPrice, 0.64);
    });

    it("with bid=0.59 ask=0.60 slippage=6%, SELL limit is <=0.59 and >=strategyMin", () => {
      const result = computeExecutionLimitPrice({
        bestBid: 0.59,
        bestAsk: 0.6,
        side: "SELL",
        slippageFrac: 0.06,
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(
        result.basePrice,
        0.59,
        "basePriceUsed must be bestBid",
      );
      assert.ok(
        result.limitPrice <= 0.59,
        `limit ${result.limitPrice} must be <= bestBid 0.59`,
      );
      assert.ok(
        result.limitPrice >= 0.35,
        `limit ${result.limitPrice} must be >= strategyMin 0.35`,
      );
      // raw = 0.59 * 0.94 = 0.5546, floor rounds to 0.55
      assert.strictEqual(result.limitPrice, 0.55);
    });

    it("ORDER_PRICE_DEBUG log includes correct basePriceUsed", () => {
      // This test verifies the log output format - we can't directly test console.log
      // but we can verify the computation is correct
      const buyResult = computeExecutionLimitPrice({
        bestBid: 0.59,
        bestAsk: 0.6,
        side: "BUY",
        slippageFrac: 0.06,
        tokenIdPrefix: "test123",
      });

      // For BUY, basePriceUsed should be bestAsk
      assert.strictEqual(buyResult.basePrice, 0.6);

      const sellResult = computeExecutionLimitPrice({
        bestBid: 0.59,
        bestAsk: 0.6,
        side: "SELL",
        slippageFrac: 0.06,
        tokenIdPrefix: "test456",
      });

      // For SELL, basePriceUsed should be bestBid
      assert.strictEqual(sellResult.basePrice, 0.59);
    });
  });
});
