import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  AdaptiveTradeLearner,
  getAdaptiveLearner,
  resetAdaptiveLearner,
} from "../../../src/arbitrage/learning/adaptive-learner";

describe("AdaptiveTradeLearner", () => {
  beforeEach(() => {
    resetAdaptiveLearner();
  });

  describe("recordTrade", () => {
    test("should record a trade and return an ID", () => {
      const learner = new AdaptiveTradeLearner();

      const tradeId = learner.recordTrade({
        marketId: "market-123",
        timestamp: Date.now(),
        entryPrice: 0.5,
        sizeUsd: 100,
        edgeBps: 50,
        spreadBps: 20,
        outcome: "pending",
      });

      assert.ok(tradeId.startsWith("trade_"));
    });

    test("should track pending trades", () => {
      const learner = new AdaptiveTradeLearner();

      learner.recordTrade({
        marketId: "market-123",
        timestamp: Date.now(),
        entryPrice: 0.5,
        sizeUsd: 100,
        edgeBps: 50,
        spreadBps: 20,
        outcome: "pending",
      });

      const stats = learner.getStats();
      assert.strictEqual(stats.global.totalTrades, 0); // Pending trades don't count
    });
  });

  describe("updateTradeOutcome", () => {
    test("should update trade outcome and calculate stats", () => {
      const learner = new AdaptiveTradeLearner();

      const tradeId = learner.recordTrade({
        marketId: "market-123",
        timestamp: Date.now(),
        entryPrice: 0.5,
        sizeUsd: 100,
        edgeBps: 50,
        spreadBps: 20,
        outcome: "pending",
      });

      learner.updateTradeOutcome(tradeId, "win", 0.52, 2.0, 5000);

      const stats = learner.getStats();
      assert.strictEqual(stats.global.totalTrades, 1);
      assert.strictEqual(stats.global.wins, 1);
      assert.strictEqual(stats.global.winRate, 1.0);
    });

    test("should track losses and update market stats", () => {
      const learner = new AdaptiveTradeLearner();

      const tradeId = learner.recordTrade({
        marketId: "market-123",
        timestamp: Date.now(),
        entryPrice: 0.5,
        sizeUsd: 100,
        edgeBps: 50,
        spreadBps: 20,
        outcome: "pending",
      });

      learner.updateTradeOutcome(tradeId, "loss", 0.48, -2.0, 5000);

      const stats = learner.getStats();
      assert.strictEqual(stats.global.losses, 1);
      assert.strictEqual(stats.global.winRate, 0);

      const marketStats = stats.markets.find(
        (m) => m.marketId === "market-123",
      );
      assert.ok(marketStats);
      assert.strictEqual(marketStats.consecutiveLosses, 1);
    });
  });

  describe("market avoidance", () => {
    test("should avoid market after consecutive losses", () => {
      const learner = new AdaptiveTradeLearner({
        maxConsecutiveLosses: 2,
        avoidDurationMs: 60000,
      });

      // Record two consecutive losses
      for (let i = 0; i < 2; i++) {
        const tradeId = learner.recordTrade({
          marketId: "bad-market",
          timestamp: Date.now(),
          entryPrice: 0.5,
          sizeUsd: 100,
          edgeBps: 50,
          spreadBps: 20,
          outcome: "pending",
        });
        learner.updateTradeOutcome(tradeId, "loss", 0.48, -2.0, 5000);
      }

      // Check if market is avoided
      const evaluation = learner.evaluateTrade({
        marketId: "bad-market",
        edgeBps: 100,
        spreadBps: 20,
        sizeUsd: 100,
      });

      assert.strictEqual(evaluation.shouldTrade, false);
      assert.ok(evaluation.reasons[0].includes("avoided"));
    });

    test("should reset consecutive losses on win", () => {
      const learner = new AdaptiveTradeLearner({
        maxConsecutiveLosses: 3,
      });

      // Record a loss
      const lossId = learner.recordTrade({
        marketId: "market-123",
        timestamp: Date.now(),
        entryPrice: 0.5,
        sizeUsd: 100,
        edgeBps: 50,
        spreadBps: 20,
        outcome: "pending",
      });
      learner.updateTradeOutcome(lossId, "loss", 0.48, -2.0, 5000);

      // Record a win
      const winId = learner.recordTrade({
        marketId: "market-123",
        timestamp: Date.now(),
        entryPrice: 0.5,
        sizeUsd: 100,
        edgeBps: 50,
        spreadBps: 20,
        outcome: "pending",
      });
      learner.updateTradeOutcome(winId, "win", 0.52, 2.0, 5000);

      const stats = learner.getStats();
      const marketStats = stats.markets.find(
        (m) => m.marketId === "market-123",
      );
      assert.strictEqual(marketStats?.consecutiveLosses, 0);
    });
  });

  describe("evaluateTrade", () => {
    test("should approve trade with good conditions", () => {
      const learner = new AdaptiveTradeLearner();

      const evaluation = learner.evaluateTrade({
        marketId: "new-market",
        edgeBps: 100,
        spreadBps: 50,
        sizeUsd: 100,
        liquidityUsd: 5000,
      });

      assert.strictEqual(evaluation.shouldTrade, true);
      assert.ok(evaluation.confidence >= 50);
    });

    test("should reduce confidence for low edge", () => {
      const learner = new AdaptiveTradeLearner();

      const evaluation = learner.evaluateTrade({
        marketId: "new-market",
        edgeBps: 10, // Very low edge
        spreadBps: 50,
        sizeUsd: 100,
      });

      assert.ok(evaluation.confidence < 70);
      assert.ok(evaluation.adjustments.sizeMultiplier < 1.0);
    });

    test("should reduce confidence for high spread", () => {
      const learner = new AdaptiveTradeLearner();

      const evaluation = learner.evaluateTrade({
        marketId: "new-market",
        edgeBps: 100,
        spreadBps: 500, // Very high spread
        sizeUsd: 100,
      });

      assert.ok(evaluation.confidence < 70);
      assert.ok(evaluation.reasons.some((r) => r.includes("Spread")));
    });

    test("should reduce confidence for low liquidity", () => {
      const learner = new AdaptiveTradeLearner();

      const evaluation = learner.evaluateTrade({
        marketId: "new-market",
        edgeBps: 100,
        spreadBps: 50,
        sizeUsd: 100,
        liquidityUsd: 500, // Low liquidity
      });

      assert.ok(evaluation.adjustments.tighterStopLoss);
      assert.ok(evaluation.reasons.some((r) => r.includes("liquidity")));
    });
  });

  describe("getSuggestedParameters", () => {
    test("should return default parameters with no trades", () => {
      const learner = new AdaptiveTradeLearner();

      const params = learner.getSuggestedParameters();

      assert.ok(params.minEdgeBps > 0);
      assert.ok(params.maxSpreadBps > 0);
      assert.ok(Array.isArray(params.optimalHours));
      assert.ok(Array.isArray(params.avoidHours));
    });

    test("should update parameters based on winning trades", () => {
      const learner = new AdaptiveTradeLearner();

      // Record 15 winning trades with varying edges
      for (let i = 0; i < 15; i++) {
        const tradeId = learner.recordTrade({
          marketId: `market-${i}`,
          timestamp: Date.now() + i * 1000,
          entryPrice: 0.5,
          sizeUsd: 100,
          edgeBps: 60 + i * 5, // 60-130 bps
          spreadBps: 30 + i * 3, // 30-72 bps
          outcome: "pending",
        });
        learner.updateTradeOutcome(tradeId, "win", 0.52, 2.0, 5000);
      }

      const params = learner.getSuggestedParameters();
      // Parameters should be based on actual winning trade data
      assert.ok(params.minEdgeBps >= 60);
      assert.ok(params.maxSpreadBps >= 30);
    });
  });

  describe("exportState / importState", () => {
    test("should export and import state correctly", () => {
      const learner1 = new AdaptiveTradeLearner();

      // Record some trades
      const tradeId = learner1.recordTrade({
        marketId: "market-123",
        timestamp: Date.now(),
        entryPrice: 0.5,
        sizeUsd: 100,
        edgeBps: 50,
        spreadBps: 20,
        outcome: "pending",
      });
      learner1.updateTradeOutcome(tradeId, "win", 0.52, 2.0, 5000);

      // Export state
      const state = learner1.exportState();

      // Create new learner and import
      const learner2 = new AdaptiveTradeLearner();
      learner2.importState(state);

      // Verify state was imported
      const stats = learner2.getStats();
      assert.strictEqual(stats.global.totalTrades, 1);
      assert.strictEqual(stats.global.wins, 1);
    });
  });

  describe("global singleton", () => {
    test("should return same instance", () => {
      const learner1 = getAdaptiveLearner();
      const learner2 = getAdaptiveLearner();
      assert.strictEqual(learner1, learner2);
    });

    test("should reset correctly", () => {
      const learner = getAdaptiveLearner();
      learner.recordTrade({
        marketId: "market-123",
        timestamp: Date.now(),
        entryPrice: 0.5,
        sizeUsd: 100,
        edgeBps: 50,
        spreadBps: 20,
        outcome: "pending",
      });

      resetAdaptiveLearner();

      const newLearner = getAdaptiveLearner();
      const stats = newLearner.getStats();
      assert.strictEqual(stats.global.totalTrades, 0);
    });
  });
});
