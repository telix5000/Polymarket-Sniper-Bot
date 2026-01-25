/**
 * Tests for sell slippage tolerance constants and helper functions
 *
 * These tests verify that the sell slippage mechanism works correctly
 * to prevent missed profitable trades due to small bid/ask differences.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SELL_SLIPPAGE_PCT,
  STALE_SELL_SLIPPAGE_PCT,
  URGENT_SELL_SLIPPAGE_PCT,
  FALLING_KNIFE_SLIPPAGE_PCT,
  EMERGENCY_SELL_SLIPPAGE_PCT,
  calculateMinAcceptablePrice,
} from "../../src/strategies/constants";

describe("Sell Slippage Constants", () => {
  test("DEFAULT_SELL_SLIPPAGE_PCT is 2%", () => {
    // 2% slippage is the default to balance trade execution vs value preservation
    assert.equal(DEFAULT_SELL_SLIPPAGE_PCT, 2);
  });

  test("DEFAULT_SELL_SLIPPAGE_PCT is positive and reasonable", () => {
    // Slippage must be positive and not too large
    assert.ok(DEFAULT_SELL_SLIPPAGE_PCT > 0, "Slippage must be positive");
    assert.ok(DEFAULT_SELL_SLIPPAGE_PCT <= 10, "Slippage should not exceed 10%");
  });

  test("STALE_SELL_SLIPPAGE_PCT is 3%", () => {
    // 3% slippage for stale position cleanup
    assert.equal(STALE_SELL_SLIPPAGE_PCT, 3);
  });

  test("URGENT_SELL_SLIPPAGE_PCT is 10%", () => {
    // 10% slippage for time-sensitive exits
    assert.equal(URGENT_SELL_SLIPPAGE_PCT, 10);
  });

  test("FALLING_KNIFE_SLIPPAGE_PCT is 25%", () => {
    // 25% slippage for rapidly declining positions
    assert.equal(FALLING_KNIFE_SLIPPAGE_PCT, 25);
  });

  test("EMERGENCY_SELL_SLIPPAGE_PCT is 50%", () => {
    // 50% slippage for emergency exits
    assert.equal(EMERGENCY_SELL_SLIPPAGE_PCT, 50);
  });

  test("slippage tiers are in ascending order", () => {
    // Ensure slippage tiers are ordered from tightest to most liberal
    assert.ok(DEFAULT_SELL_SLIPPAGE_PCT < STALE_SELL_SLIPPAGE_PCT, "Default < Stale");
    assert.ok(STALE_SELL_SLIPPAGE_PCT < URGENT_SELL_SLIPPAGE_PCT, "Stale < Urgent");
    assert.ok(URGENT_SELL_SLIPPAGE_PCT < FALLING_KNIFE_SLIPPAGE_PCT, "Urgent < Falling Knife");
    assert.ok(FALLING_KNIFE_SLIPPAGE_PCT < EMERGENCY_SELL_SLIPPAGE_PCT, "Falling Knife < Emergency");
  });
});

describe("calculateMinAcceptablePrice", () => {
  test("calculates correct minimum price with default slippage", () => {
    // At 88¢ bid with 2% slippage, min acceptable = 88 * 0.98 = 86.24¢
    const result = calculateMinAcceptablePrice(0.88);
    assert.equal(result.toFixed(4), "0.8624");
  });

  test("calculates correct minimum price with custom slippage", () => {
    // At 88¢ bid with 3% slippage, min acceptable = 88 * 0.97 = 85.36¢
    const result = calculateMinAcceptablePrice(0.88, 3);
    assert.equal(result.toFixed(4), "0.8536");
  });

  test("handles 0% slippage (exact price)", () => {
    // 0% slippage means exact price match required
    const result = calculateMinAcceptablePrice(0.88, 0);
    assert.equal(result, 0.88);
  });

  test("handles 10% slippage for urgent exits", () => {
    // At 87¢ bid with 10% slippage, min acceptable = 87 * 0.90 = 78.3¢
    const result = calculateMinAcceptablePrice(0.87, 10);
    assert.equal(result.toFixed(3), "0.783");
  });

  test("handles near-resolution prices (99.9¢)", () => {
    // At 99.9¢ with 2% slippage, min acceptable = 99.9 * 0.98 = 97.902¢
    const result = calculateMinAcceptablePrice(0.999, 2);
    assert.equal(result.toFixed(5), "0.97902");
  });

  test("handles low prices correctly", () => {
    // At 10¢ with 2% slippage, min acceptable = 10 * 0.98 = 9.8¢
    const result = calculateMinAcceptablePrice(0.10, 2);
    assert.equal(result.toFixed(3), "0.098");
  });

  test("the issue scenario: 88¢ bid with 2% slippage accepts 87¢", () => {
    // Original issue: sale blocked because best bid (87¢) was below min acceptable (88¢)
    // With 2% slippage, 88¢ * 0.98 = 86.24¢, so 87¢ would be accepted
    const minAcceptable = calculateMinAcceptablePrice(0.88, 2);
    assert.ok(0.87 >= minAcceptable, "87¢ should be >= 86.24¢ (min acceptable)");
  });

  test("defaults to DEFAULT_SELL_SLIPPAGE_PCT when no slippage specified", () => {
    // Verify that the default parameter matches DEFAULT_SELL_SLIPPAGE_PCT
    const withDefault = calculateMinAcceptablePrice(0.88);
    const withExplicit = calculateMinAcceptablePrice(0.88, DEFAULT_SELL_SLIPPAGE_PCT);
    assert.equal(withDefault, withExplicit);
  });

  test("higher slippage results in lower minimum acceptable price", () => {
    const bid = 0.88;
    const slip2 = calculateMinAcceptablePrice(bid, 2);
    const slip5 = calculateMinAcceptablePrice(bid, 5);
    const slip10 = calculateMinAcceptablePrice(bid, 10);

    assert.ok(slip10 < slip5, "10% slippage should produce lower min than 5%");
    assert.ok(slip5 < slip2, "5% slippage should produce lower min than 2%");
    assert.ok(slip2 < bid, "2% slippage should produce lower min than bid");
  });

  test("throws error for negative slippage", () => {
    assert.throws(
      () => calculateMinAcceptablePrice(0.88, -1),
      /Invalid slippage percentage: -1\. Must be between 0 and 100\./,
    );
  });

  test("throws error for slippage > 100%", () => {
    assert.throws(
      () => calculateMinAcceptablePrice(0.88, 101),
      /Invalid slippage percentage: 101\. Must be between 0 and 100\./,
    );
  });

  test("accepts boundary values 0% and 100%", () => {
    // 0% is valid (exact price match)
    const result0 = calculateMinAcceptablePrice(0.88, 0);
    assert.equal(result0, 0.88);

    // 100% is valid (accept any price including 0)
    const result100 = calculateMinAcceptablePrice(0.88, 100);
    assert.equal(result100, 0);
  });
});

describe("Slippage Integration Scenarios", () => {
  test("profitable trade with small bid variance should execute", () => {
    // Entry at 62.1¢, current bid at 87¢ (actually 88¢ was target)
    // This is a +40% profit trade - should not be blocked by 1¢ difference
    const entryPrice = 0.621;
    const targetBid = 0.88;
    const actualBid = 0.87; // 1¢ below target

    const minAcceptable = calculateMinAcceptablePrice(targetBid, 2);
    const wouldExecute = actualBid >= minAcceptable;

    assert.ok(wouldExecute, "Trade should execute with 2% slippage tolerance");

    // Verify still profitable even with slippage
    const profitPct = ((actualBid - entryPrice) / entryPrice) * 100;
    assert.ok(profitPct > 30, `Still profitable: ${profitPct.toFixed(1)}%`);
  });

  test("extremely low bid should still be blocked", () => {
    // If bid drops significantly (e.g., 50%), slippage shouldn't make us dump
    const targetBid = 0.88;
    const veryLowBid = 0.44; // 50% drop

    const minAcceptable = calculateMinAcceptablePrice(targetBid, 2);
    const wouldExecute = veryLowBid >= minAcceptable;

    assert.ok(!wouldExecute, "Very low bid should still be blocked");
  });

  test("slippage calculation preserves 2 decimal precision for cents", () => {
    // Common bid prices should result in clean cent values
    const bid = 0.87;
    const minAcceptable = calculateMinAcceptablePrice(bid, 2);

    // 87¢ * 0.98 = 85.26¢
    // Convert dollars to cents (x100) with 2 decimal precision (round to 0.01)
    const minCents = Math.round(minAcceptable * 100 * 100) / 100;
    assert.equal(minCents, 85.26);
  });
});

describe("Falling Knife Slippage Scenarios", () => {
  test("falling knife slippage accepts much lower prices", () => {
    // At 50¢ bid with 25% slippage, min acceptable = 50 * 0.75 = 37.5¢
    const bid = 0.50;
    const minAcceptable = calculateMinAcceptablePrice(bid, FALLING_KNIFE_SLIPPAGE_PCT);

    assert.equal(minAcceptable, 0.375);
    // Still recovering 75% of the current bid value
    assert.ok(minAcceptable / bid >= 0.75, "Should recover at least 75% of bid value");
  });

  test("emergency slippage accepts very low prices", () => {
    // At 50¢ bid with 50% slippage, min acceptable = 50 * 0.50 = 25¢
    const bid = 0.50;
    const minAcceptable = calculateMinAcceptablePrice(bid, EMERGENCY_SELL_SLIPPAGE_PCT);

    assert.equal(minAcceptable, 0.25);
    // Still recovering 50% of the current bid value - better than zero!
    assert.ok(minAcceptable / bid >= 0.50, "Should recover at least 50% of bid value");
  });

  test("falling knife slippage vs old 1 cent floor comparison", () => {
    // Old behavior: hardcoded 1¢ floor
    // New behavior: 25% slippage from current bid

    // At 50¢ bid:
    // - Old: accepts any price above 1¢ (could lose 98% of position value)
    // - New: accepts any price above 37.5¢ (loses max 25% of current value)
    const bid = 0.50;
    const oldMinPrice = 0.01; // Old hardcoded floor
    const newMinPrice = calculateMinAcceptablePrice(bid, FALLING_KNIFE_SLIPPAGE_PCT);

    assert.ok(newMinPrice > oldMinPrice, "New floor should be higher than old 1¢ floor");
    assert.equal(newMinPrice, 0.375);

    // Value recovery comparison
    const oldRecoveryPct = (oldMinPrice / bid) * 100;
    const newRecoveryPct = (newMinPrice / bid) * 100;

    assert.ok(newRecoveryPct > 50, "New slippage should recover more than 50% of value");
    assert.ok(oldRecoveryPct < 5, "Old 1¢ floor recovered less than 5% of value");
  });

  test("beggars cant be choosers - falling knife still fills in volatile markets", () => {
    // In a rapidly falling market, price might drop 15-20% between decision and execution
    // FALLING_KNIFE_SLIPPAGE_PCT (25%) is liberal enough to still fill

    const decisionBid = 0.50; // Bid when we decided to sell
    const executionBid = 0.40; // Bid dropped 20% by execution time

    const minAcceptable = calculateMinAcceptablePrice(decisionBid, FALLING_KNIFE_SLIPPAGE_PCT);

    // 50¢ * 0.75 = 37.5¢
    // 40¢ > 37.5¢, so the order would still fill
    assert.ok(executionBid >= minAcceptable, "Order should still fill after 20% drop");
  });

  test("slippage tier progression matches urgency", () => {
    const bid = 0.80;

    const defaultMin = calculateMinAcceptablePrice(bid, DEFAULT_SELL_SLIPPAGE_PCT);
    const staleMin = calculateMinAcceptablePrice(bid, STALE_SELL_SLIPPAGE_PCT);
    const urgentMin = calculateMinAcceptablePrice(bid, URGENT_SELL_SLIPPAGE_PCT);
    const fallingKnifeMin = calculateMinAcceptablePrice(bid, FALLING_KNIFE_SLIPPAGE_PCT);
    const emergencyMin = calculateMinAcceptablePrice(bid, EMERGENCY_SELL_SLIPPAGE_PCT);

    // At 80¢ bid:
    // - Default (2%): 78.4¢
    // - Stale (3%): 77.6¢
    // - Urgent (10%): 72¢
    // - Falling Knife (25%): 60¢
    // - Emergency (50%): 40¢
    // Use toFixed to handle floating point precision
    assert.equal(defaultMin.toFixed(3), "0.784");
    assert.equal(staleMin.toFixed(3), "0.776");
    assert.equal(urgentMin.toFixed(2), "0.72");
    assert.equal(fallingKnifeMin.toFixed(1), "0.6");
    assert.equal(emergencyMin.toFixed(1), "0.4");

    // Verify progression
    assert.ok(defaultMin > staleMin, "Default more restrictive than Stale");
    assert.ok(staleMin > urgentMin, "Stale more restrictive than Urgent");
    assert.ok(urgentMin > fallingKnifeMin, "Urgent more restrictive than Falling Knife");
    assert.ok(fallingKnifeMin > emergencyMin, "Falling Knife more restrictive than Emergency");
  });

  test("low price falling knife scenario", () => {
    // Even at low prices, falling knife slippage provides graceful degradation
    const bid = 0.20; // Position already fallen to 20¢

    const fallingKnifeMin = calculateMinAcceptablePrice(bid, FALLING_KNIFE_SLIPPAGE_PCT);
    // 20¢ * 0.75 = 15¢
    assert.equal(fallingKnifeMin.toFixed(2), "0.15");

    // Compare to old 1¢ floor - new is much better
    assert.ok(fallingKnifeMin > 0.01, "Still better than old 1¢ floor");

    // But accepts a wide range to ensure fill
    const wouldFill = 0.16; // Bid at execution
    assert.ok(wouldFill >= fallingKnifeMin, "Should fill at 16¢");
  });
});
