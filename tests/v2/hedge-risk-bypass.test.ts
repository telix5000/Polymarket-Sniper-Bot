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
        "Hedge with loss percentage should be protective"
      );
    });

    test("'EmergencyHedge (-35%)' should be recognized as a protective hedge", () => {
      assert.strictEqual(
        isProtectiveHedge("EmergencyHedge (-35%)"),
        true,
        "EmergencyHedge should be protective"
      );
    });

    test("'SellSignal Hedge (-20%)' should be recognized as a protective hedge", () => {
      assert.strictEqual(
        isProtectiveHedge("SellSignal Hedge (-20%)"),
        true,
        "SellSignal Hedge should be protective"
      );
    });
  });

  describe("HedgeUp Should NOT Bypass Risk Checks", () => {
    test("'HedgeUp (0.85)' should NOT be recognized as a protective hedge", () => {
      assert.strictEqual(
        isProtectiveHedge("HedgeUp (0.85)"),
        false,
        "HedgeUp is speculative doubling down, NOT protective"
      );
    });

    test("'HedgeUp (0.90)' should NOT be recognized as a protective hedge", () => {
      assert.strictEqual(
        isProtectiveHedge("HedgeUp (0.90)"),
        false,
        "HedgeUp at 90¢ should NOT bypass risk checks"
      );
    });
  });

  describe("Other Trades Should NOT Bypass Risk Checks", () => {
    test("'Copy' trade should NOT bypass risk checks", () => {
      assert.strictEqual(
        isProtectiveHedge("Copy"),
        false,
        "Copy trades should respect risk limits"
      );
    });

    test("'Arb' trade should NOT bypass risk checks", () => {
      assert.strictEqual(
        isProtectiveHedge("Arb"),
        false,
        "Arbitrage trades should respect risk limits"
      );
    });

    test("'Stack (+15%)' should NOT bypass risk checks", () => {
      assert.strictEqual(
        isProtectiveHedge("Stack (+15%)"),
        false,
        "Stack trades should respect risk limits"
      );
    });

    test("'Endgame' should NOT bypass risk checks", () => {
      assert.strictEqual(
        isProtectiveHedge("Endgame"),
        false,
        "Endgame trades should respect risk limits"
      );
    });
  });

  describe("Edge Cases", () => {
    test("Empty reason should NOT bypass risk checks", () => {
      assert.strictEqual(isProtectiveHedge(""), false, "Empty reason should not bypass");
    });

    test("'Hedge' without parentheses should NOT bypass (incomplete format)", () => {
      // The format is "Hedge (X%)" not just "Hedge"
      assert.strictEqual(
        isProtectiveHedge("Hedge"),
        false,
        "Incomplete 'Hedge' without loss % should not bypass"
      );
    });

    test("'HedgeUpSomething' should NOT bypass (starts with HedgeUp)", () => {
      assert.strictEqual(
        isProtectiveHedge("HedgeUpSomething"),
        false,
        "Any HedgeUp variant should not bypass"
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
    noHedgeWindowMinutes: number
  ): { inNoHedgeWindow: boolean; minutesToClose?: number; usedFallback: boolean } {
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
      inNoHedgeWindow = holdMinutesForHedge >= ASSUMED_MARKET_DURATION_HOURS * 60 - noHedgeWindowMinutes;
      usedFallback = true;
    }

    return { inNoHedgeWindow, minutesToClose, usedFallback };
  }

  describe("With Real Market Close Time", () => {
    test("2 minutes to close should trigger no-hedge window (5 min window)", () => {
      const now = Date.now();
      const marketEndTime = now + 2 * 60 * 1000; // 2 minutes from now
      const noHedgeWindowMinutes = 5;

      const result = computeNoHedgeWindow(marketEndTime, now, 0, noHedgeWindowMinutes);

      assert.strictEqual(result.inNoHedgeWindow, true, "Should be in no-hedge window");
      assert.strictEqual(result.usedFallback, false, "Should use real market time");
      assert.ok(result.minutesToClose !== undefined && result.minutesToClose < 3, "Minutes to close should be ~2");
    });

    test("30 minutes to close should NOT trigger no-hedge window (5 min window)", () => {
      const now = Date.now();
      const marketEndTime = now + 30 * 60 * 1000; // 30 minutes from now
      const noHedgeWindowMinutes = 5;

      const result = computeNoHedgeWindow(marketEndTime, now, 0, noHedgeWindowMinutes);

      assert.strictEqual(result.inNoHedgeWindow, false, "Should NOT be in no-hedge window");
      assert.strictEqual(result.usedFallback, false, "Should use real market time");
    });

    test("Exactly at the window boundary should trigger no-hedge window", () => {
      const now = Date.now();
      const marketEndTime = now + 5 * 60 * 1000; // Exactly 5 minutes from now
      const noHedgeWindowMinutes = 5;

      const result = computeNoHedgeWindow(marketEndTime, now, 0, noHedgeWindowMinutes);

      assert.strictEqual(result.inNoHedgeWindow, true, "Should be in no-hedge window at boundary");
    });

    test("Market closing exactly now (marketEndTime == now) should use real time, not fallback", () => {
      const now = Date.now();
      const marketEndTime = now; // Closing exactly now
      const noHedgeWindowMinutes = 5;

      const result = computeNoHedgeWindow(marketEndTime, now, 0, noHedgeWindowMinutes);

      assert.strictEqual(result.usedFallback, false, "Should use real market time when market closing now");
      assert.strictEqual(result.minutesToClose, 0, "Minutes to close should be 0");
      assert.strictEqual(result.inNoHedgeWindow, true, "Should be in no-hedge window when market is closing");
    });
  });

  describe("Fallback to Hold-Time Heuristic", () => {
    test("Should use fallback when marketEndTime is undefined", () => {
      const now = Date.now();
      const holdTimeSeconds = 100; // Short hold time
      const noHedgeWindowMinutes = 5;

      const result = computeNoHedgeWindow(undefined, now, holdTimeSeconds, noHedgeWindowMinutes);

      assert.strictEqual(result.usedFallback, true, "Should use fallback");
      assert.strictEqual(result.minutesToClose, undefined, "minutesToClose should be undefined");
    });

    test("Should use fallback when marketEndTime is in the past", () => {
      const now = Date.now();
      const marketEndTime = now - 1000; // In the past
      const noHedgeWindowMinutes = 5;

      const result = computeNoHedgeWindow(marketEndTime, now, 0, noHedgeWindowMinutes);

      assert.strictEqual(result.usedFallback, true, "Should use fallback for past market time");
    });

    test("Long hold time (23h 58min) should trigger no-hedge window via fallback", () => {
      const now = Date.now();
      const holdTimeSeconds = (ASSUMED_MARKET_DURATION_HOURS * 60 - 2) * 60; // 23h 58min in seconds
      const noHedgeWindowMinutes = 5;

      const result = computeNoHedgeWindow(undefined, now, holdTimeSeconds, noHedgeWindowMinutes);

      assert.strictEqual(result.inNoHedgeWindow, true, "Should be in no-hedge window via fallback");
      assert.strictEqual(result.usedFallback, true, "Should use fallback");
    });
  });
});
