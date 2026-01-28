import assert from "node:assert";
import { test, describe } from "node:test";

/**
 * Unit tests for V2 HedgeUp Risk Bypass Fix
 *
 * These tests verify that:
 * 1. HedgeUp trades do NOT bypass risk checks (they're speculative, not protective)
 * 2. True protective hedges (Hedge, EmergencyHedge, SellSignal Hedge) DO bypass risk checks
 * 3. Other trades do NOT bypass risk checks
 */

describe("V2 HedgeUp Risk Bypass Fix", () => {
  // Helper function that mirrors the V2 isProtectiveHedge logic from executeBuy()
  // True hedges: "Hedge (X%)", "EmergencyHedge (X%)", "SellSignal Hedge (X%)"
  function isProtectiveHedge(reason: string): boolean {
    return (
      reason.startsWith("Hedge (") ||
      reason.startsWith("EmergencyHedge") ||
      reason.startsWith("SellSignal Hedge")
    );
  }

  describe("Protective Hedge Detection", () => {
    test("'Hedge (-25%)' should be recognized as a protective hedge", () => {
      assert.strictEqual(
        isProtectiveHedge("Hedge (-25%)"),
        true,
        "Hedge with loss percentage should be protective",
      );
    });

    test("'EmergencyHedge (-35%)' should be recognized as a protective hedge", () => {
      assert.strictEqual(
        isProtectiveHedge("EmergencyHedge (-35%)"),
        true,
        "EmergencyHedge should be protective",
      );
    });

    test("'SellSignal Hedge (-20%)' should be recognized as a protective hedge", () => {
      assert.strictEqual(
        isProtectiveHedge("SellSignal Hedge (-20%)"),
        true,
        "SellSignal Hedge should be protective",
      );
    });
  });

  describe("HedgeUp Should NOT Bypass Risk Checks", () => {
    test("'HedgeUp (0.85)' should NOT be recognized as a protective hedge", () => {
      assert.strictEqual(
        isProtectiveHedge("HedgeUp (0.85)"),
        false,
        "HedgeUp is speculative doubling down, NOT protective",
      );
    });

    test("'HedgeUp (0.90)' should NOT be recognized as a protective hedge", () => {
      assert.strictEqual(
        isProtectiveHedge("HedgeUp (0.90)"),
        false,
        "HedgeUp at 90¢ should NOT bypass risk checks",
      );
    });
  });

  describe("Other Trades Should NOT Bypass Risk Checks", () => {
    test("'Copy' trade should NOT bypass risk checks", () => {
      assert.strictEqual(
        isProtectiveHedge("Copy"),
        false,
        "Copy trades should respect risk limits",
      );
    });

    test("'Arb' trade should NOT bypass risk checks", () => {
      assert.strictEqual(
        isProtectiveHedge("Arb"),
        false,
        "Arbitrage trades should respect risk limits",
      );
    });

    test("'Stack (+15%)' should NOT bypass risk checks", () => {
      assert.strictEqual(
        isProtectiveHedge("Stack (+15%)"),
        false,
        "Stack trades should respect risk limits",
      );
    });

    test("'Endgame' should NOT bypass risk checks", () => {
      assert.strictEqual(
        isProtectiveHedge("Endgame"),
        false,
        "Endgame trades should respect risk limits",
      );
    });
  });

  describe("Edge Cases", () => {
    test("Empty reason should NOT bypass risk checks", () => {
      assert.strictEqual(
        isProtectiveHedge(""),
        false,
        "Empty reason should not bypass",
      );
    });

    test("'Hedge' without parentheses should NOT bypass (incomplete format)", () => {
      // The format is "Hedge (X%)" not just "Hedge"
      assert.strictEqual(
        isProtectiveHedge("Hedge"),
        false,
        "Incomplete 'Hedge' without loss % should not bypass",
      );
    });

    test("'HedgeUpSomething' should NOT bypass (starts with HedgeUp)", () => {
      assert.strictEqual(
        isProtectiveHedge("HedgeUpSomething"),
        false,
        "Any HedgeUp variant should not bypass",
      );
    });
  });
});

/**
 * Unit tests for V2 No-Hedge Window Logic
 *
 * These tests verify that:
 * 1. When marketEndTime is available, it's used to compute minutes to close
 * 2. When marketEndTime is NOT available, fallback to hold-time heuristic
 * 3. No-hedge window is correctly detected
 */

describe("V2 No-Hedge Window with Real Market Close Time", () => {
  // Constant mirroring V2's ASSUMED_MARKET_DURATION_HOURS
  const ASSUMED_MARKET_DURATION_HOURS = 24;

  // Helper function that mirrors the V2 no-hedge window logic
  function computeNoHedgeWindow(
    marketEndTime: number | undefined,
    now: number,
    holdTimeSeconds: number,
    noHedgeWindowMinutes: number,
  ): {
    inNoHedgeWindow: boolean;
    minutesToClose?: number;
    usedFallback: boolean;
  } {
    let inNoHedgeWindow = false;
    let minutesToClose: number | undefined;
    let usedFallback = false;

    if (marketEndTime && marketEndTime >= now) {
      // Use real market close time (>= handles edge case where market is closing exactly now)
      minutesToClose = (marketEndTime - now) / (60 * 1000);
      inNoHedgeWindow = minutesToClose <= noHedgeWindowMinutes;
    }

    // Fallback: If no market close time, use hold-time-based heuristic
    if (minutesToClose === undefined) {
      const holdMinutesForHedge = holdTimeSeconds / 60;
      inNoHedgeWindow =
        holdMinutesForHedge >=
        ASSUMED_MARKET_DURATION_HOURS * 60 - noHedgeWindowMinutes;
      usedFallback = true;
    }

    return { inNoHedgeWindow, minutesToClose, usedFallback };
  }

  describe("With Real Market Close Time", () => {
    test("2 minutes to close should trigger no-hedge window (5 min window)", () => {
      const now = Date.now();
      const marketEndTime = now + 2 * 60 * 1000; // 2 minutes from now
      const noHedgeWindowMinutes = 5;

      const result = computeNoHedgeWindow(
        marketEndTime,
        now,
        0,
        noHedgeWindowMinutes,
      );

      assert.strictEqual(
        result.inNoHedgeWindow,
        true,
        "Should be in no-hedge window",
      );
      assert.strictEqual(
        result.usedFallback,
        false,
        "Should use real market time",
      );
      assert.ok(
        result.minutesToClose !== undefined && result.minutesToClose < 3,
        "Minutes to close should be ~2",
      );
    });

    test("30 minutes to close should NOT trigger no-hedge window (5 min window)", () => {
      const now = Date.now();
      const marketEndTime = now + 30 * 60 * 1000; // 30 minutes from now
      const noHedgeWindowMinutes = 5;

      const result = computeNoHedgeWindow(
        marketEndTime,
        now,
        0,
        noHedgeWindowMinutes,
      );

      assert.strictEqual(
        result.inNoHedgeWindow,
        false,
        "Should NOT be in no-hedge window",
      );
      assert.strictEqual(
        result.usedFallback,
        false,
        "Should use real market time",
      );
    });

    test("Exactly at the window boundary should trigger no-hedge window", () => {
      const now = Date.now();
      const marketEndTime = now + 5 * 60 * 1000; // Exactly 5 minutes from now
      const noHedgeWindowMinutes = 5;

      const result = computeNoHedgeWindow(
        marketEndTime,
        now,
        0,
        noHedgeWindowMinutes,
      );

      assert.strictEqual(
        result.inNoHedgeWindow,
        true,
        "Should be in no-hedge window at boundary",
      );
    });

    test("Market closing exactly now (marketEndTime == now) should use real time, not fallback", () => {
      const now = Date.now();
      const marketEndTime = now; // Closing exactly now
      const noHedgeWindowMinutes = 5;

      const result = computeNoHedgeWindow(
        marketEndTime,
        now,
        0,
        noHedgeWindowMinutes,
      );

      assert.strictEqual(
        result.usedFallback,
        false,
        "Should use real market time when market closing now",
      );
      assert.strictEqual(
        result.minutesToClose,
        0,
        "Minutes to close should be 0",
      );
      assert.strictEqual(
        result.inNoHedgeWindow,
        true,
        "Should be in no-hedge window when market is closing",
      );
    });
  });

  describe("Fallback to Hold-Time Heuristic", () => {
    test("Should use fallback when marketEndTime is undefined", () => {
      const now = Date.now();
      const holdTimeSeconds = 100; // Short hold time
      const noHedgeWindowMinutes = 5;

      const result = computeNoHedgeWindow(
        undefined,
        now,
        holdTimeSeconds,
        noHedgeWindowMinutes,
      );

      assert.strictEqual(result.usedFallback, true, "Should use fallback");
      assert.strictEqual(
        result.minutesToClose,
        undefined,
        "minutesToClose should be undefined",
      );
    });

    test("Should use fallback when marketEndTime is in the past", () => {
      const now = Date.now();
      const marketEndTime = now - 1000; // In the past
      const noHedgeWindowMinutes = 5;

      const result = computeNoHedgeWindow(
        marketEndTime,
        now,
        0,
        noHedgeWindowMinutes,
      );

      assert.strictEqual(
        result.usedFallback,
        true,
        "Should use fallback for past market time",
      );
    });

    test("Long hold time (23h 58min) should trigger no-hedge window via fallback", () => {
      const now = Date.now();
      const holdTimeSeconds = (ASSUMED_MARKET_DURATION_HOURS * 60 - 2) * 60; // 23h 58min in seconds
      const noHedgeWindowMinutes = 5;

      const result = computeNoHedgeWindow(
        undefined,
        now,
        holdTimeSeconds,
        noHedgeWindowMinutes,
      );

      assert.strictEqual(
        result.inNoHedgeWindow,
        true,
        "Should be in no-hedge window via fallback",
      );
      assert.strictEqual(result.usedFallback, true, "Should use fallback");
    });
  });
});

/**
 * Unit tests for V2 Protective Hedge Duplicate Prevention Bypass
 *
 * These tests verify that:
 * 1. Protective hedges (Hedge, EmergencyHedge, SellSignal Hedge) should bypass duplicate prevention
 *    (BUY_COOLDOWN, in-flight checks) to ensure loss recovery operations execute
 * 2. Speculative trades (HedgeUp, Copy, etc.) should respect duplicate prevention checks
 *
 * This tests the logic that determines skipDuplicatePrevention: isProtectiveHedge
 * in executeBuy() when calling postOrder().
 */

describe("V2 Protective Hedge Duplicate Prevention Bypass", () => {
  // Helper function that mirrors the V2 isProtectiveHedge logic from executeBuy()
  // True hedges: "Hedge (X%)", "EmergencyHedge (X%)", "SellSignal Hedge (X%)"
  function isProtectiveHedge(reason: string): boolean {
    return (
      reason.startsWith("Hedge (") ||
      reason.startsWith("EmergencyHedge") ||
      reason.startsWith("SellSignal Hedge")
    );
  }

  /**
   * Helper function that determines if duplicate prevention should be skipped.
   * This mirrors the logic in executeBuy() where skipDuplicatePrevention: isProtectiveHedge
   * is passed to postOrder().
   */
  function shouldSkipDuplicatePrevention(reason: string): boolean {
    return isProtectiveHedge(reason);
  }

  describe("Protective Hedges SHOULD Bypass Duplicate Prevention (BUY_COOLDOWN)", () => {
    test("'Hedge (-25%)' should bypass BUY_COOLDOWN to ensure loss recovery executes", () => {
      assert.strictEqual(
        shouldSkipDuplicatePrevention("Hedge (-25%)"),
        true,
        "Hedge orders must bypass cooldowns for loss recovery",
      );
    });

    test("'EmergencyHedge (-35%)' should bypass BUY_COOLDOWN for critical protection", () => {
      assert.strictEqual(
        shouldSkipDuplicatePrevention("EmergencyHedge (-35%)"),
        true,
        "EmergencyHedge must bypass cooldowns for critical protection",
      );
    });

    test("'SellSignal Hedge (-20%)' should bypass BUY_COOLDOWN when tracked trader sells", () => {
      assert.strictEqual(
        shouldSkipDuplicatePrevention("SellSignal Hedge (-20%)"),
        true,
        "SellSignal Hedge must bypass cooldowns for timely response",
      );
    });

    test("'SellSignal Hedge (-5%)' should bypass BUY_COOLDOWN for small losses too", () => {
      assert.strictEqual(
        shouldSkipDuplicatePrevention("SellSignal Hedge (-5%)"),
        true,
        "SellSignal Hedge bypasses cooldowns regardless of loss percentage",
      );
    });
  });

  describe("Speculative Trades MUST Respect Duplicate Prevention (BUY_COOLDOWN)", () => {
    test("'HedgeUp (0.85)' should NOT bypass BUY_COOLDOWN - speculative doubling down", () => {
      assert.strictEqual(
        shouldSkipDuplicatePrevention("HedgeUp (0.85)"),
        false,
        "HedgeUp is speculative and must respect cooldowns to prevent stacking",
      );
    });

    test("'HedgeUp (0.90)' should NOT bypass BUY_COOLDOWN at any price", () => {
      assert.strictEqual(
        shouldSkipDuplicatePrevention("HedgeUp (0.90)"),
        false,
        "HedgeUp at high prices must still respect cooldowns",
      );
    });

    test("'Copy' should NOT bypass BUY_COOLDOWN - copy trades must prevent stacking", () => {
      assert.strictEqual(
        shouldSkipDuplicatePrevention("Copy"),
        false,
        "Copy trades must respect cooldowns to prevent buy stacking",
      );
    });

    test("'Arb' should NOT bypass BUY_COOLDOWN - arbitrage trades follow normal rules", () => {
      assert.strictEqual(
        shouldSkipDuplicatePrevention("Arb"),
        false,
        "Arbitrage trades must respect cooldowns",
      );
    });

    test("'Stack (+15%)' should NOT bypass BUY_COOLDOWN - stacking must be rate-limited", () => {
      assert.strictEqual(
        shouldSkipDuplicatePrevention("Stack (+15%)"),
        false,
        "Stack trades must respect cooldowns to prevent rapid stacking",
      );
    });

    test("'Endgame' should NOT bypass BUY_COOLDOWN", () => {
      assert.strictEqual(
        shouldSkipDuplicatePrevention("Endgame"),
        false,
        "Endgame trades must respect cooldowns",
      );
    });

    test("'OptStack (EV:$5.00)' should NOT bypass BUY_COOLDOWN", () => {
      assert.strictEqual(
        shouldSkipDuplicatePrevention("OptStack (EV:$5.00)"),
        false,
        "Optimizer stack trades must respect cooldowns",
      );
    });

    test("'OptHedgeUp (EV:$3.00)' should NOT bypass BUY_COOLDOWN", () => {
      assert.strictEqual(
        shouldSkipDuplicatePrevention("OptHedgeUp (EV:$3.00)"),
        false,
        "Optimizer hedge-up trades must respect cooldowns",
      );
    });
  });

  describe("Edge Cases for Duplicate Prevention Bypass", () => {
    test("Empty reason should NOT bypass BUY_COOLDOWN", () => {
      assert.strictEqual(
        shouldSkipDuplicatePrevention(""),
        false,
        "Empty reason should not bypass cooldowns",
      );
    });

    test("'Hedge' alone (no parentheses) should NOT bypass - incomplete format", () => {
      assert.strictEqual(
        shouldSkipDuplicatePrevention("Hedge"),
        false,
        "Incomplete 'Hedge' format should not bypass cooldowns",
      );
    });

    test("'HedgeUpSomething' should NOT bypass - any HedgeUp variant is speculative", () => {
      assert.strictEqual(
        shouldSkipDuplicatePrevention("HedgeUpSomething"),
        false,
        "HedgeUp variants should not bypass cooldowns",
      );
    });

    test("'SellSignalHedge' (no space) should NOT bypass - format matters", () => {
      assert.strictEqual(
        shouldSkipDuplicatePrevention("SellSignalHedge (-20%)"),
        false,
        "SellSignalHedge without space doesn't match expected format",
      );
    });
  });
});
