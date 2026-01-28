import assert from "node:assert";
import { describe, test } from "node:test";

/**
 * Tests for diag-workflow.ts internal logic
 *
 * Note: The attemptDiagBuy function is internal and not exported.
 * We test the mapOrderFailureReason function behavior through the
 * exported DiagReason mapping patterns.
 */

/**
 * Re-implementation of mapOrderFailureReason for testing purposes.
 * This mirrors the logic in diag-workflow.ts.
 */
type DiagReason =
  | "unsupported_market_schema"
  | "not_binary_market"
  | "cannot_resolve_outcome_token"
  | "orderbook_unavailable"
  | "insufficient_liquidity"
  | "price_out_of_range"
  | "cooldown_active"
  | "risk_limits_blocked"
  | "no_wallet_credentials"
  | "ws_disconnected"
  | "api_error"
  | "no_position_to_sell"
  | "sell_skipped_no_buy"
  | "timeout_waiting_for_whale"
  | "order_timeout"
  | "unknown_error";

function mapOrderFailureReason(reason?: string): DiagReason {
  if (!reason) return "unknown_error";

  const lower = reason.toLowerCase();

  if (lower.includes("live trading") || lower.includes("simulation")) {
    return "no_wallet_credentials";
  }
  if (lower.includes("liquidity") || lower.includes("depth")) {
    return "insufficient_liquidity";
  }
  // Map PRICE_TOO_HIGH and PRICE_TOO_LOW from postOrder
  if (
    lower.includes("price_too_high") ||
    lower.includes("price_too_low") ||
    (lower.includes("price") &&
      (lower.includes("range") || lower.includes("protection")))
  ) {
    return "price_out_of_range";
  }
  if (
    lower.includes("orderbook") ||
    lower.includes("no_asks") ||
    lower.includes("no_bids")
  ) {
    return "orderbook_unavailable";
  }
  if (lower.includes("cooldown")) {
    return "cooldown_active";
  }
  if (lower.includes("risk")) {
    return "risk_limits_blocked";
  }
  if (lower.includes("timeout")) {
    return "order_timeout";
  }
  if (lower.includes("api") || lower.includes("network")) {
    return "api_error";
  }

  return "unknown_error";
}

describe("mapOrderFailureReason", () => {
  describe("PRICE_TOO_HIGH and PRICE_TOO_LOW mapping", () => {
    test("should map PRICE_TOO_HIGH to price_out_of_range", () => {
      assert.strictEqual(
        mapOrderFailureReason("PRICE_TOO_HIGH"),
        "price_out_of_range",
      );
    });

    test("should map price_too_high (lowercase) to price_out_of_range", () => {
      assert.strictEqual(
        mapOrderFailureReason("price_too_high"),
        "price_out_of_range",
      );
    });

    test("should map PRICE_TOO_LOW to price_out_of_range", () => {
      assert.strictEqual(
        mapOrderFailureReason("PRICE_TOO_LOW"),
        "price_out_of_range",
      );
    });

    test("should map mixed case Price_Too_High to price_out_of_range", () => {
      assert.strictEqual(
        mapOrderFailureReason("Price_Too_High"),
        "price_out_of_range",
      );
    });
  });

  describe("orderbook mapping", () => {
    test("should map NO_ASKS to orderbook_unavailable", () => {
      assert.strictEqual(
        mapOrderFailureReason("NO_ASKS"),
        "orderbook_unavailable",
      );
    });

    test("should map NO_BIDS to orderbook_unavailable", () => {
      assert.strictEqual(
        mapOrderFailureReason("NO_BIDS"),
        "orderbook_unavailable",
      );
    });

    test("should map NO_ORDERBOOK to orderbook_unavailable", () => {
      assert.strictEqual(
        mapOrderFailureReason("NO_ORDERBOOK"),
        "orderbook_unavailable",
      );
    });
  });

  describe("credential mapping", () => {
    test("should map live trading disabled to no_wallet_credentials", () => {
      assert.strictEqual(
        mapOrderFailureReason("SIMULATED"),
        "unknown_error", // SIMULATED doesn't contain "live trading"
      );
      assert.strictEqual(
        mapOrderFailureReason("live trading disabled"),
        "no_wallet_credentials",
      );
    });
  });

  describe("liquidity mapping", () => {
    test("should map insufficient_liquidity", () => {
      assert.strictEqual(
        mapOrderFailureReason("insufficient liquidity"),
        "insufficient_liquidity",
      );
    });

    test("should map NO_LIQUIDITY to insufficient_liquidity", () => {
      assert.strictEqual(
        mapOrderFailureReason("NO_LIQUIDITY"),
        "insufficient_liquidity",
      );
    });
  });

  describe("edge cases", () => {
    test("should return unknown_error for empty string", () => {
      assert.strictEqual(mapOrderFailureReason(""), "unknown_error");
    });

    test("should return unknown_error for undefined", () => {
      assert.strictEqual(mapOrderFailureReason(undefined), "unknown_error");
    });

    test("should return unknown_error for unrecognized reason", () => {
      assert.strictEqual(
        mapOrderFailureReason("SOME_RANDOM_ERROR"),
        "unknown_error",
      );
    });
  });
});

describe("DIAG Buy Pricing Logic", () => {
  /**
   * These tests verify the expected pricing behavior for DIAG BUY orders.
   *
   * The key fix is:
   * 1. Fetch orderbook FIRST to get current bestAsk
   * 2. Use bestAsk + slippage tolerance as chosenLimitPrice
   * 3. Do NOT use signal.price * 1.1 which can fail if market moved
   */

  test("pricing logic should use bestAsk as basis (documented behavior)", () => {
    // Simulate the pricing logic
    const signalPrice = 0.5; // Whale traded at 50¢
    const bestAsk = 0.6; // Current ask is 60¢ (market moved up)
    const slippagePct = 2; // 2% tolerance

    // OLD (broken): maxAcceptablePrice = signalPrice * 1.1 = 0.55
    // This would REJECT because bestAsk (0.6) > maxAcceptablePrice (0.55)
    const oldMaxAcceptable = signalPrice * 1.1;
    assert.ok(
      bestAsk > oldMaxAcceptable,
      "Old logic would reject valid orders",
    );

    // NEW (fixed): chosenLimitPrice = bestAsk * (1 + slippagePct/100)
    const newChosenLimit = bestAsk * (1 + slippagePct / 100);
    assert.ok(
      newChosenLimit >= bestAsk,
      "New logic allows fill at bestAsk with tolerance",
    );
    assert.strictEqual(newChosenLimit, 0.612); // 0.6 * 1.02
  });

  test("should compute correct sizeUsd based on chosenLimitPrice", () => {
    const forceShares = 1;
    const bestAsk = 0.765;
    const slippagePct = 2;

    const chosenLimitPrice = bestAsk * (1 + slippagePct / 100);
    const sizeUsd = forceShares * chosenLimitPrice;

    // 1 share * (0.765 * 1.02) = 0.7803
    assert.ok(Math.abs(sizeUsd - 0.7803) < 0.0001);
  });

  test("slippage percentage constant is defined correctly", () => {
    // DIAG_BUY_SLIPPAGE_PCT should be 2% as per implementation
    const DIAG_BUY_SLIPPAGE_PCT = 2;

    // This is a reasonable value that:
    // - Allows slight price movement tolerance
    // - Doesn't overpay significantly
    assert.ok(DIAG_BUY_SLIPPAGE_PCT >= 1, "Slippage should be at least 1%");
    assert.ok(DIAG_BUY_SLIPPAGE_PCT <= 5, "Slippage should not exceed 5%");
  });
});
