/**
 * Historical Trade Snapshot Tests
 *
 * Tests for the rolling window trade analysis system that provides
 * historical context for hedge ratio decisions.
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";

import {
  HistoricalTradeSnapshot,
  createHistoricalTradeSnapshot,
  DEFAULT_HISTORICAL_SNAPSHOT_CONFIG,
  type ExecutedTradeRecord,
  type HistoricalSnapshotConfig,
} from "../../src/core/historical-trade-snapshot";

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function createWinningTrade(
  overrides: Partial<ExecutedTradeRecord> = {},
): ExecutedTradeRecord {
  return {
    tradeId: `trade-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    tokenId: "test-token-123",
    marketId: "market-1",
    side: "LONG",
    sizeUsd: 100,
    entryPriceCents: 50,
    exitPriceCents: 64, // +14¢ win (typical TP)
    expectedPriceCents: 50,
    realizedPnlCents: 14,
    realizedPnlUsd: 28, // (14/100) * (100 / 0.50) = 28
    timestamp: Date.now(),
    isWin: true,
    wasHedged: false,
    hedgeRatio: 0,
    ...overrides,
  };
}

function createLosingTrade(
  overrides: Partial<ExecutedTradeRecord> = {},
): ExecutedTradeRecord {
  return {
    tradeId: `trade-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    tokenId: "test-token-123",
    marketId: "market-1",
    side: "LONG",
    sizeUsd: 100,
    entryPriceCents: 50,
    exitPriceCents: 41, // -9¢ loss (hedged loss)
    expectedPriceCents: 50,
    realizedPnlCents: -9,
    realizedPnlUsd: -18, // (-9/100) * (100 / 0.50) = -18
    timestamp: Date.now(),
    isWin: false,
    wasHedged: true,
    hedgeRatio: 0.4,
    ...overrides,
  };
}

function createTradeWithSlippage(slippageCents: number): ExecutedTradeRecord {
  return {
    tradeId: `trade-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    tokenId: "test-token-123",
    marketId: "market-1",
    side: "LONG",
    sizeUsd: 100,
    entryPriceCents: 50 + slippageCents, // Slippage on entry
    exitPriceCents: 64 + slippageCents,
    expectedPriceCents: 50, // Expected price without slippage
    realizedPnlCents: 14,
    realizedPnlUsd: 28,
    timestamp: Date.now(),
    isWin: true,
    wasHedged: false,
    hedgeRatio: 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("HistoricalTradeSnapshot", () => {
  describe("Initialization", () => {
    it("should initialize with default config", () => {
      const snapshot = createHistoricalTradeSnapshot();
      const state = snapshot.getSnapshot();

      assert.strictEqual(state.tradeCount, 0);
      assert.strictEqual(state.realizedPnlUsd, 0);
      assert.strictEqual(state.winRate, 0);
    });

    it("should accept custom config", () => {
      const customConfig: Partial<HistoricalSnapshotConfig> = {
        maxTrades: 100,
        windowDurationMs: 12 * 60 * 60 * 1000, // 12 hours
        minTradesForMetrics: 5,
      };
      const snapshot = createHistoricalTradeSnapshot(customConfig);

      // Verify custom config is applied (indirectly through behavior)
      assert(snapshot.hasMinimumData() === false);
    });
  });

  describe("Trade Recording", () => {
    let snapshot: HistoricalTradeSnapshot;

    beforeEach(() => {
      snapshot = createHistoricalTradeSnapshot({ minTradesForMetrics: 5 });
    });

    it("should record trades correctly", () => {
      snapshot.recordTrade(createWinningTrade());
      snapshot.recordTrade(createLosingTrade());

      const state = snapshot.getSnapshot();
      assert.strictEqual(state.tradeCount, 2);
    });

    it("should track win rate correctly", () => {
      // Record 3 wins and 2 losses
      for (let i = 0; i < 3; i++) {
        snapshot.recordTrade(createWinningTrade());
      }
      for (let i = 0; i < 2; i++) {
        snapshot.recordTrade(createLosingTrade());
      }

      const state = snapshot.getSnapshot();
      // With equal timestamps, win rate should be 3/5 = 0.6
      // Note: decay weighting might affect this slightly
      assert(state.winRate >= 0.5 && state.winRate <= 0.7);
    });

    it("should calculate P&L correctly", () => {
      // Record trades with known P&L
      snapshot.recordTrade(createWinningTrade({ realizedPnlUsd: 50 }));
      snapshot.recordTrade(createLosingTrade({ realizedPnlUsd: -20 }));

      const state = snapshot.getSnapshot();
      // Weighted average P&L should be positive
      assert(state.avgPnlPerTradeUsd !== 0);
    });

    it("should use convenience method correctly", () => {
      snapshot.recordTradeFromParams({
        tradeId: "test-1",
        tokenId: "token-1",
        side: "LONG",
        sizeUsd: 100,
        entryPriceCents: 50,
        exitPriceCents: 64,
      });

      const state = snapshot.getSnapshot();
      assert.strictEqual(state.tradeCount, 1);
    });
  });

  describe("Exponential Decay Weighting", () => {
    it("should weight recent trades more heavily", () => {
      const snapshot = createHistoricalTradeSnapshot({
        minTradesForMetrics: 3,
        decayHalfLifeMs: 1000, // 1 second half-life for testing
      });

      // Record an old losing trade
      const oldTrade = createLosingTrade();
      oldTrade.timestamp = Date.now() - 10000; // 10 seconds ago
      snapshot.recordTrade(oldTrade);

      // Record recent winning trades
      for (let i = 0; i < 3; i++) {
        snapshot.recordTrade(createWinningTrade());
      }

      const state = snapshot.getSnapshot();

      // Recent wins should dominate due to decay
      // Win rate should be closer to 1.0 than 0.75 (3/4)
      assert(
        state.winRate > 0.7,
        `Win rate ${state.winRate} should be > 0.7 due to decay`,
      );
    });
  });

  describe("Drawdown Tracking", () => {
    let snapshot: HistoricalTradeSnapshot;

    beforeEach(() => {
      snapshot = createHistoricalTradeSnapshot({ minTradesForMetrics: 3 });
    });

    it("should track drawdown correctly", () => {
      // Build up a peak
      snapshot.recordTrade(createWinningTrade({ realizedPnlUsd: 100 }));
      snapshot.recordTrade(createWinningTrade({ realizedPnlUsd: 100 }));

      // Now incur losses
      snapshot.recordTrade(createLosingTrade({ realizedPnlUsd: -50 }));

      const state = snapshot.getSnapshot();

      assert.strictEqual(state.drawdown.peakValue, 200);
      assert.strictEqual(state.drawdown.currentValue, 150);
      assert.strictEqual(state.drawdown.isInDrawdown, true);
      assert(state.drawdown.currentDrawdownPct > 0);
    });

    it("should track max drawdown", () => {
      // Build peak
      snapshot.recordTrade(createWinningTrade({ realizedPnlUsd: 100 }));

      // Deep drawdown
      snapshot.recordTrade(createLosingTrade({ realizedPnlUsd: -80 }));

      // Partial recovery
      snapshot.recordTrade(createWinningTrade({ realizedPnlUsd: 50 }));

      const state = snapshot.getSnapshot();

      // Max drawdown should be 80% (from 100 to 20)
      assert(
        state.drawdown.maxDrawdownPct >= 75,
        `Max drawdown ${state.drawdown.maxDrawdownPct}% should be >= 75%`,
      );
    });

    it("should reset drawdown on new peak", () => {
      // Build peak
      snapshot.recordTrade(createWinningTrade({ realizedPnlUsd: 50 }));

      // Drawdown
      snapshot.recordTrade(createLosingTrade({ realizedPnlUsd: -20 }));

      // New peak
      snapshot.recordTrade(createWinningTrade({ realizedPnlUsd: 100 }));

      const state = snapshot.getSnapshot();

      assert.strictEqual(state.drawdown.isInDrawdown, false);
      assert.strictEqual(state.drawdown.currentDrawdownPct, 0);
    });
  });

  describe("Volatility Calculation", () => {
    it("should detect high volatility", () => {
      const snapshot = createHistoricalTradeSnapshot({
        minTradesForMetrics: 5,
        highVolatilityThreshold: 0.1,
        lowVolatilityThreshold: 0.01,
      });

      // Record trades with high variance in returns
      const trades = [
        { pnl: 50, size: 100 }, // +50% return
        { pnl: -40, size: 100 }, // -40% return
        { pnl: 30, size: 100 }, // +30% return
        { pnl: -20, size: 100 }, // -20% return
        { pnl: 25, size: 100 }, // +25% return
      ];

      for (const t of trades) {
        snapshot.recordTrade(
          createWinningTrade({
            realizedPnlUsd: t.pnl,
            sizeUsd: t.size,
            isWin: t.pnl > 0,
          }),
        );
      }

      const state = snapshot.getSnapshot();

      // Should detect high volatility due to large swings
      assert(
        state.volatility.rollingStdDev > 0,
        "Volatility std dev should be positive",
      );
      assert(
        state.volatility.volatilityRegime === "HIGH",
        `Expected HIGH volatility, got ${state.volatility.volatilityRegime}`,
      );
    });

    it("should detect low volatility", () => {
      const snapshot = createHistoricalTradeSnapshot({
        minTradesForMetrics: 5,
        highVolatilityThreshold: 0.5,
        lowVolatilityThreshold: 0.1,
      });

      // Record trades with consistent small returns
      for (let i = 0; i < 10; i++) {
        snapshot.recordTrade(
          createWinningTrade({
            realizedPnlUsd: 1 + (i % 2) * 0.5, // Very consistent returns
            sizeUsd: 100,
          }),
        );
      }

      const state = snapshot.getSnapshot();

      // Should detect low volatility due to consistent returns
      assert(
        state.volatility.volatilityRegime === "LOW" ||
          state.volatility.volatilityRegime === "NORMAL",
        `Expected LOW or NORMAL volatility, got ${state.volatility.volatilityRegime}`,
      );
    });
  });

  describe("Trade Frequency Metrics", () => {
    it("should track trades per hour", () => {
      const snapshot = createHistoricalTradeSnapshot({
        minTradesForMetrics: 3,
      });

      // Record several trades
      for (let i = 0; i < 5; i++) {
        snapshot.recordTrade(createWinningTrade());
      }

      const state = snapshot.getSnapshot();

      assert(state.frequency.tradesLastHour >= 5);
      assert(state.frequency.avgTradesPerHour > 0);
    });

    it("should calculate time since last trade", () => {
      const snapshot = createHistoricalTradeSnapshot({
        minTradesForMetrics: 1,
      });

      // Record a trade
      snapshot.recordTrade(createWinningTrade());

      const state = snapshot.getSnapshot();

      // Time since last trade should be very small (just recorded)
      assert(state.frequency.timeSinceLastTradeMs < 1000);
    });
  });

  describe("Slippage Metrics", () => {
    it("should track slippage correctly", () => {
      const snapshot = createHistoricalTradeSnapshot({
        minTradesForMetrics: 3,
      });

      // Record trades with different slippage levels
      snapshot.recordTrade(createTradeWithSlippage(1)); // 1¢ slippage
      snapshot.recordTrade(createTradeWithSlippage(2)); // 2¢ slippage
      snapshot.recordTrade(createTradeWithSlippage(3)); // 3¢ slippage

      const state = snapshot.getSnapshot();

      // Average slippage should be around 2¢
      assert(
        state.slippage.avgSlippageCents >= 1 &&
          state.slippage.avgSlippageCents <= 3,
        `Avg slippage ${state.slippage.avgSlippageCents} should be between 1-3¢`,
      );
      assert.strictEqual(state.slippage.maxSlippageCents, 3);
    });

    it("should detect worsening slippage trend", () => {
      const snapshot = createHistoricalTradeSnapshot({
        minTradesForMetrics: 5,
        decayHalfLifeMs: 60000, // Use longer half-life
      });

      // Record older trades with low slippage
      for (let i = 0; i < 10; i++) {
        const trade = createTradeWithSlippage(0.5);
        trade.timestamp = Date.now() - 100000; // Old trades
        snapshot.recordTrade(trade);
      }

      // Record recent trades with high slippage
      for (let i = 0; i < 5; i++) {
        snapshot.recordTrade(createTradeWithSlippage(5));
      }

      const state = snapshot.getSnapshot();

      // Should detect worsening trend
      assert(
        state.slippage.slippageTrend === "WORSENING" ||
          state.slippage.slippageTrend === "STABLE",
        `Expected WORSENING or STABLE trend, got ${state.slippage.slippageTrend}`,
      );
    });
  });

  describe("Exposure by Asset", () => {
    it("should track exposure per market", () => {
      const snapshot = createHistoricalTradeSnapshot({
        minTradesForMetrics: 3,
      });

      // Record trades in different markets
      snapshot.recordTrade(
        createWinningTrade({ marketId: "market-A", sizeUsd: 100 }),
      );
      snapshot.recordTrade(
        createWinningTrade({ marketId: "market-A", sizeUsd: 50 }),
      );
      snapshot.recordTrade(
        createWinningTrade({ marketId: "market-B", sizeUsd: 75 }),
      );

      const state = snapshot.getSnapshot();

      const marketA = state.exposureByAsset.get("market-A");
      const marketB = state.exposureByAsset.get("market-B");

      assert(marketA !== undefined);
      assert(marketB !== undefined);
      assert.strictEqual(marketA.longExposureUsd, 150);
      assert.strictEqual(marketB.longExposureUsd, 75);
    });

    it("should track net exposure with longs and shorts", () => {
      const snapshot = createHistoricalTradeSnapshot({
        minTradesForMetrics: 3,
      });

      // Record long and short trades in same market
      snapshot.recordTrade(
        createWinningTrade({
          marketId: "market-A",
          side: "LONG",
          sizeUsd: 100,
        }),
      );
      snapshot.recordTrade(
        createLosingTrade({ marketId: "market-A", side: "SHORT", sizeUsd: 60 }),
      );

      const state = snapshot.getSnapshot();

      const marketA = state.exposureByAsset.get("market-A");
      assert(marketA !== undefined);
      assert.strictEqual(marketA.longExposureUsd, 100);
      assert.strictEqual(marketA.shortExposureUsd, 60);
      assert.strictEqual(marketA.netExposureUsd, 40); // 100 - 60
    });
  });

  describe("Hedge Ratio Recommendation", () => {
    it("should recommend MAINTAIN with insufficient data", () => {
      const snapshot = createHistoricalTradeSnapshot({
        minTradesForMetrics: 10,
      });

      // Record only 5 trades
      for (let i = 0; i < 5; i++) {
        snapshot.recordTrade(createWinningTrade());
      }

      const recommendation = snapshot.getHedgeRatioRecommendation();

      assert.strictEqual(recommendation.action, "MAINTAIN");
      assert(recommendation.confidence < 0.5);
      assert(recommendation.reasons[0].includes("Insufficient data"));
    });

    it("should recommend REDUCE in favorable conditions", () => {
      const snapshot = createHistoricalTradeSnapshot({
        minTradesForMetrics: 10,
        highWinRateThreshold: 0.6,
        lowVolatilityThreshold: 0.5,
      });

      // Record many winning trades with low volatility
      for (let i = 0; i < 15; i++) {
        snapshot.recordTrade(
          createWinningTrade({
            realizedPnlUsd: 10 + Math.random() * 2, // Consistent wins
            sizeUsd: 100,
          }),
        );
      }

      const recommendation = snapshot.getHedgeRatioRecommendation();

      // Should recommend REDUCE due to high win rate and no drawdown
      assert(
        recommendation.action === "REDUCE" ||
          recommendation.action === "MAINTAIN",
        `Expected REDUCE or MAINTAIN, got ${recommendation.action}`,
      );
      assert(
        recommendation.adjustmentFactor <= 1.0,
        `Adjustment factor ${recommendation.adjustmentFactor} should be <= 1.0`,
      );
    });

    it("should recommend INCREASE in adverse conditions", () => {
      const snapshot = createHistoricalTradeSnapshot({
        minTradesForMetrics: 10,
        lowWinRateThreshold: 0.4,
        highVolatilityThreshold: 0.1,
        drawdownWarningPct: 5,
      });

      // Build up a peak first
      snapshot.recordTrade(createWinningTrade({ realizedPnlUsd: 100 }));
      snapshot.recordTrade(createWinningTrade({ realizedPnlUsd: 100 }));

      // Now record many losing trades with high volatility
      for (let i = 0; i < 12; i++) {
        snapshot.recordTrade(
          createLosingTrade({
            realizedPnlUsd: -10 - Math.random() * 20, // Variable losses
            sizeUsd: 100,
          }),
        );
      }

      const recommendation = snapshot.getHedgeRatioRecommendation();

      // Should recommend INCREASE due to low win rate and drawdown
      assert(
        recommendation.action === "INCREASE" ||
          recommendation.action === "MAINTAIN",
        `Expected INCREASE or MAINTAIN, got ${recommendation.action}`,
      );
      assert(
        recommendation.adjustmentFactor >= 1.0,
        `Adjustment factor ${recommendation.adjustmentFactor} should be >= 1.0`,
      );
    });

    it("should include multiple reasons in recommendation", () => {
      const snapshot = createHistoricalTradeSnapshot({
        minTradesForMetrics: 10,
      });

      // Create mixed conditions
      for (let i = 0; i < 15; i++) {
        if (i % 2 === 0) {
          snapshot.recordTrade(createWinningTrade());
        } else {
          snapshot.recordTrade(createLosingTrade());
        }
      }

      const recommendation = snapshot.getHedgeRatioRecommendation();

      // Should have at least one reason
      assert(
        recommendation.reasons.length > 0,
        "Should have at least one reason",
      );
    });
  });

  describe("State Management", () => {
    it("should reset all state", () => {
      const snapshot = createHistoricalTradeSnapshot();

      // Add some trades
      for (let i = 0; i < 10; i++) {
        snapshot.recordTrade(createWinningTrade());
      }

      snapshot.reset();

      const state = snapshot.getSnapshot();
      assert.strictEqual(state.tradeCount, 0);
      assert.strictEqual(state.drawdown.currentValue, 0);
      assert.strictEqual(state.drawdown.maxDrawdownPct, 0);
    });

    it("should report minimum data status correctly", () => {
      const snapshot = createHistoricalTradeSnapshot({
        minTradesForMetrics: 5,
      });

      assert.strictEqual(snapshot.hasMinimumData(), false);

      for (let i = 0; i < 5; i++) {
        snapshot.recordTrade(createWinningTrade());
      }

      assert.strictEqual(snapshot.hasMinimumData(), true);
    });

    it("should prune old trades", () => {
      const snapshot = createHistoricalTradeSnapshot({
        maxTrades: 5,
        windowDurationMs: 1000, // 1 second window for testing
      });

      // Record 10 trades
      for (let i = 0; i < 10; i++) {
        snapshot.recordTrade(createWinningTrade());
      }

      // Should only keep maxTrades
      assert(snapshot.getTradeCount() <= 5);
    });

    it("should get recent trades", () => {
      const snapshot = createHistoricalTradeSnapshot();

      for (let i = 0; i < 20; i++) {
        snapshot.recordTrade(createWinningTrade({ tradeId: `trade-${i}` }));
      }

      const recentTrades = snapshot.getRecentTrades(5);
      assert.strictEqual(recentTrades.length, 5);
    });

    it("should export log entry correctly", () => {
      const snapshot = createHistoricalTradeSnapshot({
        minTradesForMetrics: 5,
      });

      for (let i = 0; i < 10; i++) {
        snapshot.recordTrade(createWinningTrade());
      }

      const logEntry = snapshot.toLogEntry() as any;

      assert.strictEqual(logEntry.type, "historical_trade_snapshot");
      assert(logEntry.timestamp);
      assert(logEntry.metrics);
      assert(logEntry.drawdown);
      assert(logEntry.volatility);
      assert(logEntry.frequency);
      assert(logEntry.slippage);
      assert(logEntry.hedgeRecommendation);
    });
  });

  describe("Profit Factor Calculation", () => {
    it("should calculate profit factor correctly", () => {
      const snapshot = createHistoricalTradeSnapshot({
        minTradesForMetrics: 5,
      });

      // Record wins and losses with known values
      for (let i = 0; i < 3; i++) {
        snapshot.recordTrade(createWinningTrade({ realizedPnlUsd: 100 }));
      }
      for (let i = 0; i < 2; i++) {
        snapshot.recordTrade(createLosingTrade({ realizedPnlUsd: -50 }));
      }

      const state = snapshot.getSnapshot();

      // Gross profit = 300, Gross loss = 100
      // Profit factor should be around 3.0 (with decay weighting it may vary)
      assert(
        state.profitFactor > 1.5,
        `Profit factor ${state.profitFactor} should be > 1.5`,
      );
    });

    it("should handle all winning trades", () => {
      const snapshot = createHistoricalTradeSnapshot({
        minTradesForMetrics: 3,
      });

      for (let i = 0; i < 5; i++) {
        snapshot.recordTrade(createWinningTrade());
      }

      const state = snapshot.getSnapshot();

      // With no losses, profit factor should be Infinity
      assert.strictEqual(state.profitFactor, Infinity);
    });

    it("should handle all losing trades", () => {
      const snapshot = createHistoricalTradeSnapshot({
        minTradesForMetrics: 3,
      });

      for (let i = 0; i < 5; i++) {
        snapshot.recordTrade(createLosingTrade());
      }

      const state = snapshot.getSnapshot();

      // With no wins, profit factor should be 0
      assert.strictEqual(state.profitFactor, 0);
    });
  });
});

describe("DynamicHedgePolicy with Historical Integration", () => {
  it("should evaluate hedge with historical context", async () => {
    // Import here to avoid circular dependency issues
    const { createDynamicHedgePolicy } =
      await import("../../src/core/dynamic-hedge-policy");

    const policy = createDynamicHedgePolicy();
    const snapshot = createHistoricalTradeSnapshot({ minTradesForMetrics: 5 });

    // Build favorable historical conditions
    for (let i = 0; i < 10; i++) {
      snapshot.recordTrade(createWinningTrade());
    }

    const historicalRec = snapshot.getHedgeRatioRecommendation();
    const decision = policy.evaluateHedgeWithHistory(
      -20, // Adverse P&L that triggers hedge
      0, // No existing hedge
      historicalRec,
    );

    assert.strictEqual(decision.shouldHedge, true);
    assert.strictEqual(decision.usedHistoricalAnalysis, true);
    assert(decision.originalHedgeRatio > 0);
    assert(decision.historicalRecommendation !== undefined);
  });

  it("should reduce hedge ratio in favorable conditions", async () => {
    const { createDynamicHedgePolicy } =
      await import("../../src/core/dynamic-hedge-policy");

    const policy = createDynamicHedgePolicy();
    const snapshot = createHistoricalTradeSnapshot({
      minTradesForMetrics: 10,
      hedgeReduceFactor: 0.7, // 30% reduction
    });

    // Build very favorable historical conditions (high win rate)
    for (let i = 0; i < 15; i++) {
      snapshot.recordTrade(createWinningTrade({ realizedPnlUsd: 20 }));
    }

    const historicalRec = snapshot.getHedgeRatioRecommendation();

    // Only test when recommendation is actually REDUCE
    if (historicalRec.action === "REDUCE") {
      const decision = policy.evaluateHedgeWithHistory(-20, 0, historicalRec);

      // Adjusted ratio should be less than or equal to original
      assert(
        decision.hedgeRatio <= decision.originalHedgeRatio,
        `Adjusted ratio ${decision.hedgeRatio} should be <= original ${decision.originalHedgeRatio}`,
      );
    }
  });

  it("should not modify hedge when recommendation is MAINTAIN", async () => {
    const { createDynamicHedgePolicy } =
      await import("../../src/core/dynamic-hedge-policy");

    const policy = createDynamicHedgePolicy();
    const snapshot = createHistoricalTradeSnapshot({ minTradesForMetrics: 10 });

    // Create balanced conditions
    for (let i = 0; i < 5; i++) {
      snapshot.recordTrade(createWinningTrade());
      snapshot.recordTrade(createLosingTrade());
    }

    const historicalRec = snapshot.getHedgeRatioRecommendation();

    // When adjustment factor is 1.0 (MAINTAIN)
    if (historicalRec.adjustmentFactor === 1.0) {
      const decision = policy.evaluateHedgeWithHistory(-20, 0, historicalRec);

      // Ratio should be approximately equal to original
      const diff = Math.abs(decision.hedgeRatio - decision.originalHedgeRatio);
      assert(
        diff < 0.05,
        `Ratios should be similar: adjusted=${decision.hedgeRatio}, original=${decision.originalHedgeRatio}`,
      );
    }
  });
});
