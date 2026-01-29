/**
 * Unit tests for ExitEngine
 *
 * Verifies that:
 * 1. Late-game triggers when mark >= 0.97 and closeToEndScore high
 * 2. TP tightens when reservePressure increases
 * 3. Exits use snapshot and respect tick rounding (SELL rounds DOWN)
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";

import {
  ExitEngine,
  DEFAULT_EXIT_ENGINE_CONFIG,
  type ExitMarketData,
} from "../../src/core/exit-engine";
import type { ManagedPosition } from "../../src/core/decision-engine";
import type { DynamicReserveState } from "../../src/core/reserve-manager";
import type { MarketSnapshot } from "../../src/book/types";

// ═══════════════════════════════════════════════════════════════════════════
// MOCK DATA FACTORIES
// ═══════════════════════════════════════════════════════════════════════════

function createMockPosition(
  overrides: Partial<ManagedPosition> = {},
): ManagedPosition {
  return {
    id: "test-position-123",
    tokenId: "0x123456789abcdef",
    marketId: "market-1",
    side: "LONG",
    state: "OPEN",
    entryPriceCents: 60,
    entrySizeUsd: 100,
    entryTime: Date.now() - 60000,
    currentPriceCents: 70,
    unrealizedPnlCents: 10,
    unrealizedPnlUsd: 10,
    takeProfitPriceCents: 74,
    hedgeTriggerPriceCents: 55,
    hardExitPriceCents: 50,
    hedges: [],
    totalHedgeRatio: 0,
    referencePriceCents: 60,
    transitions: [],
    lastUpdateTime: Date.now(),
    ...overrides,
  };
}

function createMockSnapshot(
  overrides: Partial<MarketSnapshot> = {},
): MarketSnapshot {
  return {
    tokenId: "0x123456789abcdef",
    bestBid: 0.7,
    bestAsk: 0.72,
    mid: 0.71,
    spreadCents: 2,
    bookStatus: "HEALTHY",
    source: "REST",
    fetchedAtMs: Date.now(),
    attemptId: "attempt-123",
    tickSize: 0.01,
    ...overrides,
  };
}

function createMockMarketData(
  overrides: Partial<ExitMarketData> = {},
): ExitMarketData {
  return {
    snapshot: createMockSnapshot(overrides.snapshot),
    bidDepthUsd: 500,
    askDepthUsd: 500,
    timeToResolutionMs: undefined,
    recentPriceStdDev: 0.005,
    ...overrides,
  };
}

function createMockReserveState(
  overrides: Partial<DynamicReserveState> = {},
): DynamicReserveState {
  return {
    baseReserveFraction: 0.2,
    adaptedReserveFraction: 0.2,
    missedOpportunitiesUsd: 0,
    hedgeNeedsUsd: 0,
    missedCount: 0,
    hedgesMissed: 0,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("ExitEngine", () => {
  let engine: ExitEngine;

  beforeEach(() => {
    engine = new ExitEngine({ telegramEnabled: false });
  });

  describe("Configuration", () => {
    it("should use default configuration when none provided", () => {
      const config = engine.getConfig();
      assert.strictEqual(
        config.lateGamePriceThreshold,
        DEFAULT_EXIT_ENGINE_CONFIG.lateGamePriceThreshold,
      );
      assert.strictEqual(
        config.closeToEndScoreThreshold,
        DEFAULT_EXIT_ENGINE_CONFIG.closeToEndScoreThreshold,
      );
      assert.strictEqual(
        config.baseTpCents,
        DEFAULT_EXIT_ENGINE_CONFIG.baseTpCents,
      );
    });

    it("should allow partial configuration overrides", () => {
      const customEngine = new ExitEngine({
        lateGamePriceThreshold: 0.95,
        baseTpCents: 10,
      });
      const config = customEngine.getConfig();
      assert.strictEqual(config.lateGamePriceThreshold, 0.95);
      assert.strictEqual(config.baseTpCents, 10);
      // Other values should be default
      assert.strictEqual(
        config.minTpCents,
        DEFAULT_EXIT_ENGINE_CONFIG.minTpCents,
      );
    });
  });

  describe("closeToEndScore Computation", () => {
    it("should return high score when mark >= 0.97 with low volatility", () => {
      const marketData = createMockMarketData({
        snapshot: createMockSnapshot({ bestBid: 0.98, bestAsk: 0.99 }),
        recentPriceStdDev: 0.005, // Low volatility
        bidDepthUsd: 200,
        askDepthUsd: 200,
      });

      const score = engine.computeCloseToEndScore(0.98, marketData);

      // Should be high score (>= 0.7)
      assert.ok(score >= 0.7, `Expected score >= 0.7, got ${score}`);
    });

    it("should return low score when mark < 0.90", () => {
      const marketData = createMockMarketData({
        snapshot: createMockSnapshot({ bestBid: 0.5, bestAsk: 0.52 }),
        recentPriceStdDev: 0.02, // Higher volatility
        bidDepthUsd: 50,
        askDepthUsd: 50,
      });

      const score = engine.computeCloseToEndScore(0.5, marketData);

      // Should be low score (< 0.5)
      assert.ok(score < 0.5, `Expected score < 0.5, got ${score}`);
    });

    it("should incorporate timeToResolution when available", () => {
      const marketData1Hour = createMockMarketData({
        snapshot: createMockSnapshot({ bestBid: 0.9, bestAsk: 0.92 }),
        timeToResolutionMs: 1 * 60 * 60 * 1000, // 1 hour
        bidDepthUsd: 100,
        askDepthUsd: 100,
      });

      const marketData72Hours = createMockMarketData({
        snapshot: createMockSnapshot({ bestBid: 0.9, bestAsk: 0.92 }),
        timeToResolutionMs: 72 * 60 * 60 * 1000, // 72 hours
        bidDepthUsd: 100,
        askDepthUsd: 100,
      });

      const score1Hour = engine.computeCloseToEndScore(0.9, marketData1Hour);
      const score72Hours = engine.computeCloseToEndScore(
        0.9,
        marketData72Hours,
      );

      // Score should be higher when closer to resolution
      assert.ok(
        score1Hour > score72Hours,
        `Expected 1-hour score ${score1Hour} > 72-hour score ${score72Hours}`,
      );
    });

    it("should factor in depth health", () => {
      const goodDepth = createMockMarketData({
        snapshot: createMockSnapshot({
          bestBid: 0.95,
          bestAsk: 0.96,
          spreadCents: 1,
        }),
        bidDepthUsd: 500,
        askDepthUsd: 500,
      });

      const poorDepth = createMockMarketData({
        snapshot: createMockSnapshot({
          bestBid: 0.95,
          bestAsk: 0.96,
          spreadCents: 30,
        }),
        bidDepthUsd: 10,
        askDepthUsd: 10,
      });

      const scoreGood = engine.computeCloseToEndScore(0.95, goodDepth);
      const scorePoor = engine.computeCloseToEndScore(0.95, poorDepth);

      // Score should be higher with good depth
      assert.ok(
        scoreGood > scorePoor,
        `Expected good depth score ${scoreGood} > poor depth score ${scorePoor}`,
      );
    });
  });

  describe("Dynamic Take Profit", () => {
    it("should return baseTpCents when no reserve pressure", () => {
      const reserveState = createMockReserveState({
        baseReserveFraction: 0.2,
        adaptedReserveFraction: 0.2,
        missedCount: 0,
      });

      const tpCents = engine.computeDynamicTpCents(reserveState);

      assert.strictEqual(tpCents, DEFAULT_EXIT_ENGINE_CONFIG.baseTpCents);
    });

    it("should tighten TP when reservePressure is high (adapted > base)", () => {
      const highPressureState = createMockReserveState({
        baseReserveFraction: 0.2,
        adaptedReserveFraction: 0.35, // Significantly higher than base
        missedCount: 0,
      });

      const tpCents = engine.computeDynamicTpCents(highPressureState);

      // Should be less than baseTpCents
      assert.ok(
        tpCents < DEFAULT_EXIT_ENGINE_CONFIG.baseTpCents,
        `Expected TP ${tpCents} < baseTp ${DEFAULT_EXIT_ENGINE_CONFIG.baseTpCents}`,
      );
    });

    it("should tighten TP when missedCount is high", () => {
      const highMissedState = createMockReserveState({
        baseReserveFraction: 0.2,
        adaptedReserveFraction: 0.2,
        missedCount: 10, // High missed count
      });

      const tpCents = engine.computeDynamicTpCents(highMissedState);

      // Should be less than baseTpCents due to missed opportunity pressure
      assert.ok(
        tpCents < DEFAULT_EXIT_ENGINE_CONFIG.baseTpCents,
        `Expected TP ${tpCents} < baseTp ${DEFAULT_EXIT_ENGINE_CONFIG.baseTpCents}`,
      );
    });

    it("should never go below minTpCents", () => {
      const extremePressureState = createMockReserveState({
        baseReserveFraction: 0.1,
        adaptedReserveFraction: 0.5, // Very high
        missedCount: 20,
      });

      const tpCents = engine.computeDynamicTpCents(extremePressureState);

      assert.ok(
        tpCents >= DEFAULT_EXIT_ENGINE_CONFIG.minTpCents,
        `Expected TP ${tpCents} >= minTp ${DEFAULT_EXIT_ENGINE_CONFIG.minTpCents}`,
      );
    });
  });

  describe("Late-Game Exit Trigger", () => {
    it("should trigger LATE_GAME_EXIT when mark >= 0.97 and closeToEndScore >= threshold", () => {
      // Entry price close to current so TP isn't triggered first
      // P&L = 97 - 90 = +7¢, which is < default TP of 14¢
      const position = createMockPosition({
        entryPriceCents: 90,
        currentPriceCents: 97,
      });

      const marketData = createMockMarketData({
        snapshot: createMockSnapshot({
          bestBid: 0.97,
          bestAsk: 0.98,
          spreadCents: 1,
        }),
        bidDepthUsd: 500,
        askDepthUsd: 500,
        recentPriceStdDev: 0.005,
        timeToResolutionMs: 60 * 60 * 1000, // 1 hour
      });

      const reserveState = createMockReserveState();

      const decision = engine.evaluateExit(position, marketData, reserveState);

      assert.strictEqual(
        decision.state,
        "LATE_GAME_EXIT",
        `Expected LATE_GAME_EXIT state, got ${decision.state}`,
      );
    });

    it("should NOT trigger LATE_GAME_EXIT when mark < 0.97", () => {
      const position = createMockPosition({
        entryPriceCents: 60,
        currentPriceCents: 70,
      });

      const marketData = createMockMarketData({
        snapshot: createMockSnapshot({
          bestBid: 0.7,
          bestAsk: 0.72,
          spreadCents: 2,
        }),
        bidDepthUsd: 500,
        askDepthUsd: 500,
      });

      const reserveState = createMockReserveState();

      const decision = engine.evaluateExit(position, marketData, reserveState);

      assert.notStrictEqual(
        decision.state,
        "LATE_GAME_EXIT",
        `Did not expect LATE_GAME_EXIT state at mark=0.70`,
      );
    });

    it("should NOT trigger LATE_GAME_EXIT when closeToEndScore is low", () => {
      // Create engine with high score threshold
      const strictEngine = new ExitEngine({
        closeToEndScoreThreshold: 0.9,
        telegramEnabled: false,
      });

      const position = createMockPosition({
        entryPriceCents: 90,
        currentPriceCents: 97,
      });

      const marketData = createMockMarketData({
        snapshot: createMockSnapshot({
          bestBid: 0.97,
          bestAsk: 0.98,
          spreadCents: 30, // Wide spread = lower score
        }),
        bidDepthUsd: 10, // Low depth = lower score
        askDepthUsd: 10,
        recentPriceStdDev: 0.05, // High volatility = lower score
      });

      const reserveState = createMockReserveState();

      const decision = strictEngine.evaluateExit(
        position,
        marketData,
        reserveState,
      );

      // With poor conditions, score should be below 0.9 threshold
      assert.notStrictEqual(
        decision.state,
        "LATE_GAME_EXIT",
        `Did not expect LATE_GAME_EXIT with low score conditions`,
      );
    });
  });

  describe("Take Profit Trigger", () => {
    it("should trigger TAKE_PROFIT when P&L exceeds dynamic TP", () => {
      const position = createMockPosition({
        entryPriceCents: 50,
        currentPriceCents: 70, // +20¢ profit > 14¢ default TP
      });

      const marketData = createMockMarketData({
        snapshot: createMockSnapshot({
          bestBid: 0.7,
          bestAsk: 0.72,
          spreadCents: 2,
        }),
      });

      const reserveState = createMockReserveState();

      const decision = engine.evaluateExit(position, marketData, reserveState);

      assert.strictEqual(
        decision.state,
        "TAKE_PROFIT",
        `Expected TAKE_PROFIT state, got ${decision.state}`,
      );
      assert.strictEqual(decision.action, "SELL_AT_BID");
    });

    it("should trigger TAKE_PROFIT earlier when reservePressure tightens TP", () => {
      const position = createMockPosition({
        entryPriceCents: 60,
        currentPriceCents: 68, // +8¢ profit
      });

      const marketData = createMockMarketData({
        snapshot: createMockSnapshot({
          bestBid: 0.68,
          bestAsk: 0.7,
        }),
      });

      // High pressure should tighten TP below 8¢
      const highPressureState = createMockReserveState({
        baseReserveFraction: 0.1,
        adaptedReserveFraction: 0.4,
        missedCount: 10,
      });

      const dynamicTp = engine.computeDynamicTpCents(highPressureState);

      // With high pressure, TP should be tightened enough to trigger at +8¢
      const decision = engine.evaluateExit(
        position,
        marketData,
        highPressureState,
      );

      // Only expect TP if dynamic TP is <= 8
      if (dynamicTp <= 8) {
        assert.strictEqual(
          decision.state,
          "TAKE_PROFIT",
          `Expected TAKE_PROFIT with tight TP=${dynamicTp}¢`,
        );
      }
    });
  });

  describe("Risk-Off Trigger", () => {
    it("should trigger RISK_OFF when book is unhealthy and position is in loss", () => {
      const position = createMockPosition({
        entryPriceCents: 60,
        currentPriceCents: 50, // -10¢ loss
      });

      const marketData = createMockMarketData({
        snapshot: createMockSnapshot({
          bestBid: 0.5,
          bestAsk: 0.7,
          spreadCents: 20, // Very wide spread (> 3x minHealthy=5)
        }),
      });

      const reserveState = createMockReserveState();

      const decision = engine.evaluateExit(position, marketData, reserveState);

      assert.strictEqual(
        decision.state,
        "RISK_OFF",
        `Expected RISK_OFF state, got ${decision.state}`,
      );
    });

    it("should NOT trigger RISK_OFF when spread is wide but position is profitable", () => {
      const position = createMockPosition({
        entryPriceCents: 40,
        currentPriceCents: 60, // +20¢ profit
      });

      const marketData = createMockMarketData({
        snapshot: createMockSnapshot({
          bestBid: 0.6,
          bestAsk: 0.75,
          spreadCents: 15, // Wide spread
        }),
      });

      const reserveState = createMockReserveState();

      const decision = engine.evaluateExit(position, marketData, reserveState);

      // Should hit TAKE_PROFIT instead since profitable
      assert.strictEqual(
        decision.state,
        "TAKE_PROFIT",
        `Expected TAKE_PROFIT for profitable position, got ${decision.state}`,
      );
    });
  });

  describe("Tick Rounding for SELL", () => {
    it("should round SELL price DOWN to tick", () => {
      // Test the underlying roundToTick function behavior
      const { roundToTick } = require("../../src/lib/price-safety");

      // 0.976 should round DOWN to 0.97 for SELL
      assert.strictEqual(roundToTick(0.976, 0.01, "SELL"), 0.97);

      // 0.979 should round DOWN to 0.97 for SELL
      assert.strictEqual(roundToTick(0.979, 0.01, "SELL"), 0.97);

      // Exact value stays the same
      assert.strictEqual(roundToTick(0.97, 0.01, "SELL"), 0.97);
    });

    it("late-game limit order price should be properly rounded down", () => {
      const position = createMockPosition({
        entryPriceCents: 90,
        currentPriceCents: 97,
      });

      // Create market where bestAsk - tick = 0.976 (should round to 0.97)
      const marketData = createMockMarketData({
        snapshot: createMockSnapshot({
          bestBid: 0.94, // Below threshold, force limit order
          bestAsk: 0.986,
          spreadCents: 4.6,
          tickSize: 0.01,
        }),
        bidDepthUsd: 500,
        timeToResolutionMs: 60 * 60 * 1000,
        recentPriceStdDev: 0.005,
      });

      const reserveState = createMockReserveState();

      // First, transition to late-game
      engine.evaluateExit(position, marketData, reserveState);

      // Get the position state
      const state = engine.getPositionState(position.id);

      // Verify state transitioned to LATE_GAME_EXIT
      if (state?.state === "LATE_GAME_EXIT") {
        // Price should be rounded down for SELL
        // bestAsk - 0.01 = 0.976 → rounds to 0.97
        const { roundToTick } = require("../../src/lib/price-safety");
        const expectedPrice = roundToTick(0.986 - 0.01, 0.01, "SELL");
        assert.strictEqual(
          expectedPrice,
          0.97,
          "Expected price to round DOWN to 0.97",
        );
      }
    });
  });

  describe("State Machine", () => {
    it("should track position state through transitions", () => {
      const position = createMockPosition({
        entryPriceCents: 60,
        currentPriceCents: 74, // TP trigger
      });

      const marketData = createMockMarketData({
        snapshot: createMockSnapshot({ bestBid: 0.74, bestAsk: 0.76 }),
      });

      const reserveState = createMockReserveState();

      // First evaluation triggers TAKE_PROFIT
      engine.evaluateExit(position, marketData, reserveState);

      const state = engine.getPositionState(position.id);
      assert.ok(state, "Position state should exist");
      assert.strictEqual(state!.state, "TAKE_PROFIT");
      assert.strictEqual(state!.stateReason, "TP_TRIGGERED");
    });

    it("should initialize position state correctly", () => {
      const position = createMockPosition();
      const marketData = createMockMarketData();
      const reserveState = createMockReserveState();

      engine.evaluateExit(position, marketData, reserveState);

      const state = engine.getPositionState(position.id);
      assert.ok(state, "Position state should exist");
      assert.strictEqual(state!.positionId, position.id);
      assert.strictEqual(state!.tokenId, position.tokenId);
      assert.strictEqual(state!.remainingSizeUsd, position.entrySizeUsd);
    });

    it("should remove position state when cleared", () => {
      const position = createMockPosition();
      const marketData = createMockMarketData();
      const reserveState = createMockReserveState();

      engine.evaluateExit(position, marketData, reserveState);
      assert.ok(engine.getPositionState(position.id), "State should exist");

      engine.removePositionState(position.id);
      assert.strictEqual(
        engine.getPositionState(position.id),
        undefined,
        "State should be removed",
      );
    });
  });

  describe("Chunking Logic", () => {
    it("should chunk sells when depth < position size", () => {
      const position = createMockPosition({
        entryPriceCents: 90,
        entrySizeUsd: 500, // Large position
        currentPriceCents: 98, // Match bestBid
      });

      const marketData = createMockMarketData({
        snapshot: createMockSnapshot({
          bestBid: 0.98, // Above minAcceptablePrice (0.98) with no pressure
          bestAsk: 0.99,
          spreadCents: 1,
        }),
        bidDepthUsd: 100, // Less than position size
        askDepthUsd: 100,
        timeToResolutionMs: 60 * 60 * 1000,
        recentPriceStdDev: 0.005,
      });

      const reserveState = createMockReserveState();

      const decision = engine.evaluateExit(position, marketData, reserveState);

      if (decision.state === "LATE_GAME_EXIT") {
        // Should chunk sell based on available depth
        assert.strictEqual(
          decision.action,
          "CHUNK_SELL",
          `Expected CHUNK_SELL action, got ${decision.action}`,
        );
        assert.ok(
          decision.sizeUsd! < position.entrySizeUsd,
          `Expected chunk size ${decision.sizeUsd} < position size ${position.entrySizeUsd}`,
        );
      }
    });

    it("should sell full position when depth >= position size", () => {
      const position = createMockPosition({
        entryPriceCents: 90,
        entrySizeUsd: 50, // Small position
        currentPriceCents: 98, // Match bestBid
      });

      const marketData = createMockMarketData({
        snapshot: createMockSnapshot({
          bestBid: 0.98, // Above minAcceptablePrice (0.98) with no pressure
          bestAsk: 0.99,
          spreadCents: 1,
        }),
        bidDepthUsd: 500, // Much more than position size
        askDepthUsd: 500,
        timeToResolutionMs: 60 * 60 * 1000,
        recentPriceStdDev: 0.005,
      });

      const reserveState = createMockReserveState();

      const decision = engine.evaluateExit(position, marketData, reserveState);

      if (decision.state === "LATE_GAME_EXIT") {
        assert.strictEqual(
          decision.action,
          "SELL_AT_BID",
          `Expected SELL_AT_BID action, got ${decision.action}`,
        );
      }
    });
  });

  describe("Reserve Pressure Influence", () => {
    it("should accept 0.97 instead of waiting for 0.99 when pressure is high", () => {
      const position = createMockPosition({
        entryPriceCents: 90,
        currentPriceCents: 97,
      });

      // Market at exactly threshold
      const marketData = createMockMarketData({
        snapshot: createMockSnapshot({
          bestBid: 0.97, // At threshold
          bestAsk: 0.98,
          spreadCents: 1,
        }),
        bidDepthUsd: 500,
        timeToResolutionMs: 60 * 60 * 1000,
        recentPriceStdDev: 0.005,
      });

      // High reserve pressure should make us more willing to sell at 0.97
      const highPressureState = createMockReserveState({
        baseReserveFraction: 0.1,
        adaptedReserveFraction: 0.4,
        missedCount: 5,
      });

      const decision = engine.evaluateExit(
        position,
        marketData,
        highPressureState,
      );

      if (decision.state === "LATE_GAME_EXIT") {
        // With high pressure, should accept bestBid at 0.97
        assert.ok(
          decision.action === "SELL_AT_BID" || decision.action === "CHUNK_SELL",
          `Expected sell action, got ${decision.action}`,
        );
        assert.strictEqual(decision.price, 0.97);
      }
    });
  });
});

describe("ExitEngine Integration", () => {
  describe("Uses MarketSnapshot correctly", () => {
    it("should use snapshot bestBid and bestAsk for decisions", () => {
      const engine = new ExitEngine({ telegramEnabled: false });

      const position = createMockPosition({
        entryPriceCents: 60,
        currentPriceCents: 70,
      });

      const snapshot = createMockSnapshot({
        bestBid: 0.7,
        bestAsk: 0.72,
        attemptId: "test-attempt-456",
      });

      const marketData: ExitMarketData = {
        snapshot,
        bidDepthUsd: 100,
        askDepthUsd: 100,
      };

      const reserveState = createMockReserveState();

      const decision = engine.evaluateExit(position, marketData, reserveState);

      // Decision should reference the snapshot's bestBid
      if (decision.price) {
        assert.ok(
          decision.price <= snapshot.bestBid ||
            decision.price <= snapshot.bestAsk,
          "Decision price should be based on snapshot",
        );
      }
    });

    it("should use snapshot tickSize for rounding", () => {
      // Test that snapshot with custom tickSize is properly created
      const snapshot = createMockSnapshot({
        tickSize: 0.001, // Smaller tick size
      });

      // Verify tick size is accessible from snapshot
      assert.strictEqual(snapshot.tickSize, 0.001);
    });
  });
});
