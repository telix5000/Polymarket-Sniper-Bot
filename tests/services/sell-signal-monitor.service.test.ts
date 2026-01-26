import assert from "node:assert";
import { test, describe, mock } from "node:test";
import {
  SellSignalMonitorService,
  DEFAULT_SELL_SIGNAL_MONITOR_CONFIG,
  type SellSignalMonitorConfig,
} from "../../src/services/sell-signal-monitor.service";
import type { TradeSignal } from "../../src/domain/trade.types";
import type { Position } from "../../src/strategies/position-tracker";

/**
 * Unit tests for Sell Signal Monitor Service
 *
 * These tests verify:
 * 1. Only SELL signals are processed
 * 2. Only positions we hold are acted upon
 * 3. Profitable positions (>20% profit) are skipped
 * 4. Losing positions below threshold are skipped
 * 5. Moderate losses (15-40%) trigger HEDGE
 * 6. Severe losses (>40%) trigger STOP_LOSS
 * 7. Cooldowns prevent repeated actions
 * 8. Untrusted P&L positions are skipped
 */

// Mock logger
function createMockLogger() {
  return {
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
    debug: mock.fn(),
  };
}

// Mock position tracker
function createMockPositionTracker(positions: Map<string, Position>) {
  return {
    getPositionByTokenId: (tokenId: string) => positions.get(tokenId),
    getPositions: () => Array.from(positions.values()),
    getSnapshot: () => ({
      cycleId: 1,
      addressUsed: "0x123",
      fetchedAtMs: Date.now(),
      activePositions: Array.from(positions.values()),
      redeemablePositions: [],
      summary: {
        activeTotal: positions.size,
        win: 0,
        lose: 0,
        neutral: 0,
        unknown: 0,
        redeemableTotal: 0,
      },
    }),
  };
}

// Helper to create a test position
function createTestPosition(overrides: Partial<Position> = {}): Position {
  return {
    marketId: "market-123",
    tokenId: "token-abc",
    side: "YES",
    size: 100,
    entryPrice: 0.5,
    currentPrice: 0.4,
    pnlPct: -20,
    pnlUsd: -10,
    pnlTrusted: true,
    pnlClassification: "LOSING",
    ...overrides,
  };
}

// Helper to create a test signal
function createTestSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    trader: "0xtrader123",
    marketId: "market-123",
    tokenId: "token-abc",
    outcome: "YES",
    side: "SELL",
    sizeUsd: 100,
    price: 0.4,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("Sell Signal Monitor Service", () => {
  describe("Default Configuration", () => {
    test("should have correct default values", () => {
      assert.strictEqual(DEFAULT_SELL_SIGNAL_MONITOR_CONFIG.enabled, true);
      assert.strictEqual(
        DEFAULT_SELL_SIGNAL_MONITOR_CONFIG.minLossPctToAct,
        15,
      );
      assert.strictEqual(
        DEFAULT_SELL_SIGNAL_MONITOR_CONFIG.profitThresholdToSkip,
        20,
      );
      assert.strictEqual(DEFAULT_SELL_SIGNAL_MONITOR_CONFIG.severeLossPct, 40);
      assert.strictEqual(DEFAULT_SELL_SIGNAL_MONITOR_CONFIG.cooldownMs, 60_000);
    });
  });

  describe("Signal Filtering", () => {
    test("should ignore BUY signals", async () => {
      const logger = createMockLogger();
      const positions = new Map<string, Position>();
      const positionTracker = createMockPositionTracker(positions);

      const service = new SellSignalMonitorService({
        logger,
        positionTracker: positionTracker as any,
      });

      const signal = createTestSignal({ side: "BUY" });
      const result = await service.processSellSignal(signal);

      assert.strictEqual(result.processed, false);
      assert.strictEqual(result.action, "NONE");
      assert.ok(result.reason.includes("Not a SELL signal"));
    });

    test("should ignore signals for positions we don't hold", async () => {
      const logger = createMockLogger();
      const positions = new Map<string, Position>();
      const positionTracker = createMockPositionTracker(positions);

      const service = new SellSignalMonitorService({
        logger,
        positionTracker: positionTracker as any,
      });

      const signal = createTestSignal();
      const result = await service.processSellSignal(signal);

      assert.strictEqual(result.processed, true);
      assert.strictEqual(result.action, "NONE");
      assert.ok(result.reason.includes("No matching position"));
    });

    test("should ignore when service is disabled", async () => {
      const logger = createMockLogger();
      const positions = new Map<string, Position>();
      const positionTracker = createMockPositionTracker(positions);

      const service = new SellSignalMonitorService({
        logger,
        positionTracker: positionTracker as any,
        config: { enabled: false },
      });

      const signal = createTestSignal();
      const result = await service.processSellSignal(signal);

      assert.strictEqual(result.processed, false);
      assert.strictEqual(result.action, "NONE");
      assert.ok(result.reason.includes("Service disabled"));
    });
  });

  describe("Profit Threshold (Knee Deep in Positive)", () => {
    test("should skip positions with profit >= 20%", async () => {
      const logger = createMockLogger();
      const position = createTestPosition({
        pnlPct: 25, // 25% profit
        pnlClassification: "PROFITABLE",
      });
      const positions = new Map([[position.tokenId, position]]);
      const positionTracker = createMockPositionTracker(positions);

      const service = new SellSignalMonitorService({
        logger,
        positionTracker: positionTracker as any,
      });

      const signal = createTestSignal({ tokenId: position.tokenId });
      const result = await service.processSellSignal(signal);

      assert.strictEqual(result.processed, true);
      assert.strictEqual(result.action, "NONE");
      assert.ok(result.reason.includes("profitable"));
      assert.ok(result.reason.includes("25.0%"));
    });

    test("should skip positions with exactly 20% profit", async () => {
      const logger = createMockLogger();
      const position = createTestPosition({
        pnlPct: 20, // Exactly 20% profit
        pnlClassification: "PROFITABLE",
      });
      const positions = new Map([[position.tokenId, position]]);
      const positionTracker = createMockPositionTracker(positions);

      const service = new SellSignalMonitorService({
        logger,
        positionTracker: positionTracker as any,
      });

      const signal = createTestSignal({ tokenId: position.tokenId });
      const result = await service.processSellSignal(signal);

      assert.strictEqual(result.processed, true);
      assert.strictEqual(result.action, "NONE");
      assert.ok(result.reason.includes("profitable"));
    });

    test("should act on positions with profit < 20%", async () => {
      const logger = createMockLogger();
      const position = createTestPosition({
        pnlPct: -18, // 18% loss - above 15% threshold
        pnlClassification: "LOSING",
      });
      const positions = new Map([[position.tokenId, position]]);
      const positionTracker = createMockPositionTracker(positions);

      const onTriggerHedge = mock.fn(async () => true);
      const service = new SellSignalMonitorService({
        logger,
        positionTracker: positionTracker as any,
        onTriggerHedge,
      });

      const signal = createTestSignal({ tokenId: position.tokenId });
      const result = await service.processSellSignal(signal);

      assert.strictEqual(result.processed, true);
      assert.strictEqual(result.action, "HEDGE");
      assert.strictEqual(onTriggerHedge.mock.calls.length, 1);
    });
  });

  describe("Loss Thresholds", () => {
    test("should skip losses below 15%", async () => {
      const logger = createMockLogger();
      const position = createTestPosition({
        pnlPct: -10, // 10% loss - below 15% threshold
        pnlClassification: "LOSING",
      });
      const positions = new Map([[position.tokenId, position]]);
      const positionTracker = createMockPositionTracker(positions);

      const service = new SellSignalMonitorService({
        logger,
        positionTracker: positionTracker as any,
      });

      const signal = createTestSignal({ tokenId: position.tokenId });
      const result = await service.processSellSignal(signal);

      assert.strictEqual(result.processed, true);
      assert.strictEqual(result.action, "NONE");
      assert.ok(result.reason.includes("below threshold"));
    });

    test("should trigger HEDGE for moderate loss (15-40%)", async () => {
      const logger = createMockLogger();
      const position = createTestPosition({
        pnlPct: -25, // 25% loss - moderate
        pnlClassification: "LOSING",
      });
      const positions = new Map([[position.tokenId, position]]);
      const positionTracker = createMockPositionTracker(positions);

      const onTriggerHedge = mock.fn(async () => true);
      const service = new SellSignalMonitorService({
        logger,
        positionTracker: positionTracker as any,
        onTriggerHedge,
      });

      const signal = createTestSignal({ tokenId: position.tokenId });
      const result = await service.processSellSignal(signal);

      assert.strictEqual(result.processed, true);
      assert.strictEqual(result.action, "HEDGE");
      assert.strictEqual(onTriggerHedge.mock.calls.length, 1);
    });

    test("should trigger STOP_LOSS for severe loss (>=40%)", async () => {
      const logger = createMockLogger();
      const position = createTestPosition({
        pnlPct: -45, // 45% loss - severe
        pnlClassification: "LOSING",
      });
      const positions = new Map([[position.tokenId, position]]);
      const positionTracker = createMockPositionTracker(positions);

      const onTriggerStopLoss = mock.fn(async () => true);
      const service = new SellSignalMonitorService({
        logger,
        positionTracker: positionTracker as any,
        onTriggerStopLoss,
      });

      const signal = createTestSignal({ tokenId: position.tokenId });
      const result = await service.processSellSignal(signal);

      assert.strictEqual(result.processed, true);
      assert.strictEqual(result.action, "STOP_LOSS");
      assert.strictEqual(onTriggerStopLoss.mock.calls.length, 1);
    });

    test("should trigger STOP_LOSS at exactly 40%", async () => {
      const logger = createMockLogger();
      const position = createTestPosition({
        pnlPct: -40, // Exactly 40% loss
        pnlClassification: "LOSING",
      });
      const positions = new Map([[position.tokenId, position]]);
      const positionTracker = createMockPositionTracker(positions);

      const onTriggerStopLoss = mock.fn(async () => true);
      const service = new SellSignalMonitorService({
        logger,
        positionTracker: positionTracker as any,
        onTriggerStopLoss,
      });

      const signal = createTestSignal({ tokenId: position.tokenId });
      const result = await service.processSellSignal(signal);

      assert.strictEqual(result.processed, true);
      assert.strictEqual(result.action, "STOP_LOSS");
    });
  });

  describe("Cooldown Behavior", () => {
    test("should set cooldown after action", async () => {
      const logger = createMockLogger();
      const position = createTestPosition({
        pnlPct: -20,
        pnlClassification: "LOSING",
      });
      const positions = new Map([[position.tokenId, position]]);
      const positionTracker = createMockPositionTracker(positions);

      const onTriggerHedge = mock.fn(async () => true);
      const service = new SellSignalMonitorService({
        logger,
        positionTracker: positionTracker as any,
        onTriggerHedge,
      });

      const signal = createTestSignal({ tokenId: position.tokenId });

      // First call should succeed
      const result1 = await service.processSellSignal(signal);
      assert.strictEqual(result1.action, "HEDGE");
      assert.ok(service.isInCooldown(position.tokenId));

      // Second call should be skipped due to cooldown
      const result2 = await service.processSellSignal(signal);
      assert.strictEqual(result2.action, "SKIPPED");
      assert.ok(result2.reason.includes("Cooldown"));
    });

    test("should clear cooldown when requested", async () => {
      const logger = createMockLogger();
      const position = createTestPosition({
        pnlPct: -20,
        pnlClassification: "LOSING",
      });
      const positions = new Map([[position.tokenId, position]]);
      const positionTracker = createMockPositionTracker(positions);

      const onTriggerHedge = mock.fn(async () => true);
      const service = new SellSignalMonitorService({
        logger,
        positionTracker: positionTracker as any,
        onTriggerHedge,
      });

      const signal = createTestSignal({ tokenId: position.tokenId });

      // First call sets cooldown
      await service.processSellSignal(signal);
      assert.ok(service.isInCooldown(position.tokenId));

      // Clear cooldown
      service.clearCooldown(position.tokenId);
      assert.strictEqual(service.isInCooldown(position.tokenId), false);

      // Second call should work now
      const result = await service.processSellSignal(signal);
      assert.strictEqual(result.action, "HEDGE");
    });
  });

  describe("P&L Trust", () => {
    test("should skip positions with untrusted P&L", async () => {
      const logger = createMockLogger();
      const position = createTestPosition({
        pnlPct: -30,
        pnlTrusted: false,
        pnlUntrustedReason: "No orderbook data",
        pnlClassification: "UNKNOWN",
      });
      const positions = new Map([[position.tokenId, position]]);
      const positionTracker = createMockPositionTracker(positions);

      const service = new SellSignalMonitorService({
        logger,
        positionTracker: positionTracker as any,
      });

      const signal = createTestSignal({ tokenId: position.tokenId });
      const result = await service.processSellSignal(signal);

      assert.strictEqual(result.processed, true);
      assert.strictEqual(result.action, "SKIPPED");
      assert.ok(result.reason.includes("P&L not trusted"));
    });
  });

  describe("Statistics", () => {
    test("should track signals processed and actions triggered", async () => {
      const logger = createMockLogger();
      const position = createTestPosition({
        pnlPct: -20,
        pnlClassification: "LOSING",
      });
      const positions = new Map([[position.tokenId, position]]);
      const positionTracker = createMockPositionTracker(positions);

      const onTriggerHedge = mock.fn(async () => true);
      const service = new SellSignalMonitorService({
        logger,
        positionTracker: positionTracker as any,
        onTriggerHedge,
      });

      // Process multiple signals
      const signal = createTestSignal({ tokenId: position.tokenId });
      await service.processSellSignal(signal);
      service.clearCooldown(position.tokenId);
      await service.processSellSignal(signal);

      const stats = service.getStats();
      assert.strictEqual(stats.signalsProcessed, 2);
      assert.strictEqual(stats.actionsTriggered, 2);
    });
  });

  describe("Custom Configuration", () => {
    test("should respect custom thresholds", async () => {
      const logger = createMockLogger();
      const position = createTestPosition({
        pnlPct: -12, // Between default 15% and custom 10%
        pnlClassification: "LOSING",
      });
      const positions = new Map([[position.tokenId, position]]);
      const positionTracker = createMockPositionTracker(positions);

      const onTriggerHedge = mock.fn(async () => true);
      const service = new SellSignalMonitorService({
        logger,
        positionTracker: positionTracker as any,
        config: {
          minLossPctToAct: 10, // Lower threshold
        },
        onTriggerHedge,
      });

      const signal = createTestSignal({ tokenId: position.tokenId });
      const result = await service.processSellSignal(signal);

      assert.strictEqual(result.processed, true);
      assert.strictEqual(result.action, "HEDGE");
    });
  });
});
