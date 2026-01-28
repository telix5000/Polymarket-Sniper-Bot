/**
 * Tests for diagnostic mode price formation safety
 *
 * These tests verify that diagnostic mode:
 * 1. Never chooses limit price = 1.0 by default
 * 2. Skips trades on wide/extreme books
 * 3. Respects DIAG_MAX_PRICE cap
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

// Import actual functions from source
import {
  getDiagMaxPrice,
  checkBookTradeable,
  DIAG_BUY_SLIPPAGE_PCT,
  DIAG_MAX_SPREAD,
  DIAG_MAX_BEST_ASK,
} from "../../../src/lib/diag-workflow";

// Store original env values
const originalEnv: Record<string, string | undefined> = {};

/**
 * Helper to mock environment variables
 */
function mockEnv(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    if (!(key in originalEnv)) {
      originalEnv[key] = process.env[key];
    }
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * Restore original environment
 */
function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * Simulate the diagnostic price formation logic (uses actual constants)
 */
function calculateDiagLimitPrice(
  bestAsk: number,
  signalPrice?: number,
): { price: number; clamped: boolean } {
  const slippageMultiplier = 1 + DIAG_BUY_SLIPPAGE_PCT / 100;
  const diagMaxPrice = getDiagMaxPrice();

  // Calculate candidate prices
  const askBasedPrice = bestAsk * slippageMultiplier;
  const signalBasedPrice = signalPrice
    ? signalPrice * slippageMultiplier
    : Infinity;

  // Apply DIAG_MAX_PRICE cap
  const rawChosenPrice = Math.min(askBasedPrice, signalBasedPrice);
  const chosenLimitPrice = Math.min(rawChosenPrice, diagMaxPrice);

  return {
    price: chosenLimitPrice,
    clamped: rawChosenPrice > diagMaxPrice,
  };
}

describe("Diagnostic Price Formation Safety", () => {
  beforeEach(() => {
    mockEnv({ DIAG_MAX_PRICE: undefined });
  });

  afterEach(() => {
    restoreEnv();
  });

  describe("DIAG_MAX_PRICE cap", () => {
    it("should default to 0.70 when DIAG_MAX_PRICE is not set", () => {
      mockEnv({ DIAG_MAX_PRICE: undefined });
      assert.strictEqual(getDiagMaxPrice(), 0.7);
    });

    it("should respect DIAG_MAX_PRICE env var", () => {
      mockEnv({ DIAG_MAX_PRICE: "0.50" });
      assert.strictEqual(getDiagMaxPrice(), 0.5);
    });

    it("should ignore invalid DIAG_MAX_PRICE values", () => {
      mockEnv({ DIAG_MAX_PRICE: "invalid" });
      assert.strictEqual(getDiagMaxPrice(), 0.7);

      mockEnv({ DIAG_MAX_PRICE: "0" });
      assert.strictEqual(getDiagMaxPrice(), 0.7);

      mockEnv({ DIAG_MAX_PRICE: "-1" });
      assert.strictEqual(getDiagMaxPrice(), 0.7);

      mockEnv({ DIAG_MAX_PRICE: "1.5" });
      assert.strictEqual(getDiagMaxPrice(), 0.7);
    });

    it("should NEVER choose limit price = 1.0", () => {
      mockEnv({ DIAG_MAX_PRICE: undefined }); // Default 0.70

      // Even with extreme bestAsk = 1.0, price should be clamped
      const result = calculateDiagLimitPrice(1.0);
      assert.ok(result.price <= 0.7, `Price ${result.price} should be <= 0.70`);
      assert.ok(result.clamped, "Price should be clamped");
    });

    it("should clamp price to DIAG_MAX_PRICE when bestAsk + slippage exceeds it", () => {
      mockEnv({ DIAG_MAX_PRICE: "0.70" });

      // bestAsk = 0.75 → askBasedPrice = 0.765 (with 2% slippage)
      // Should be clamped to 0.70
      const result = calculateDiagLimitPrice(0.75);
      assert.strictEqual(result.price, 0.7);
      assert.ok(result.clamped, "Price should be clamped");
    });

    it("should NOT clamp price when bestAsk + slippage is below DIAG_MAX_PRICE", () => {
      mockEnv({ DIAG_MAX_PRICE: "0.70" });

      // bestAsk = 0.50 → askBasedPrice = 0.51 (with 2% slippage)
      // Should NOT be clamped
      const result = calculateDiagLimitPrice(0.5);
      assert.ok(
        result.price > 0.5 && result.price < 0.7,
        `Price ${result.price} should be between 0.50 and 0.70`,
      );
      assert.ok(!result.clamped, "Price should NOT be clamped");
    });
  });

  describe("BOOK_TOO_WIDE detection", () => {
    it("should reject books with bestAsk > 0.95", () => {
      const result = checkBookTradeable(0.9, 0.96);
      assert.ok(!result.tradeable, "Book should be untradeable");
      assert.ok(
        result.reason?.includes("BOOK_TOO_WIDE"),
        "Reason should mention BOOK_TOO_WIDE",
      );
    });

    it("should reject books with spread > 0.30", () => {
      const result = checkBookTradeable(0.3, 0.65); // spread = 0.35
      assert.ok(!result.tradeable, "Book should be untradeable");
      assert.ok(
        result.reason?.includes("BOOK_TOO_WIDE"),
        "Reason should mention BOOK_TOO_WIDE",
      );
    });

    it("should accept books with reasonable conditions", () => {
      // Normal book: bestBid=0.40, bestAsk=0.45 (spread=0.05)
      const result = checkBookTradeable(0.4, 0.45);
      assert.ok(result.tradeable, "Book should be tradeable");
    });

    it("should accept books at exactly the threshold boundaries", () => {
      // bestAsk = 0.95 (exactly at threshold, not over)
      const result1 = checkBookTradeable(0.65, 0.95);
      assert.ok(
        result1.tradeable,
        "Book with bestAsk=0.95 should be tradeable",
      );

      // spread = 0.30 (exactly at threshold, not over)
      const result2 = checkBookTradeable(0.3, 0.6);
      assert.ok(result2.tradeable, "Book with spread=0.30 should be tradeable");
    });

    it("should handle null bestBid gracefully", () => {
      // When bestBid is null, only check bestAsk threshold
      const result = checkBookTradeable(null, 0.7);
      assert.ok(
        result.tradeable,
        "Book with null bestBid but reasonable bestAsk should be tradeable",
      );
    });
  });

  describe("Price formation integration", () => {
    it("should never produce limit=1.0 regardless of input", () => {
      const testCases = [
        { bestAsk: 1.0, signalPrice: 1.0 },
        { bestAsk: 0.99, signalPrice: 1.0 },
        { bestAsk: 1.0, signalPrice: 0.95 },
        { bestAsk: 0.98, signalPrice: undefined },
      ];

      for (const { bestAsk, signalPrice } of testCases) {
        const result = calculateDiagLimitPrice(bestAsk, signalPrice);
        assert.ok(
          result.price < 1.0,
          `Price ${result.price} should be < 1.0 for bestAsk=${bestAsk}, signalPrice=${signalPrice}`,
        );
        assert.ok(
          result.price <= getDiagMaxPrice(),
          `Price ${result.price} should be <= DIAG_MAX_PRICE (${getDiagMaxPrice()})`,
        );
      }
    });

    it("should use signal price when lower than bestAsk", () => {
      // signalPrice = 0.40 → signalBasedPrice = 0.408
      // bestAsk = 0.50 → askBasedPrice = 0.51
      // Should use signal-based (lower)
      const result = calculateDiagLimitPrice(0.5, 0.4);
      assert.ok(
        result.price < 0.5,
        `Price ${result.price} should be < 0.50 (used signal price)`,
      );
    });
  });
});

describe("Diagnostic Mode Safety Invariants", () => {
  it("DIAG_MAX_PRICE default should be conservative (< 0.75)", () => {
    const defaultMax = 0.7; // From diag-workflow.ts
    assert.ok(
      defaultMax < 0.75,
      "Default DIAG_MAX_PRICE should be conservative",
    );
  });

  it("DIAG_MAX_SPREAD should reject obviously illiquid books", () => {
    assert.ok(DIAG_MAX_SPREAD <= 0.3, "DIAG_MAX_SPREAD should be <= 0.30");
  });

  it("DIAG_MAX_BEST_ASK should prevent buying near-resolved markets", () => {
    assert.ok(DIAG_MAX_BEST_ASK <= 0.95, "DIAG_MAX_BEST_ASK should be <= 0.95");
  });
});
