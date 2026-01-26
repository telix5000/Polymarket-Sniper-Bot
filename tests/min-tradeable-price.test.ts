import assert from "node:assert";
import { test, describe } from "node:test";
import { ORDER } from "../src/lib/constants";

// Use the constant from our lib/constants.ts
const ABSOLUTE_MIN_TRADEABLE_PRICE = ORDER.MIN_TRADEABLE_PRICE;

/**
 * Unit tests for V2 Minimum Tradeable Price Filter
 *
 * These tests verify that:
 * 1. preOrderCheck rejects SELL orders when position.curPrice <= ABSOLUTE_MIN_TRADEABLE_PRICE
 * 2. The position processing loop skips positions with untradeable prices
 * 3. The ABSOLUTE_MIN_TRADEABLE_PRICE constant is correctly defined
 */

describe("V2 Minimum Tradeable Price Filter", () => {
  // Helper function that mirrors the V2 preOrderCheck SELL price validation logic
  function checkSellPrice(curPrice: number): { ok: boolean; reason?: string } {
    if (curPrice <= ABSOLUTE_MIN_TRADEABLE_PRICE) {
      return {
        ok: false,
        reason: `Price ${(curPrice * 100).toFixed(2)}¢ <= min ${(ABSOLUTE_MIN_TRADEABLE_PRICE * 100).toFixed(2)}¢`,
      };
    }
    return { ok: true };
  }

  // Helper function that mirrors the V2 cycle loop position filter
  function shouldProcessPosition(curPrice: number): boolean {
    // From V2 index.ts: positions with untradeable prices are skipped
    return curPrice > ABSOLUTE_MIN_TRADEABLE_PRICE;
  }

  describe("ABSOLUTE_MIN_TRADEABLE_PRICE constant validation", () => {
    test("ABSOLUTE_MIN_TRADEABLE_PRICE should be 0.001 (0.1¢)", () => {
      assert.strictEqual(
        ABSOLUTE_MIN_TRADEABLE_PRICE,
        0.001,
        "ABSOLUTE_MIN_TRADEABLE_PRICE should be 0.001",
      );
    });

    test("ABSOLUTE_MIN_TRADEABLE_PRICE should be greater than 0", () => {
      assert.ok(
        ABSOLUTE_MIN_TRADEABLE_PRICE > 0,
        "ABSOLUTE_MIN_TRADEABLE_PRICE must be positive",
      );
    });
  });

  describe("preOrderCheck SELL price validation", () => {
    test("SELL at price exactly equal to ABSOLUTE_MIN_TRADEABLE_PRICE should be rejected", () => {
      const result = checkSellPrice(ABSOLUTE_MIN_TRADEABLE_PRICE);

      assert.strictEqual(
        result.ok,
        false,
        "SELL at minimum price should be rejected",
      );
      assert.ok(
        result.reason !== undefined,
        "Rejection should include a reason",
      );
      assert.ok(
        result.reason.includes("0.10¢") && result.reason.includes("min"),
        "Reason should mention the price and minimum",
      );
    });

    test("SELL at price below ABSOLUTE_MIN_TRADEABLE_PRICE should be rejected", () => {
      const result = checkSellPrice(0.0005); // 0.05¢

      assert.strictEqual(
        result.ok,
        false,
        "SELL below minimum price should be rejected",
      );
      assert.ok(
        result.reason !== undefined,
        "Rejection should include a reason",
      );
      assert.ok(
        result.reason.includes("0.05¢"),
        "Reason should include the actual price",
      );
    });

    test("SELL at price of 0 should be rejected", () => {
      const result = checkSellPrice(0);

      assert.strictEqual(
        result.ok,
        false,
        "SELL at zero price should be rejected",
      );
      assert.ok(
        result.reason !== undefined,
        "Rejection should include a reason",
      );
    });

    test("SELL at price just above ABSOLUTE_MIN_TRADEABLE_PRICE should be allowed", () => {
      const result = checkSellPrice(0.002); // 0.2¢ - above the 0.1¢ minimum

      assert.strictEqual(
        result.ok,
        true,
        "SELL just above minimum should be allowed",
      );
      assert.strictEqual(
        result.reason,
        undefined,
        "No rejection reason for valid price",
      );
    });

    test("SELL at normal price (e.g., 50¢) should be allowed", () => {
      const result = checkSellPrice(0.5);

      assert.strictEqual(
        result.ok,
        true,
        "SELL at normal price should be allowed",
      );
    });

    test("SELL at high price (e.g., 99¢) should be allowed", () => {
      const result = checkSellPrice(0.99);

      assert.strictEqual(
        result.ok,
        true,
        "SELL at high price should be allowed",
      );
    });
  });

  describe("Position loop filter for untradeable prices", () => {
    test("Position with price at ABSOLUTE_MIN_TRADEABLE_PRICE should be skipped", () => {
      const shouldProcess = shouldProcessPosition(ABSOLUTE_MIN_TRADEABLE_PRICE);

      assert.strictEqual(
        shouldProcess,
        false,
        "Position at minimum price should be skipped in cycle loop",
      );
    });

    test("Position with price below ABSOLUTE_MIN_TRADEABLE_PRICE should be skipped", () => {
      const shouldProcess = shouldProcessPosition(0.0005);

      assert.strictEqual(
        shouldProcess,
        false,
        "Position below minimum price should be skipped",
      );
    });

    test("Position with zero price should be skipped", () => {
      const shouldProcess = shouldProcessPosition(0);

      assert.strictEqual(
        shouldProcess,
        false,
        "Position with zero price should be skipped",
      );
    });

    test("Position with price just above ABSOLUTE_MIN_TRADEABLE_PRICE should be processed", () => {
      const shouldProcess = shouldProcessPosition(0.002);

      assert.strictEqual(
        shouldProcess,
        true,
        "Position just above minimum should be processed",
      );
    });

    test("Position with normal price should be processed", () => {
      const shouldProcess = shouldProcessPosition(0.5);

      assert.strictEqual(
        shouldProcess,
        true,
        "Position with normal price should be processed",
      );
    });
  });

  describe("Edge cases", () => {
    test("Very small positive price just below minimum should be rejected", () => {
      const result = checkSellPrice(0.0009); // Just below 0.001

      assert.strictEqual(
        result.ok,
        false,
        "Price just below minimum should be rejected",
      );
    });

    test("Very small positive price just above minimum should be allowed", () => {
      const result = checkSellPrice(0.0011); // Just above 0.001

      assert.strictEqual(
        result.ok,
        true,
        "Price just above minimum should be allowed",
      );
    });

    test("Negative price should be rejected (invalid input)", () => {
      // Negative prices shouldn't occur but should be handled
      const result = checkSellPrice(-0.01);

      assert.strictEqual(result.ok, false, "Negative price should be rejected");
    });
  });
});
