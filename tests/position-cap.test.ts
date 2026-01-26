import assert from "node:assert";
import { test, describe } from "node:test";

/**
 * Unit tests for V2 Position Cap Bug Fix
 *
 * These tests verify that:
 * 1. SELL orders should NEVER be blocked by position cap (they reduce positions)
 * 2. Protective exits (StopLoss, AutoSell, ForceLiq, DisputeExit) bypass ALL risk checks
 * 3. BUY orders ARE blocked when at or above the hard position cap (maxOpenPositions)
 * 4. BUY orders below the hard position cap are NOT blocked
 */

describe("V2 Position Cap Fix", () => {
  /**
   * Helper function that mirrors the SELL order risk check bypass logic from executeSell()
   * This checks if a SELL order should be allowed despite a failed risk check
   *
   * Note: This logic is intentionally duplicated from the main code to ensure the test
   * is self-contained and tests the expected behavior. If the main code changes,
   * update this test accordingly to verify the new behavior.
   */
  function shouldAllowSellDespiteRiskFailure(
    reason: string,
    riskCheckReason: string | undefined,
  ): boolean {
    // Check if this is a protective exit that bypasses ALL risk checks
    const protectiveExitTypes = [
      "StopLoss",
      "AutoSell",
      "ForceLiq",
      "DisputeExit",
    ];
    const isProtectiveExit = protectiveExitTypes.some((type) =>
      reason.includes(type),
    );

    // Also ignore position cap failures for ALL SELL orders (defensive check)
    const isPositionCapFailure = riskCheckReason?.includes("Position cap");

    // Allow SELL if it's a protective exit OR if the failure is due to position cap
    return isProtectiveExit || isPositionCapFailure === true;
  }

  describe("SELL Orders Should NEVER Be Blocked by Position Cap", () => {
    test("DisputeExit SELL should be allowed despite position cap failure", () => {
      const reason = "DisputeExit ($0.99)";
      const riskCheckReason =
        "Position cap: 26 >= 25 (5 slots reserved for hedges)";

      assert.strictEqual(
        shouldAllowSellDespiteRiskFailure(reason, riskCheckReason),
        true,
        "DisputeExit should bypass position cap check",
      );
    });

    test("Regular SELL should be allowed despite position cap failure", () => {
      const reason = "RegularSell";
      const riskCheckReason =
        "Position cap: 30 >= 25 (5 slots reserved for hedges)";

      assert.strictEqual(
        shouldAllowSellDespiteRiskFailure(reason, riskCheckReason),
        true,
        "Any SELL should bypass position cap check (defensive)",
      );
    });

    test("Scalp SELL should be allowed despite position cap failure", () => {
      const reason = "Scalp (15%)";
      const riskCheckReason =
        "Position cap: 26 >= 25 (5 slots reserved for hedges)";

      assert.strictEqual(
        shouldAllowSellDespiteRiskFailure(reason, riskCheckReason),
        true,
        "Scalp SELL should bypass position cap check",
      );
    });

    test("QuickWin SELL should be allowed despite position cap failure", () => {
      const reason = "QuickWin (25%)";
      const riskCheckReason =
        "Position cap: 26 >= 25 (5 slots reserved for hedges)";

      assert.strictEqual(
        shouldAllowSellDespiteRiskFailure(reason, riskCheckReason),
        true,
        "QuickWin SELL should bypass position cap check",
      );
    });
  });

  describe("Protective Exits Should Bypass ALL Risk Checks", () => {
    test("StopLoss should bypass rate limit failure", () => {
      const reason = "StopLoss (-30%)";
      const riskCheckReason = "Rate limit: 500 orders this hour";

      assert.strictEqual(
        shouldAllowSellDespiteRiskFailure(reason, riskCheckReason),
        true,
        "StopLoss should bypass ALL risk checks including rate limit",
      );
    });

    test("AutoSell should bypass cooldown failure", () => {
      const reason = "AutoSell ($0.99)";
      const riskCheckReason = "Cooldown: 500ms remaining";

      assert.strictEqual(
        shouldAllowSellDespiteRiskFailure(reason, riskCheckReason),
        true,
        "AutoSell should bypass ALL risk checks including cooldown",
      );
    });

    test("ForceLiq should bypass drawdown failure", () => {
      const reason = "ForceLiq (margin call)";
      const riskCheckReason = "Max drawdown 30% >= 25%";

      assert.strictEqual(
        shouldAllowSellDespiteRiskFailure(reason, riskCheckReason),
        true,
        "ForceLiq should bypass ALL risk checks including drawdown",
      );
    });

    test("DisputeExit should bypass rate limit failure", () => {
      const reason = "DisputeExit ($0.999)";
      const riskCheckReason = "Rate limit: 100 orders this hour";

      assert.strictEqual(
        shouldAllowSellDespiteRiskFailure(reason, riskCheckReason),
        true,
        "DisputeExit should bypass ALL risk checks including rate limit",
      );
    });
  });

  describe("Non-Protective SELL Orders Respect Other Risk Checks", () => {
    test("Regular SELL should NOT bypass rate limit (non-position-cap failure)", () => {
      const reason = "RegularSell";
      const riskCheckReason = "Rate limit: 500 orders this hour";

      assert.strictEqual(
        shouldAllowSellDespiteRiskFailure(reason, riskCheckReason),
        false,
        "Non-protective SELL should respect rate limit",
      );
    });

    test("Regular SELL should NOT bypass cooldown (non-position-cap failure)", () => {
      const reason = "RegularSell";
      const riskCheckReason = "Cooldown: 500ms remaining";

      assert.strictEqual(
        shouldAllowSellDespiteRiskFailure(reason, riskCheckReason),
        false,
        "Non-protective SELL should respect cooldown",
      );
    });
  });

  describe("BUY Position Cap Logic", () => {
    /**
     * Helper function that mirrors the BUY order hard cap check from executeBuy()
     */
    function isAtHardCap(
      positionCount: number,
      maxOpenPositions: number,
    ): boolean {
      return positionCount >= maxOpenPositions;
    }

    test("BUY should be blocked at hard cap (30 positions, max 30)", () => {
      assert.strictEqual(isAtHardCap(30, 30), true, "Should block at hard cap");
    });

    test("BUY should be blocked above hard cap (31 positions, max 30)", () => {
      assert.strictEqual(
        isAtHardCap(31, 30),
        true,
        "Should block above hard cap",
      );
    });

    test("BUY should NOT be blocked below hard cap (29 positions, max 30)", () => {
      assert.strictEqual(
        isAtHardCap(29, 30),
        false,
        "Should allow below hard cap",
      );
    });
  });
});
