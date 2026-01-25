import assert from "node:assert";
import { test, describe } from "node:test";
import {
  SellSignalMonitorService,
  type SellSignalMonitorConfig,
} from "../../src/services/sell-signal-monitor.service";
import type { TradeSignal } from "../../src/domain/trade.types";
import type { Position } from "../../src/strategies/position-tracker";

/**
 * Unit tests for Sell Signal Monitor Service
 *
 * Tests the logic for monitoring sell signals from tracked traders
 * and triggering protective actions when we hold losing positions.
 */

// Mock logger
const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// Helper to create a mock position
function createMockPosition(overrides: Partial<Position> = {}): Position {
  return {
    marketId: "market-1",
    tokenId: "token-abc123",
    side: "YES",
    size: 100,
    entryPrice: 0.5,
    currentPrice: 0.45, // 10% loss by default
    pnlPct: -10,
    pnlUsd: -5,
    pnlTrusted: true,
    pnlClassification: "LOSING",
    ...overrides,
  };
}

// Helper to create a mock sell signal
function createMockSellSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    trader: "0xTrackedTrader",
    marketId: "market-1",
    tokenId: "token-abc123",
    outcome: "YES",
    side: "SELL",
    sizeUsd: 100,
    price: 0.45,
    timestamp: Date.now(),
    ...overrides,
  };
}

// Mock position tracker
function createMockPositionTracker(position: Position | null) {
  return {
    getPositionByTokenId: (tokenId: string) => {
      if (position && position.tokenId === tokenId) {
        return position;
      }
      return null;
    },
    getPositions: () => (position ? [position] : []),
    getSnapshot: () => null,
  };
}

describe("SellSignalMonitorService", () => {
  describe("processSellSignal", () => {
    test("skips non-SELL signals", async () => {
      const position = createMockPosition();
      const monitor = new SellSignalMonitorService({
        logger: mockLogger,
        positionTracker: createMockPositionTracker(position) as any,
      });

      const buySignal = createMockSellSignal({ side: "BUY" });
      const result = await monitor.processSellSignal(buySignal);

      assert.equal(result.shouldAct, false);
      assert.equal(result.action, "NONE");
      assert.equal(result.reason, "NOT_A_SELL_SIGNAL");
    });

    test("skips when we don't hold the position", async () => {
      const monitor = new SellSignalMonitorService({
        logger: mockLogger,
        positionTracker: createMockPositionTracker(null) as any,
      });

      const signal = createMockSellSignal();
      const result = await monitor.processSellSignal(signal);

      assert.equal(result.shouldAct, false);
      assert.equal(result.action, "NONE");
      assert.equal(result.reason, "NO_MATCHING_POSITION");
    });

    test("skips when position is profitable (knee deep in positive)", async () => {
      const profitablePosition = createMockPosition({
        pnlPct: 25, // 25% profit
        pnlUsd: 12.5,
        pnlClassification: "PROFITABLE",
      });
      const monitor = new SellSignalMonitorService({
        logger: mockLogger,
        positionTracker: createMockPositionTracker(profitablePosition) as any,
      });

      const signal = createMockSellSignal();
      const result = await monitor.processSellSignal(signal);

      assert.equal(result.shouldAct, false);
      assert.equal(result.action, "NONE");
      assert.ok(result.reason.includes("PROFITABLE"));

      const stats = monitor.getStats();
      assert.equal(stats.signalsSkippedProfitable, 1);
    });

    test("skips when position has untrusted P&L", async () => {
      const untrustedPosition = createMockPosition({
        pnlTrusted: false,
        pnlUntrustedReason: "NO_COST_BASIS",
      });
      const monitor = new SellSignalMonitorService({
        logger: mockLogger,
        positionTracker: createMockPositionTracker(untrustedPosition) as any,
      });

      const signal = createMockSellSignal();
      const result = await monitor.processSellSignal(signal);

      assert.equal(result.shouldAct, false);
      assert.equal(result.action, "NONE");
      assert.equal(result.reason, "UNTRUSTED_PNL");

      const stats = monitor.getStats();
      assert.equal(stats.signalsSkippedUntrustedPnl, 1);
    });

    test("skips when position is too small", async () => {
      const tinyPosition = createMockPosition({
        size: 5,
        currentPrice: 0.5,
        pnlPct: -20,
      });
      const monitor = new SellSignalMonitorService({
        logger: mockLogger,
        positionTracker: createMockPositionTracker(tinyPosition) as any,
        config: { minPositionUsd: 10 },
      });

      const signal = createMockSellSignal();
      const result = await monitor.processSellSignal(signal);

      assert.equal(result.shouldAct, false);
      assert.equal(result.action, "NONE");
      assert.ok(result.reason.includes("POSITION_TOO_SMALL"));

      const stats = monitor.getStats();
      assert.equal(stats.signalsSkippedSmallPosition, 1);
    });

    test("skips when loss is below threshold", async () => {
      const smallLossPosition = createMockPosition({
        pnlPct: -5, // 5% loss - below 15% threshold
        pnlUsd: -2.5,
      });
      const monitor = new SellSignalMonitorService({
        logger: mockLogger,
        positionTracker: createMockPositionTracker(smallLossPosition) as any,
      });

      const signal = createMockSellSignal();
      const result = await monitor.processSellSignal(signal);

      assert.equal(result.shouldAct, false);
      assert.equal(result.action, "NONE");
      assert.ok(result.reason.includes("LOSS_BELOW_THRESHOLD"));
    });

    test("triggers hedge when loss exceeds threshold", async () => {
      const losingPosition = createMockPosition({
        pnlPct: -20, // 20% loss - above 15% threshold
        pnlUsd: -10,
      });
      let hedgeTriggered = false;
      const monitor = new SellSignalMonitorService({
        logger: mockLogger,
        positionTracker: createMockPositionTracker(losingPosition) as any,
        onTriggerHedge: async () => {
          hedgeTriggered = true;
        },
      });

      const signal = createMockSellSignal();
      const result = await monitor.processSellSignal(signal);

      assert.equal(result.shouldAct, true);
      assert.equal(result.action, "TRIGGER_HEDGE");
      assert.ok(result.reason.includes("LOSS"));
      assert.equal(hedgeTriggered, true);

      const stats = monitor.getStats();
      assert.equal(stats.signalsTriggeredHedge, 1);
    });

    test("triggers stop-loss when loss is severe", async () => {
      const severeLosingPosition = createMockPosition({
        pnlPct: -45, // 45% loss - above 40% stop-loss threshold
        pnlUsd: -22.5,
      });
      let stopLossTriggered = false;
      const monitor = new SellSignalMonitorService({
        logger: mockLogger,
        positionTracker: createMockPositionTracker(severeLosingPosition) as any,
        onTriggerStopLoss: async () => {
          stopLossTriggered = true;
        },
      });

      const signal = createMockSellSignal();
      const result = await monitor.processSellSignal(signal);

      assert.equal(result.shouldAct, true);
      assert.equal(result.action, "TRIGGER_STOP_LOSS");
      assert.ok(result.reason.includes("SEVERE_LOSS"));
      assert.equal(stopLossTriggered, true);

      const stats = monitor.getStats();
      assert.equal(stats.signalsTriggeredStopLoss, 1);
    });

    test("respects cooldown between actions", async () => {
      const losingPosition = createMockPosition({
        pnlPct: -20,
        pnlUsd: -10,
      });
      const monitor = new SellSignalMonitorService({
        logger: mockLogger,
        positionTracker: createMockPositionTracker(losingPosition) as any,
        config: { actionCooldownMs: 60000 }, // 1 minute cooldown
      });

      const signal = createMockSellSignal();

      // First call should trigger action
      const result1 = await monitor.processSellSignal(signal);
      assert.equal(result1.shouldAct, true);

      // Second call within cooldown should be skipped
      const result2 = await monitor.processSellSignal(signal);
      assert.equal(result2.shouldAct, false);
      assert.equal(result2.reason, "COOLDOWN_ACTIVE");

      const stats = monitor.getStats();
      assert.equal(stats.signalsSkippedCooldown, 1);
    });

    test("handles disabled monitoring", async () => {
      const position = createMockPosition();
      const monitor = new SellSignalMonitorService({
        logger: mockLogger,
        positionTracker: createMockPositionTracker(position) as any,
        config: { enabled: false },
      });

      const signal = createMockSellSignal();
      const result = await monitor.processSellSignal(signal);

      assert.equal(result.shouldAct, false);
      assert.equal(result.reason, "MONITORING_DISABLED");
    });
  });

  describe("configuration", () => {
    test("uses default config when none provided", () => {
      const monitor = new SellSignalMonitorService({
        logger: mockLogger,
        positionTracker: createMockPositionTracker(null) as any,
      });

      // Stats should reflect the service was created
      const stats = monitor.getStats();
      assert.equal(stats.signalsProcessed, 0);
    });

    test("merges custom config with defaults", async () => {
      const customConfig: Partial<SellSignalMonitorConfig> = {
        minLossPctToAct: 25, // Higher threshold than default 15
      };
      const losingPosition = createMockPosition({
        pnlPct: -20, // 20% loss - above default 15% but below custom 25%
        pnlUsd: -10,
      });
      const monitor = new SellSignalMonitorService({
        logger: mockLogger,
        positionTracker: createMockPositionTracker(losingPosition) as any,
        config: customConfig,
      });

      const signal = createMockSellSignal();
      const result = await monitor.processSellSignal(signal);

      // Should NOT trigger because 20% < custom 25% threshold
      assert.equal(result.shouldAct, false);
      assert.ok(result.reason.includes("LOSS_BELOW_THRESHOLD"));
    });
  });

  describe("statistics", () => {
    test("tracks all signal counts correctly", async () => {
      const losingPosition = createMockPosition({
        pnlPct: -20,
        pnlUsd: -10,
      });
      const monitor = new SellSignalMonitorService({
        logger: mockLogger,
        positionTracker: createMockPositionTracker(losingPosition) as any,
        config: { actionCooldownMs: 0 }, // No cooldown for testing
      });

      // Process a sell signal
      const signal = createMockSellSignal();
      await monitor.processSellSignal(signal);

      const stats = monitor.getStats();
      assert.equal(stats.signalsProcessed, 1);
      assert.equal(stats.signalsMatched, 1);
      assert.equal(stats.signalsTriggeredHedge, 1);
    });

    test("resetStats clears all counters", async () => {
      const losingPosition = createMockPosition({
        pnlPct: -20,
        pnlUsd: -10,
      });
      const monitor = new SellSignalMonitorService({
        logger: mockLogger,
        positionTracker: createMockPositionTracker(losingPosition) as any,
        config: { actionCooldownMs: 0 },
      });

      const signal = createMockSellSignal();
      await monitor.processSellSignal(signal);

      // Reset and verify
      monitor.resetStats();
      const stats = monitor.getStats();
      assert.equal(stats.signalsProcessed, 0);
      assert.equal(stats.signalsTriggeredHedge, 0);
    });
  });

  describe("edge cases", () => {
    test("handles neutral position (breakeven)", async () => {
      const neutralPosition = createMockPosition({
        pnlPct: 0,
        pnlUsd: 0,
        pnlClassification: "NEUTRAL",
      });
      const monitor = new SellSignalMonitorService({
        logger: mockLogger,
        positionTracker: createMockPositionTracker(neutralPosition) as any,
      });

      const signal = createMockSellSignal();
      const result = await monitor.processSellSignal(signal);

      assert.equal(result.shouldAct, false);
      assert.ok(result.reason.includes("NEUTRAL"));
    });

    test("handles position with small profit (within skip threshold)", async () => {
      const smallProfitPosition = createMockPosition({
        pnlPct: 3, // 3% profit - below maxProfitPctToSkip (5%)
        pnlUsd: 1.5,
        pnlClassification: "PROFITABLE",
      });
      const monitor = new SellSignalMonitorService({
        logger: mockLogger,
        positionTracker: createMockPositionTracker(smallProfitPosition) as any,
      });

      const signal = createMockSellSignal();
      const result = await monitor.processSellSignal(signal);

      // Should not act because position is profitable (even if small)
      // With default maxProfitPctToSkip=5, a 3% profit is within range to consider
      // but since it's positive, we still skip
      assert.equal(result.shouldAct, false);
      assert.ok(
        result.reason.includes("NEUTRAL") || result.reason.includes("SMALL_GAIN"),
      );
    });

    test("callback error does not crash the service", async () => {
      const losingPosition = createMockPosition({
        pnlPct: -20,
        pnlUsd: -10,
      });
      const monitor = new SellSignalMonitorService({
        logger: mockLogger,
        positionTracker: createMockPositionTracker(losingPosition) as any,
        onTriggerHedge: async () => {
          throw new Error("Callback failed!");
        },
      });

      const signal = createMockSellSignal();
      // Should not throw
      const result = await monitor.processSellSignal(signal);

      // Action should still be recorded as triggered
      assert.equal(result.shouldAct, true);
      assert.equal(result.action, "TRIGGER_HEDGE");
    });
  });
});
