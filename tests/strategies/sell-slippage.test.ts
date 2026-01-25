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
