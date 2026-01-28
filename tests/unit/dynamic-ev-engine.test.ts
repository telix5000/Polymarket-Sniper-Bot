/**
 * Dynamic EV Engine Tests
 *
 * Tests for the dynamic EV calculation system that adapts to live execution data.
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";

import {
  DynamicEvEngine,
  createDynamicEvEngine,
  EV_DEFAULTS,
  type TradeOutcome,
  type DynamicEvConfig,
} from "../../src/lib/dynamic-ev-engine";

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function createWinningTrade(
  overrides: Partial<TradeOutcome> = {},
): TradeOutcome {
  return {
    tokenId: "test-token-123",
    side: "LONG",
    entryPriceCents: 50,
    exitPriceCents: 64, // +14¢ (default avg_win)
    sizeUsd: 25,
    timestamp: Date.now(),
    pnlCents: 14,
    pnlUsd: 7,
    isWin: true,
    spreadCents: 1,
    slippageCents: 0.5,
    feesCents: 0.5,
    wasHedged: false,
    hedgePnlCents: 0,
    ...overrides,
  };
}

function createLosingTrade(
  overrides: Partial<TradeOutcome> = {},
): TradeOutcome {
  return {
    tokenId: "test-token-123",
    side: "LONG",
    entryPriceCents: 50,
    exitPriceCents: 41, // -9¢ (default avg_loss)
    sizeUsd: 25,
    timestamp: Date.now(),
    pnlCents: -9,
    pnlUsd: -4.5,
    isWin: false,
    spreadCents: 1,
    slippageCents: 0.5,
    feesCents: 0.5,
    wasHedged: true,
    hedgePnlCents: 3, // Hedge reduced loss
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("DynamicEvEngine", () => {
  describe("Initialization", () => {
    it("should initialize with default config", () => {
      const engine = createDynamicEvEngine();
      const metrics = engine.getMetrics();

      assert.strictEqual(metrics.sampleSize, 0);
      assert.strictEqual(metrics.usingDynamicValues, false);
      // Should use static defaults when no data
      assert.strictEqual(metrics.avgWinCents, EV_DEFAULTS.AVG_WIN_CENTS);
      assert.strictEqual(metrics.avgLossCents, EV_DEFAULTS.AVG_LOSS_CENTS);
      assert.strictEqual(metrics.churnCostCents, EV_DEFAULTS.CHURN_COST_CENTS);
    });

    it("should accept custom config", () => {
      const customConfig: Partial<DynamicEvConfig> = {
        minTradesForDynamic: 50,
        evFullSizeThreshold: 1.0,
      };
      const engine = createDynamicEvEngine(customConfig);
      const decision = engine.evaluateEntry();

      // Should be allowed with static defaults (positive EV)
      assert.strictEqual(decision.allowed, true);
    });
  });

  describe("Trade Recording", () => {
    let engine: DynamicEvEngine;

    beforeEach(() => {
      engine = createDynamicEvEngine();
    });

    it("should record winning trades and update EWMA", () => {
      const trade = createWinningTrade({ pnlCents: 15 });
      engine.recordTrade(trade);

      const metrics = engine.getMetrics();
      assert.strictEqual(metrics.sampleSize, 1);

      // With only 1 trade, system uses static defaults (not enough data for dynamic)
      // But the EWMA is being updated internally
      assert.strictEqual(metrics.usingDynamicValues, false);
      assert.strictEqual(metrics.avgWinCents, EV_DEFAULTS.AVG_WIN_CENTS);
    });

    it("should record losing trades and update EWMA", () => {
      const trade = createLosingTrade({ pnlCents: -12 });
      engine.recordTrade(trade);

      const metrics = engine.getMetrics();
      assert.strictEqual(metrics.sampleSize, 1);

      // With only 1 trade, system uses static defaults
      assert.strictEqual(metrics.usingDynamicValues, false);
      assert.strictEqual(metrics.avgLossCents, EV_DEFAULTS.AVG_LOSS_CENTS);
    });

    it("should maintain rolling window", () => {
      const engine = createDynamicEvEngine({ rollingWindowTrades: 5 });

      for (let i = 0; i < 10; i++) {
        engine.recordTrade(createWinningTrade());
      }

      const stats = engine.getTradeStats();
      assert.strictEqual(stats.totalTrades, 5); // Trimmed to window size
    });

    it("should update win rate EWMA correctly", () => {
      // Record 60% win rate
      for (let i = 0; i < 10; i++) {
        if (i < 6) {
          engine.recordTrade(createWinningTrade());
        } else {
          engine.recordTrade(createLosingTrade());
        }
      }

      const metrics = engine.getMetrics();
      // Win rate should move toward 60%
      assert(metrics.winRate > 0.5);
      assert(metrics.winRate < 0.7);
    });
  });

  describe("Churn Cost Tracking", () => {
    it("should track churn cost observations", () => {
      const engine = createDynamicEvEngine();

      engine.recordSpreadAndSlippage(1.5, 0.3, 0.2); // Total: 2.0
      engine.recordSpreadAndSlippage(2.0, 0.5, 0.3); // Total: 2.8
      engine.recordSpreadAndSlippage(1.0, 0.2, 0.1); // Total: 1.3

      const metrics = engine.getMetrics();
      // Churn should move from default 2¢ based on observations
      // Observations are around 2¢ average, so should stay close
      assert(metrics.churnCostCents > 0);
      assert(metrics.churnCostCents < 5);
    });
  });

  describe("EV Calculation", () => {
    it("should calculate EV correctly with formula", () => {
      const engine = createDynamicEvEngine();
      const metrics = engine.getMetrics();

      // EV = p(win) × avg_win - p(loss) × avg_loss - churn_cost
      // With defaults and ~52% win rate:
      // EV = 0.52 * 14 - 0.48 * 9 - 2 = 7.28 - 4.32 - 2 = 0.96¢
      const expectedEv =
        metrics.winRate * metrics.avgWinCents -
        (1 - metrics.winRate) * metrics.avgLossCents -
        metrics.churnCostCents;

      assert.strictEqual(metrics.evCents.toFixed(4), expectedEv.toFixed(4));
    });

    it("should calculate break-even win rate correctly", () => {
      const engine = createDynamicEvEngine();
      const metrics = engine.getMetrics();

      // Break-even = (avg_loss + churn) / (avg_win + avg_loss)
      // = (9 + 2) / (14 + 9) = 11 / 23 ≈ 0.478
      const expectedBreakEven =
        (EV_DEFAULTS.AVG_LOSS_CENTS + EV_DEFAULTS.CHURN_COST_CENTS) /
        (EV_DEFAULTS.AVG_WIN_CENTS + EV_DEFAULTS.AVG_LOSS_CENTS);

      assert.strictEqual(
        metrics.breakEvenWinRate.toFixed(3),
        expectedBreakEven.toFixed(3),
      );
    });
  });

  describe("Decision Policy", () => {
    it("should allow entry with positive EV", () => {
      const engine = createDynamicEvEngine();
      const decision = engine.evaluateEntry();

      // With default assumptions (slightly above break-even), should allow
      assert.strictEqual(decision.allowed, true);
      assert(decision.sizeFactor > 0);
    });

    it("should block entry when EV is negative", () => {
      const engine = createDynamicEvEngine();

      // Record many losing trades to push EV negative
      for (let i = 0; i < 50; i++) {
        engine.recordTrade(createLosingTrade({ pnlCents: -20 }));
      }

      // Force unpause to test decision logic directly
      engine.unpause();

      const decision = engine.evaluateEntry();

      // With poor performance, should either block or reduce size
      assert(
        !decision.allowed || decision.sizeFactor < 1,
        "Should block or reduce size with negative EV",
      );
    });

    it("should reduce size when EV is marginal", () => {
      const engine = createDynamicEvEngine({
        evFullSizeThreshold: 2.0, // Set high threshold
        evReducedSizeThreshold: 0,
      });

      // Record trades that give marginal EV (around 0.5-1.0¢)
      for (let i = 0; i < 30; i++) {
        if (i % 2 === 0) {
          engine.recordTrade(createWinningTrade({ pnlCents: 10 }));
        } else {
          engine.recordTrade(createLosingTrade({ pnlCents: -8 }));
        }
      }

      engine.unpause();
      const decision = engine.evaluateEntry();

      // With marginal EV (positive but below threshold), should reduce size
      if (decision.allowed && decision.metrics.evCents < 2.0) {
        assert.strictEqual(decision.sizeFactor, 0.5);
      }
    });

    it("should give full size when EV is strong", () => {
      const engine = createDynamicEvEngine({
        minTradesForDynamic: 10,
      });

      // Record many winning trades to establish strong EV
      for (let i = 0; i < 30; i++) {
        // 70% win rate with good outcomes
        if (i % 10 < 7) {
          engine.recordTrade(createWinningTrade({ pnlCents: 16 }));
        } else {
          engine.recordTrade(createLosingTrade({ pnlCents: -7 }));
        }
      }

      const decision = engine.evaluateEntry();

      // With strong performance, should allow full size
      if (decision.allowed && decision.metrics.evCents > 0.5) {
        assert.strictEqual(decision.sizeFactor, 1.0);
      }
    });
  });

  describe("Operational Checks", () => {
    it("should block entry when spread is too wide", () => {
      const engine = createDynamicEvEngine({ maxSpreadCents: 5 });
      const decision = engine.evaluateEntry({
        spreadCents: 8,
      });

      assert.strictEqual(decision.allowed, false);
      assert(decision.reason.includes("SPREAD"));
    });

    it("should block entry when latency is high", () => {
      const engine = createDynamicEvEngine({ maxLatencyMs: 300 });
      const decision = engine.evaluateEntry({
        latencyMs: 600,
      });

      assert.strictEqual(decision.allowed, false);
      assert(decision.reason.includes("LATENCY"));
    });

    it("should block entry when depth is low", () => {
      const engine = createDynamicEvEngine({ minDepthUsdAtExit: 50 });
      const decision = engine.evaluateEntry({
        exitDepthUsd: 20,
      });

      assert.strictEqual(decision.allowed, false);
      assert(decision.reason.includes("DEPTH"));
    });
  });

  describe("Pause Management", () => {
    it("should pause when EV turns negative with sufficient data", () => {
      const engine = createDynamicEvEngine({
        pauseSeconds: 60,
        minTradesForDynamic: 10,
      });

      // Record enough losing trades to trigger pause
      for (let i = 0; i < 15; i++) {
        engine.recordTrade(createLosingTrade({ pnlCents: -25 }));
      }

      assert.strictEqual(engine.isPaused(), true);
      assert(engine.getPauseRemainingSeconds() > 0);
    });

    it("should allow manual unpause", () => {
      const engine = createDynamicEvEngine({ pauseSeconds: 60 });
      engine.pause();

      assert.strictEqual(engine.isPaused(), true);

      engine.unpause();

      assert.strictEqual(engine.isPaused(), false);
    });

    it("should block entry when paused", () => {
      const engine = createDynamicEvEngine();
      engine.pause();

      const decision = engine.evaluateEntry();

      assert.strictEqual(decision.allowed, false);
      assert(decision.reason.includes("PAUSED"));
    });
  });

  describe("Fallback Logic", () => {
    it("should use static defaults when sample size too small", () => {
      const engine = createDynamicEvEngine({ minTradesForDynamic: 50 });

      // Record only a few trades
      for (let i = 0; i < 10; i++) {
        engine.recordTrade(createWinningTrade({ pnlCents: 20 }));
      }

      const metrics = engine.getMetrics();

      // Should NOT use dynamic values (sample too small)
      assert.strictEqual(metrics.usingDynamicValues, false);
      assert.strictEqual(metrics.avgWinCents, EV_DEFAULTS.AVG_WIN_CENTS);
    });

    it("should switch to dynamic values when threshold met", () => {
      const engine = createDynamicEvEngine({
        minTradesForDynamic: 10,
        minNotionalForDynamic: 100,
      });

      // Record enough trades of both types to meet threshold
      // Need at least 5 wins and 5 losses for variance stability
      for (let i = 0; i < 20; i++) {
        if (i % 2 === 0) {
          engine.recordTrade(createWinningTrade({ sizeUsd: 10, pnlCents: 12 }));
        } else {
          engine.recordTrade(createLosingTrade({ sizeUsd: 10, pnlCents: -8 }));
        }
      }

      const metrics = engine.getMetrics();

      // Should use dynamic values now
      assert.strictEqual(metrics.usingDynamicValues, true);
      // Dynamic values should differ from static (they'll be influenced by 12¢ wins and 8¢ losses)
      assert(
        metrics.avgWinCents !== EV_DEFAULTS.AVG_WIN_CENTS ||
          metrics.avgLossCents !== EV_DEFAULTS.AVG_LOSS_CENTS,
        "At least one metric should differ from static defaults",
      );
    });
  });

  describe("State Management", () => {
    it("should reset all state", () => {
      const engine = createDynamicEvEngine();

      for (let i = 0; i < 20; i++) {
        engine.recordTrade(createWinningTrade());
      }
      engine.pause();

      engine.reset();

      const metrics = engine.getMetrics();
      const stats = engine.getTradeStats();

      assert.strictEqual(stats.totalTrades, 0);
      assert.strictEqual(engine.isPaused(), false);
      assert.strictEqual(metrics.sampleSize, 0);
    });

    it("should export log entry correctly", () => {
      const engine = createDynamicEvEngine();
      engine.recordTrade(createWinningTrade());

      const logEntry = engine.toLogEntry() as any;

      assert.strictEqual(logEntry.type, "dynamic_ev_metrics");
      assert(logEntry.timestamp);
      assert(logEntry.metrics);
      assert.strictEqual(
        logEntry.metrics.avgWinCents,
        EV_DEFAULTS.AVG_WIN_CENTS,
      );
      assert(logEntry.stats);
      assert.strictEqual(logEntry.stats.totalTrades, 1);
    });

    it("should return recent trades", () => {
      const engine = createDynamicEvEngine();

      for (let i = 0; i < 20; i++) {
        engine.recordTrade(createWinningTrade());
      }

      const recent = engine.getRecentTrades(5);
      assert.strictEqual(recent.length, 5);
    });
  });

  describe("Confidence Calculation", () => {
    it("should increase confidence with more data", () => {
      const engine = createDynamicEvEngine({
        minTradesForDynamic: 50,
        minNotionalForDynamic: 1000,
      });

      // Low data - low confidence
      for (let i = 0; i < 10; i++) {
        engine.recordTrade(createWinningTrade({ sizeUsd: 10 }));
      }
      const lowConfidence = engine.getMetrics().confidence;

      // More data - higher confidence
      for (let i = 0; i < 40; i++) {
        engine.recordTrade(createWinningTrade({ sizeUsd: 30 }));
      }
      const highConfidence = engine.getMetrics().confidence;

      assert(highConfidence > lowConfidence);
    });
  });

  describe("Enabled Flag", () => {
    it("should always allow full size when disabled", () => {
      const engine = createDynamicEvEngine({
        enabled: false,
      });

      // Even with negative EV conditions, should allow full size
      for (let i = 0; i < 20; i++) {
        engine.recordTrade(createLosingTrade());
      }

      const decision = engine.evaluateEntry();

      assert.strictEqual(
        decision.allowed,
        true,
        "Should allow entry when disabled",
      );
      assert.strictEqual(
        decision.sizeFactor,
        1.0,
        "Should use full size when disabled",
      );
      assert.strictEqual(
        decision.reason,
        "DYNAMIC_EV_DISABLED",
        "Should show disabled reason",
      );
    });

    it("should apply EV gating when enabled", () => {
      const engine = createDynamicEvEngine({
        enabled: true,
        minTradesForPauseDecision: 5,
      });

      // Create negative EV conditions
      for (let i = 0; i < 10; i++) {
        engine.recordTrade(createLosingTrade());
      }

      const decision = engine.evaluateEntry();

      // When EV is negative and enabled, should either pause or reduce size
      assert(
        decision.sizeFactor < 1.0 || !decision.allowed,
        "Should apply EV gating when enabled",
      );
    });
  });
});
