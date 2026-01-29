import assert from "node:assert";
import { test, describe, beforeEach } from "node:test";
import {
  ApiRateMonitor,
  type ApiProvider,
  type TradeType,
} from "../../src/infra/api-rate-monitor";

/**
 * Unit tests for ApiRateMonitor - API usage tracking and alerting
 *
 * These tests verify that:
 * 1. API calls are tracked correctly by provider
 * 2. Rate limit warnings/alerts are triggered appropriately
 * 3. Missed trades are tracked and patterns are detected
 * 4. Statistics are calculated correctly
 */

describe("ApiRateMonitor", () => {
  let monitor: ApiRateMonitor;

  beforeEach(() => {
    monitor = new ApiRateMonitor({
      // Use smaller thresholds for testing
      limits: {
        infura: {
          warningPerMinute: 10,
          criticalPerMinute: 20,
          warningPerHour: 100,
          criticalPerHour: 200,
          dailyLimit: 1000,
        },
        polymarket_clob: {
          warningPerMinute: 10,
          criticalPerMinute: 20,
          warningPerHour: 100,
          criticalPerHour: 200,
        },
        polymarket_data: {
          warningPerMinute: 10,
          criticalPerMinute: 20,
          warningPerHour: 100,
          criticalPerHour: 200,
        },
        polymarket_gamma: {
          warningPerMinute: 10,
          criticalPerMinute: 20,
          warningPerHour: 100,
          criticalPerHour: 200,
        },
        github: {
          warningPerMinute: 5,
          criticalPerMinute: 10,
          warningPerHour: 30,
          criticalPerHour: 50,
        },
        telegram: {
          warningPerMinute: 10,
          criticalPerMinute: 20,
          warningPerHour: 100,
          criticalPerHour: 200,
        },
        other: {
          warningPerMinute: 10,
          criticalPerMinute: 20,
          warningPerHour: 100,
          criticalPerHour: 200,
        },
      },
      missedTradeAlertThreshold: 3,
      alertCooldownMs: 1000, // Short cooldown for testing
    });
  });

  describe("API Call Tracking", () => {
    test("tracks API calls by provider", () => {
      monitor.recordCall({
        provider: "infura",
        endpoint: "/eth_call",
        success: true,
        latencyMs: 50,
      });

      monitor.recordCall({
        provider: "infura",
        endpoint: "/eth_getBalance",
        success: true,
        latencyMs: 30,
      });

      monitor.recordCall({
        provider: "polymarket_clob",
        endpoint: "/orders",
        success: true,
        latencyMs: 100,
      });

      const stats = monitor.getUsageStats();

      const infuraStats = stats.find((s) => s.provider === "infura");
      assert.ok(infuraStats, "Should have infura stats");
      assert.strictEqual(infuraStats.callsLastMinute, 2);
      assert.strictEqual(infuraStats.callsLastHour, 2);
      assert.strictEqual(infuraStats.callsToday, 2);

      const clobStats = stats.find((s) => s.provider === "polymarket_clob");
      assert.ok(clobStats, "Should have CLOB stats");
      assert.strictEqual(clobStats.callsLastMinute, 1);
    });

    test("calculates success rate correctly", () => {
      // 3 successful, 1 failed = 75% success rate
      for (let i = 0; i < 3; i++) {
        monitor.recordCall({
          provider: "infura",
          endpoint: "/eth_call",
          success: true,
        });
      }

      monitor.recordCall({
        provider: "infura",
        endpoint: "/eth_call",
        success: false,
        errorCode: "429",
      });

      const stats = monitor.getUsageStats();
      const infuraStats = stats.find((s) => s.provider === "infura");

      assert.ok(infuraStats, "Should have infura stats");
      assert.strictEqual(infuraStats.successRate, 75);
    });

    test("calculates average latency correctly", () => {
      monitor.recordCall({
        provider: "infura",
        endpoint: "/eth_call",
        success: true,
        latencyMs: 100,
      });

      monitor.recordCall({
        provider: "infura",
        endpoint: "/eth_call",
        success: true,
        latencyMs: 200,
      });

      const stats = monitor.getUsageStats();
      const infuraStats = stats.find((s) => s.provider === "infura");

      assert.ok(infuraStats, "Should have infura stats");
      assert.strictEqual(infuraStats.avgLatencyMs, 150);
    });
  });

  describe("Rate Limit Detection", () => {
    test("detects WARNING status when approaching limits", () => {
      // Add calls to trigger warning (10 = warning threshold)
      for (let i = 0; i < 12; i++) {
        monitor.recordCall({
          provider: "infura",
          endpoint: "/eth_call",
          success: true,
        });
      }

      const stats = monitor.getUsageStats();
      const infuraStats = stats.find((s) => s.provider === "infura");

      assert.ok(infuraStats, "Should have infura stats");
      assert.strictEqual(infuraStats.status, "WARNING");
      assert.ok(infuraStats.message?.includes("warning"));
    });

    test("detects CRITICAL status when exceeding limits", () => {
      // Add calls to trigger critical (20 = critical threshold)
      for (let i = 0; i < 25; i++) {
        monitor.recordCall({
          provider: "infura",
          endpoint: "/eth_call",
          success: true,
        });
      }

      const stats = monitor.getUsageStats();
      const infuraStats = stats.find((s) => s.provider === "infura");

      assert.ok(infuraStats, "Should have infura stats");
      assert.strictEqual(infuraStats.status, "CRITICAL");
      assert.ok(infuraStats.message?.includes("critical"));
    });

    test("returns OK status when within limits", () => {
      // Add a few calls, well under limits
      for (let i = 0; i < 5; i++) {
        monitor.recordCall({
          provider: "infura",
          endpoint: "/eth_call",
          success: true,
        });
      }

      const stats = monitor.getUsageStats();
      const infuraStats = stats.find((s) => s.provider === "infura");

      assert.ok(infuraStats, "Should have infura stats");
      assert.strictEqual(infuraStats.status, "OK");
    });
  });

  describe("Missed Trade Tracking", () => {
    test("tracks missed trades by type", () => {
      monitor.recordMissedTrade({
        type: "BUY",
        tokenId: "token-1",
        reason: "NO_LIQUIDITY",
        sizeUsd: 25,
      });

      monitor.recordMissedTrade({
        type: "BUY",
        tokenId: "token-2",
        reason: "SLIPPAGE",
        sizeUsd: 30,
      });

      monitor.recordMissedTrade({
        type: "SELL",
        tokenId: "token-1",
        reason: "FOK_NOT_FILLED",
        sizeUsd: 25,
      });

      const stats = monitor.getMissedTradeStats();

      const buyStats = stats.find((s) => s.type === "BUY");
      assert.ok(buyStats, "Should have BUY stats");
      assert.strictEqual(buyStats.countLastHour, 2);
      assert.strictEqual(buyStats.consecutiveCount, 2);

      const sellStats = stats.find((s) => s.type === "SELL");
      assert.ok(sellStats, "Should have SELL stats");
      assert.strictEqual(sellStats.countLastHour, 1);
      assert.strictEqual(sellStats.consecutiveCount, 1);
    });

    test("resets consecutive count on successful trade", () => {
      // Record some missed buys
      monitor.recordMissedTrade({
        type: "BUY",
        tokenId: "token-1",
        reason: "NO_LIQUIDITY",
      });

      monitor.recordMissedTrade({
        type: "BUY",
        tokenId: "token-2",
        reason: "SLIPPAGE",
      });

      // Record successful buy
      monitor.recordSuccessfulTrade("BUY");

      const stats = monitor.getMissedTradeStats();
      const buyStats = stats.find((s) => s.type === "BUY");

      assert.ok(buyStats, "Should have BUY stats");
      assert.strictEqual(buyStats.consecutiveCount, 0);
      // Count in last hour should still show the misses
      assert.strictEqual(buyStats.countLastHour, 2);
    });

    test("detects CRITICAL status when threshold exceeded", () => {
      // Record 3 consecutive missed trades (threshold is 3)
      for (let i = 0; i < 4; i++) {
        monitor.recordMissedTrade({
          type: "HEDGE",
          tokenId: `token-${i}`,
          reason: "ORDER_REJECTED",
        });
      }

      const stats = monitor.getMissedTradeStats();
      const hedgeStats = stats.find((s) => s.type === "HEDGE");

      assert.ok(hedgeStats, "Should have HEDGE stats");
      assert.strictEqual(hedgeStats.status, "CRITICAL");
      assert.strictEqual(hedgeStats.consecutiveCount, 4);
    });
  });

  describe("Summary", () => {
    test("returns overall status summary", () => {
      // Normal operation - should be OK
      monitor.recordCall({
        provider: "infura",
        endpoint: "/eth_call",
        success: true,
      });

      const summary = monitor.getSummary();

      assert.strictEqual(summary.apiStatus, "OK");
      assert.strictEqual(summary.tradeStatus, "OK");
      assert.strictEqual(summary.issues.length, 0);
      assert.strictEqual(summary.totalCallsLastHour, 1);
      assert.strictEqual(summary.totalMissedTradesLastHour, 0);
    });

    test("aggregates issues from multiple sources", () => {
      // Trigger API warning
      for (let i = 0; i < 15; i++) {
        monitor.recordCall({
          provider: "infura",
          endpoint: "/eth_call",
          success: true,
        });
      }

      // Trigger trade warning
      for (let i = 0; i < 2; i++) {
        monitor.recordMissedTrade({
          type: "BUY",
          tokenId: `token-${i}`,
          reason: "NO_LIQUIDITY",
        });
      }

      const summary = monitor.getSummary();

      assert.strictEqual(summary.apiStatus, "WARNING");
      // 2 consecutive is half of threshold (3), so should be WARNING
      assert.strictEqual(summary.tradeStatus, "WARNING");
      assert.ok(summary.issues.length >= 2, "Should have multiple issues");
    });
  });

  describe("Reset", () => {
    test("clears all state on reset", () => {
      // Add some data
      monitor.recordCall({
        provider: "infura",
        endpoint: "/eth_call",
        success: true,
      });

      monitor.recordMissedTrade({
        type: "BUY",
        tokenId: "token-1",
        reason: "TEST",
      });

      // Reset
      monitor.reset();

      // Verify cleared
      const summary = monitor.getSummary();
      assert.strictEqual(summary.totalCallsLastHour, 0);
      assert.strictEqual(summary.totalMissedTradesLastHour, 0);

      const stats = monitor.getMissedTradeStats();
      const buyStats = stats.find((s) => s.type === "BUY");
      assert.ok(buyStats, "Should have BUY stats");
      assert.strictEqual(buyStats.consecutiveCount, 0);
    });
  });
});
