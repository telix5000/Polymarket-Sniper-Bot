/**
 * Math Edge Cases Tests
 *
 * Tests for mathematical edge cases that could cause issues in production:
 * - Division by zero
 * - NaN propagation
 * - Infinity handling
 * - Floating point precision
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";

import {
  EvTracker,
  createTradeResult,
  calculatePnlCents,
  calculatePnlUsd,
} from "../../../src/core/ev-tracker";

import {
  createDynamicEvEngine,
  EV_DEFAULTS,
  type TradeOutcome,
} from "../../../src/core/dynamic-ev-engine";

import { PositionManager } from "../../../src/core/position-manager";

import {
  analyzeLiquidity,
  type OrderBookLevel,
} from "../../../src/core/smart-sell";

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

function createWinningTrade(pnlCents = 14): TradeOutcome {
  return {
    tokenId: "test-token",
    side: "LONG",
    entryPriceCents: 50,
    exitPriceCents: 50 + pnlCents,
    sizeUsd: 25,
    timestamp: Date.now(),
    pnlCents,
    pnlUsd: (pnlCents / 100) * (25 / 0.5),
    isWin: true,
    spreadCents: 1,
    slippageCents: 0.5,
    feesCents: 0.5,
    wasHedged: false,
    hedgePnlCents: 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EV Tracker Edge Cases
// ═══════════════════════════════════════════════════════════════════════════

describe("EV Tracker - Edge Cases", () => {
  let tracker: EvTracker;

  beforeEach(() => {
    tracker = new EvTracker();
  });

  describe("Profit Factor Edge Cases", () => {
    it("should return Infinity when all trades are wins (no losses)", () => {
      // Record only winning trades
      for (let i = 0; i < 10; i++) {
        tracker.recordTrade(createTradeResult("token-1", "LONG", 50, 64, 25));
      }

      const metrics = tracker.getMetrics();

      // With no losses, profit factor should be Infinity (not 0)
      assert.strictEqual(
        metrics.profitFactor,
        Infinity,
        "Profit factor should be Infinity when no losses",
      );
      assert.ok(Number.isFinite(metrics.evCents), "EV should still be finite");
    });

    it("should handle only break-even trades (classified as losses)", () => {
      // Record break-even trades (pnlCents = 0)
      for (let i = 0; i < 10; i++) {
        tracker.recordTrade(createTradeResult("token-1", "LONG", 50, 50, 25));
      }

      const metrics = tracker.getMetrics();

      // All trades are break-even (pnlCents = 0), classified as losses
      assert.strictEqual(metrics.wins, 0);
      assert.strictEqual(metrics.losses, 10);
      assert.strictEqual(metrics.avgWinCents, 0);
      assert.strictEqual(metrics.avgLossCents, 0); // Math.abs(0) = 0
      assert.strictEqual(metrics.profitFactor, 0); // 0 / 0 case handled
    });

    it("should handle mix where avgWinCents and avgLossCents are both 0", () => {
      // This shouldn't happen in practice, but test the edge case
      const tracker = new EvTracker();

      // Record a single break-even trade
      tracker.recordTrade(createTradeResult("token-1", "LONG", 50, 50, 25));

      const metrics = tracker.getMetrics();

      assert.ok(Number.isFinite(metrics.profitFactor));
      assert.ok(Number.isFinite(metrics.evCents));
    });
  });

  describe("P&L Calculation Edge Cases", () => {
    it("should handle zero entry price gracefully", () => {
      const pnlUsd = calculatePnlUsd(10, 25, 0);
      assert.strictEqual(pnlUsd, 0, "Should return 0 for zero entry price");
    });

    it("should calculate P&L correctly for LONG positions", () => {
      assert.strictEqual(calculatePnlCents("LONG", 50, 60), 10);
      assert.strictEqual(calculatePnlCents("LONG", 50, 40), -10);
      assert.strictEqual(calculatePnlCents("LONG", 50, 50), 0);
    });

    it("should calculate P&L correctly for SHORT positions", () => {
      assert.strictEqual(calculatePnlCents("SHORT", 50, 40), 10);
      assert.strictEqual(calculatePnlCents("SHORT", 50, 60), -10);
      assert.strictEqual(calculatePnlCents("SHORT", 50, 50), 0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Dynamic EV Engine Edge Cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Dynamic EV Engine - Edge Cases", () => {
  describe("Break-even Win Rate Calculation", () => {
    it("should bound break-even rate to [0, 1]", () => {
      const engine = createDynamicEvEngine();
      const metrics = engine.getMetrics();

      assert.ok(
        metrics.breakEvenWinRate >= 0 && metrics.breakEvenWinRate <= 1,
        `Break-even rate ${metrics.breakEvenWinRate} should be in [0, 1]`,
      );
    });

    it("should handle extreme win/loss ratios", () => {
      const engine = createDynamicEvEngine();

      // Record trades with very high wins
      for (let i = 0; i < 20; i++) {
        engine.recordTrade(createWinningTrade(50)); // Very high wins
      }

      const metrics = engine.getMetrics();
      assert.ok(
        Number.isFinite(metrics.breakEvenWinRate),
        "Break-even rate should be finite",
      );
      assert.ok(
        metrics.breakEvenWinRate >= 0 && metrics.breakEvenWinRate <= 1,
        "Break-even rate should be valid probability",
      );
    });
  });

  describe("Win Rate Clamping", () => {
    it("should clamp win rate to [0, 1]", () => {
      const engine = createDynamicEvEngine();

      for (let i = 0; i < 30; i++) {
        engine.recordTrade(createWinningTrade());
      }

      const metrics = engine.getMetrics();
      assert.ok(metrics.winRate >= 0, "Win rate should be >= 0");
      assert.ok(metrics.winRate <= 1, "Win rate should be <= 1");
    });
  });

  describe("Division by Zero Guards", () => {
    it("should handle zero avgLossCents in profit factor", () => {
      const engine = createDynamicEvEngine();

      // Only wins
      for (let i = 0; i < 10; i++) {
        engine.recordTrade(createWinningTrade());
      }

      engine.unpause();
      const decision = engine.evaluateEntry();

      // Should not fail or return NaN
      assert.ok(decision.allowed !== undefined, "Decision should be valid");
      assert.ok(Number.isFinite(decision.evCents), "EV should be finite");
    });

    it("should calculate break-even rate from default values correctly", () => {
      const engine = createDynamicEvEngine();
      const metrics = engine.getMetrics();

      // Break-even = (avg_loss + churn) / (avg_win + avg_loss)
      // = (9 + 2) / (14 + 9) = 11 / 23 ≈ 0.478
      const expectedBreakEven =
        (EV_DEFAULTS.AVG_LOSS_CENTS + EV_DEFAULTS.CHURN_COST_CENTS) /
        (EV_DEFAULTS.AVG_WIN_CENTS + EV_DEFAULTS.AVG_LOSS_CENTS);

      // Should match the formula
      assert.ok(
        Math.abs(metrics.breakEvenWinRate - expectedBreakEven) < 0.0001,
        `Break-even rate ${metrics.breakEvenWinRate} should match formula result ${expectedBreakEven}`,
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Position Manager Edge Cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Position Manager - Edge Cases", () => {
  let manager: PositionManager;

  beforeEach(() => {
    manager = new PositionManager({
      tpCents: 14,
      hedgeTriggerCents: 16,
      maxAdverseCents: 30,
      maxHoldSeconds: 3600,
      hedgeRatio: 0.4,
      maxHedgeRatio: 0.7,
    });
  });

  describe("Division by Zero in Shares Calculation", () => {
    it("should handle zero entry price in updatePrice", () => {
      // Open a normal position first
      const position = manager.openPosition({
        tokenId: "test-token",
        marketId: "test-market",
        side: "LONG",
        entryPriceCents: 50,
        sizeUsd: 25,
        referencePriceCents: 50,
        evSnapshot: null,
        biasDirection: "LONG",
      });

      // Manually set entry price to 0 to test guard
      (position as any).entryPriceCents = 0;

      // Should not throw or produce NaN
      manager.updatePrice(position.id, 55, null, "LONG");

      // Position P&L should be 0 when entry price is 0
      const updatedPosition = manager.getPosition(position.id);
      assert.ok(
        Number.isFinite(updatedPosition?.unrealizedPnlUsd),
        "P&L should be finite",
      );
    });

    it("should handle zero entry price in closePosition", () => {
      // Open a normal position first
      const position = manager.openPosition({
        tokenId: "test-token",
        marketId: "test-market",
        side: "LONG",
        entryPriceCents: 50,
        sizeUsd: 25,
        referencePriceCents: 50,
        evSnapshot: null,
        biasDirection: "LONG",
      });

      // Manually set entry price to 0
      (position as any).entryPriceCents = 0;

      // Should not throw
      const closedPosition = manager.closePosition(
        position.id,
        60,
        null,
        "LONG",
      );

      assert.ok(closedPosition, "Should return closed position");
      assert.ok(
        Number.isFinite(closedPosition?.unrealizedPnlUsd),
        "P&L should be finite",
      );
    });
  });

  describe("P&L Calculation Consistency", () => {
    it("should calculate LONG P&L correctly", () => {
      const position = manager.openPosition({
        tokenId: "test-token",
        side: "LONG",
        entryPriceCents: 50,
        sizeUsd: 25,
        referencePriceCents: 50,
        evSnapshot: null,
        biasDirection: "LONG",
      });

      manager.updatePrice(position.id, 60, null, "LONG");

      const updated = manager.getPosition(position.id);
      // P&L cents = 60 - 50 = 10
      assert.strictEqual(updated?.unrealizedPnlCents, 10);
    });

    it("should calculate SHORT P&L correctly", () => {
      const position = manager.openPosition({
        tokenId: "test-token",
        side: "SHORT",
        entryPriceCents: 50,
        sizeUsd: 25,
        referencePriceCents: 50,
        evSnapshot: null,
        biasDirection: "SHORT",
      });

      manager.updatePrice(position.id, 40, null, "SHORT");

      const updated = manager.getPosition(position.id);
      // P&L cents = 50 - 40 = 10 (SHORT profits when price goes down)
      assert.strictEqual(updated?.unrealizedPnlCents, 10);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Liquidity Analysis Edge Cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Liquidity Analysis - Edge Cases", () => {
  describe("Input Validation", () => {
    it("should handle empty bids array", () => {
      const result = analyzeLiquidity([], 100, 5);
      assert.strictEqual(result.bestBid, 0);
      assert.strictEqual(result.canFill, false);
    });

    it("should handle null bids", () => {
      const result = analyzeLiquidity(null as any, 100, 5);
      assert.strictEqual(result.bestBid, 0);
      assert.strictEqual(result.canFill, false);
    });

    it("should handle undefined bids", () => {
      const result = analyzeLiquidity(undefined as any, 100, 5);
      assert.strictEqual(result.bestBid, 0);
      assert.strictEqual(result.canFill, false);
    });

    it("should handle zero shares to sell", () => {
      const bids: OrderBookLevel[] = [{ price: 0.5, size: 100 }];
      const result = analyzeLiquidity(bids, 0, 5);
      assert.strictEqual(result.canFill, false);
    });

    it("should handle negative shares to sell", () => {
      const bids: OrderBookLevel[] = [{ price: 0.5, size: 100 }];
      const result = analyzeLiquidity(bids, -100, 5);
      assert.strictEqual(result.canFill, false);
    });
  });

  describe("Invalid Bid Data", () => {
    it("should filter out bids with zero price", () => {
      const bids: OrderBookLevel[] = [
        { price: 0, size: 100 },
        { price: 0.5, size: 100 },
      ];
      const result = analyzeLiquidity(bids, 50, 5);
      assert.strictEqual(result.bestBid, 0.5, "Should use valid bid price");
    });

    it("should filter out bids with negative price", () => {
      const bids: OrderBookLevel[] = [
        { price: -0.5, size: 100 },
        { price: 0.5, size: 100 },
      ];
      const result = analyzeLiquidity(bids, 50, 5);
      assert.strictEqual(result.bestBid, 0.5);
    });

    it("should filter out bids with zero size", () => {
      const bids: OrderBookLevel[] = [
        { price: 0.6, size: 0 },
        { price: 0.5, size: 100 },
      ];
      const result = analyzeLiquidity(bids, 50, 5);
      // 0.6 price has size 0, so best usable bid is 0.5
      assert.strictEqual(result.bestBid, 0.5);
    });

    it("should filter out bids with NaN price", () => {
      const bids: OrderBookLevel[] = [
        { price: NaN, size: 100 },
        { price: 0.5, size: 100 },
      ];
      const result = analyzeLiquidity(bids, 50, 5);
      assert.strictEqual(result.bestBid, 0.5);
    });

    it("should filter out bids with Infinity price", () => {
      const bids: OrderBookLevel[] = [
        { price: Infinity, size: 100 },
        { price: 0.5, size: 100 },
      ];
      const result = analyzeLiquidity(bids, 50, 5);
      assert.strictEqual(result.bestBid, 0.5);
    });

    it("should return empty analysis when all bids are invalid", () => {
      const bids: OrderBookLevel[] = [
        { price: 0, size: 100 },
        { price: -0.5, size: 100 },
        { price: NaN, size: 100 },
      ];
      const result = analyzeLiquidity(bids, 50, 5);
      assert.strictEqual(result.bestBid, 0);
      assert.strictEqual(result.canFill, false);
    });
  });

  describe("Sorting Stability", () => {
    it("should prefer larger size at same price", () => {
      const bids: OrderBookLevel[] = [
        { price: 0.5, size: 50 },
        { price: 0.5, size: 100 }, // Same price, larger size
      ];
      const result = analyzeLiquidity(bids, 50, 5);

      // Should use the larger size level
      assert.strictEqual(result.bestBid, 0.5);
      assert.strictEqual(result.levelsNeeded, 1);
    });
  });
});
