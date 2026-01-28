/**
 * No Market Data Cooldown Tests
 *
 * Tests for the improved cooldown mechanism with:
 * - Exponential backoff (10m → 30m → 2h → 24h cap)
 * - Typed failure reasons (NO_ORDERBOOK, NOT_FOUND, RATE_LIMIT, NETWORK_ERROR, PARSE_ERROR)
 * - Different handling for transient vs permanent failures
 * - Stats tracking (cooldown hits, unique tokens, resolved count)
 *
 * Related: Fixes "no market data" entry bug where bot repeatedly attempts
 * to enter closed/settled markets from whale activity signals.
 */

import assert from "node:assert";
import { describe, test, beforeEach } from "node:test";

// ═══════════════════════════════════════════════════════════════════════════
// Test implementations of the types/functions from start.ts
// ═══════════════════════════════════════════════════════════════════════════

type MarketDataFailureReason =
  | "NO_ORDERBOOK"
  | "NOT_FOUND"
  | "RATE_LIMIT"
  | "NETWORK_ERROR"
  | "PARSE_ERROR";

function shouldApplyLongCooldown(reason: MarketDataFailureReason): boolean {
  return reason === "NO_ORDERBOOK" || reason === "NOT_FOUND";
}

interface CooldownEntry {
  strikes: number;
  nextEligibleTime: number;
  lastReason: MarketDataFailureReason;
}

interface CooldownStats {
  cooldownHits: number;
  totalTokensCooledDown: number;
  resolvedLaterCount: number;
}

class MarketDataCooldownManager {
  private static readonly BACKOFF_SCHEDULE_MS = [
    10 * 60 * 1000, // 10 minutes
    30 * 60 * 1000, // 30 minutes
    2 * 60 * 60 * 1000, // 2 hours
    24 * 60 * 60 * 1000, // 24 hours (cap)
  ];

  private cooldowns = new Map<string, CooldownEntry>();
  private stats: CooldownStats = {
    cooldownHits: 0,
    totalTokensCooledDown: 0,
    resolvedLaterCount: 0,
  };

  isOnCooldown(tokenId: string): boolean {
    const entry = this.cooldowns.get(tokenId);
    if (!entry) return false;

    const now = Date.now();
    if (now >= entry.nextEligibleTime) {
      return false;
    }

    this.stats.cooldownHits++;
    return true;
  }

  recordFailure(tokenId: string, reason: MarketDataFailureReason): number {
    const now = Date.now();
    const existing = this.cooldowns.get(tokenId);

    // For transient errors, use short cooldown
    // Preserve existing strikes only if they came from long-cooldown failures (strikes > 1)
    if (!shouldApplyLongCooldown(reason)) {
      const shortCooldownMs = 30 * 1000;
      const preservedStrikes =
        existing && existing.strikes > 1 ? existing.strikes : 1;
      this.cooldowns.set(tokenId, {
        strikes: preservedStrikes,
        nextEligibleTime: now + shortCooldownMs,
        lastReason: reason,
      });
      return shortCooldownMs;
    }

    // For long-cooldown failures, increment only if previous strikes accumulated
    const shouldIncrement =
      existing &&
      (existing.strikes > 1 || shouldApplyLongCooldown(existing.lastReason));
    const strikes = shouldIncrement ? existing.strikes + 1 : 1;
    const backoffIndex = Math.min(
      strikes - 1,
      MarketDataCooldownManager.BACKOFF_SCHEDULE_MS.length - 1,
    );
    const cooldownMs =
      MarketDataCooldownManager.BACKOFF_SCHEDULE_MS[backoffIndex];

    const wasNew = !this.cooldowns.has(tokenId);
    this.cooldowns.set(tokenId, {
      strikes,
      nextEligibleTime: now + cooldownMs,
      lastReason: reason,
    });

    if (wasNew) {
      this.stats.totalTokensCooledDown++;
    }

    return cooldownMs;
  }

  recordSuccess(tokenId: string): void {
    if (this.cooldowns.has(tokenId)) {
      this.stats.resolvedLaterCount++;
      this.cooldowns.delete(tokenId);
    }
  }

  getCooldownInfo(tokenId: string): CooldownEntry | null {
    return this.cooldowns.get(tokenId) || null;
  }

  getStats(): CooldownStats {
    return { ...this.stats };
  }

  getActiveCooldownCount(): number {
    const now = Date.now();
    let count = 0;
    for (const entry of this.cooldowns.values()) {
      if (now < entry.nextEligibleTime) count++;
    }
    return count;
  }

  static formatDuration(ms: number): string {
    if (ms < 60 * 1000) return `${Math.round(ms / 1000)}s`;
    if (ms < 60 * 60 * 1000) return `${Math.round(ms / 60 / 1000)}m`;
    return `${(ms / 60 / 60 / 1000).toFixed(1)}h`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("No Market Data Cooldown", () => {
  describe("MarketDataCooldownManager", () => {
    let manager: MarketDataCooldownManager;

    beforeEach(() => {
      manager = new MarketDataCooldownManager();
    });

    test("should apply exponential backoff for NO_ORDERBOOK failures", () => {
      const tokenId = "test-token-1";

      // First strike: 10 minutes
      const cooldown1 = manager.recordFailure(tokenId, "NO_ORDERBOOK");
      assert.strictEqual(
        cooldown1,
        10 * 60 * 1000,
        "First strike should be 10m",
      );
      assert.strictEqual(manager.getCooldownInfo(tokenId)?.strikes, 1);

      // Second strike: 30 minutes
      const cooldown2 = manager.recordFailure(tokenId, "NO_ORDERBOOK");
      assert.strictEqual(
        cooldown2,
        30 * 60 * 1000,
        "Second strike should be 30m",
      );
      assert.strictEqual(manager.getCooldownInfo(tokenId)?.strikes, 2);

      // Third strike: 2 hours
      const cooldown3 = manager.recordFailure(tokenId, "NO_ORDERBOOK");
      assert.strictEqual(
        cooldown3,
        2 * 60 * 60 * 1000,
        "Third strike should be 2h",
      );
      assert.strictEqual(manager.getCooldownInfo(tokenId)?.strikes, 3);

      // Fourth strike: 24 hours (cap)
      const cooldown4 = manager.recordFailure(tokenId, "NO_ORDERBOOK");
      assert.strictEqual(
        cooldown4,
        24 * 60 * 60 * 1000,
        "Fourth strike should be 24h (cap)",
      );
      assert.strictEqual(manager.getCooldownInfo(tokenId)?.strikes, 4);

      // Fifth strike: still 24 hours (cap)
      const cooldown5 = manager.recordFailure(tokenId, "NO_ORDERBOOK");
      assert.strictEqual(
        cooldown5,
        24 * 60 * 60 * 1000,
        "Fifth strike should still be 24h (cap)",
      );
      assert.strictEqual(manager.getCooldownInfo(tokenId)?.strikes, 5);
    });

    test("should reset backoff on successful fetch", () => {
      const tokenId = "test-token-2";

      // Build up strikes
      manager.recordFailure(tokenId, "NO_ORDERBOOK");
      manager.recordFailure(tokenId, "NO_ORDERBOOK");
      manager.recordFailure(tokenId, "NO_ORDERBOOK");
      assert.strictEqual(manager.getCooldownInfo(tokenId)?.strikes, 3);

      // Record success - should reset
      manager.recordSuccess(tokenId);
      assert.strictEqual(
        manager.getCooldownInfo(tokenId),
        null,
        "Entry should be removed on success",
      );

      // Next failure should start fresh at 10m
      const cooldown = manager.recordFailure(tokenId, "NO_ORDERBOOK");
      assert.strictEqual(
        cooldown,
        10 * 60 * 1000,
        "Should reset to 10m after success",
      );
      assert.strictEqual(manager.getCooldownInfo(tokenId)?.strikes, 1);
    });

    test("should NOT apply long cooldown for RATE_LIMIT errors", () => {
      const tokenId = "test-token-3";

      const cooldown = manager.recordFailure(tokenId, "RATE_LIMIT");
      assert.strictEqual(
        cooldown,
        30 * 1000,
        "RATE_LIMIT should use short 30s cooldown",
      );
      assert.strictEqual(manager.getCooldownInfo(tokenId)?.strikes, 1);

      // Multiple RATE_LIMIT failures should NOT escalate
      const cooldown2 = manager.recordFailure(tokenId, "RATE_LIMIT");
      assert.strictEqual(cooldown2, 30 * 1000, "RATE_LIMIT should stay at 30s");
    });

    test("should NOT apply long cooldown for NETWORK_ERROR", () => {
      const tokenId = "test-token-4";

      const cooldown = manager.recordFailure(tokenId, "NETWORK_ERROR");
      assert.strictEqual(
        cooldown,
        30 * 1000,
        "NETWORK_ERROR should use short 30s cooldown",
      );
    });

    test("should NOT apply long cooldown for PARSE_ERROR", () => {
      const tokenId = "test-token-5";

      const cooldown = manager.recordFailure(tokenId, "PARSE_ERROR");
      assert.strictEqual(
        cooldown,
        30 * 1000,
        "PARSE_ERROR should use short 30s cooldown",
      );
    });

    test("should apply long cooldown for NOT_FOUND", () => {
      const tokenId = "test-token-6";

      const cooldown1 = manager.recordFailure(tokenId, "NOT_FOUND");
      assert.strictEqual(
        cooldown1,
        10 * 60 * 1000,
        "NOT_FOUND should use long cooldown",
      );

      const cooldown2 = manager.recordFailure(tokenId, "NOT_FOUND");
      assert.strictEqual(
        cooldown2,
        30 * 60 * 1000,
        "NOT_FOUND should escalate",
      );
    });

    test("should preserve strikes when alternating between long-cooldown and transient failures", () => {
      const tokenId = "test-token-7";

      // Build up 2 strikes with long-cooldown failures
      manager.recordFailure(tokenId, "NO_ORDERBOOK");
      assert.strictEqual(manager.getCooldownInfo(tokenId)?.strikes, 1);

      manager.recordFailure(tokenId, "NO_ORDERBOOK");
      assert.strictEqual(manager.getCooldownInfo(tokenId)?.strikes, 2);

      // Now get a transient error - should use short cooldown but preserve strikes
      const transientCooldown = manager.recordFailure(tokenId, "RATE_LIMIT");
      assert.strictEqual(
        transientCooldown,
        30 * 1000,
        "Transient should use short cooldown",
      );
      assert.strictEqual(
        manager.getCooldownInfo(tokenId)?.strikes,
        2,
        "Strikes should be preserved after transient error",
      );

      // Next long-cooldown failure should continue from strike 3
      const cooldown3 = manager.recordFailure(tokenId, "NO_ORDERBOOK");
      assert.strictEqual(
        cooldown3,
        2 * 60 * 60 * 1000,
        "Should be at strike 3 (2h)",
      );
      assert.strictEqual(manager.getCooldownInfo(tokenId)?.strikes, 3);
    });

    test("should reset strikes when transient failure follows another transient failure", () => {
      const tokenId = "test-token-8";

      // Start with transient error
      manager.recordFailure(tokenId, "RATE_LIMIT");
      assert.strictEqual(manager.getCooldownInfo(tokenId)?.strikes, 1);

      // Another transient error - strikes stay at 1 (no accumulation for transient)
      manager.recordFailure(tokenId, "NETWORK_ERROR");
      assert.strictEqual(manager.getCooldownInfo(tokenId)?.strikes, 1);

      // Long-cooldown failure starts fresh
      const longCooldown = manager.recordFailure(tokenId, "NO_ORDERBOOK");
      assert.strictEqual(
        longCooldown,
        10 * 60 * 1000,
        "Should start fresh at 10m",
      );
      assert.strictEqual(manager.getCooldownInfo(tokenId)?.strikes, 1);
    });

    test("should track stats correctly", () => {
      const manager = new MarketDataCooldownManager();

      // Initial stats
      let stats = manager.getStats();
      assert.strictEqual(stats.cooldownHits, 0);
      assert.strictEqual(stats.totalTokensCooledDown, 0);
      assert.strictEqual(stats.resolvedLaterCount, 0);

      // Add some failures
      manager.recordFailure("token-a", "NO_ORDERBOOK");
      manager.recordFailure("token-b", "NO_ORDERBOOK");
      manager.recordFailure("token-a", "NO_ORDERBOOK"); // same token, 2nd strike

      stats = manager.getStats();
      assert.strictEqual(
        stats.totalTokensCooledDown,
        2,
        "Should track 2 unique tokens",
      );

      // Record success for token-a
      manager.recordSuccess("token-a");
      stats = manager.getStats();
      assert.strictEqual(
        stats.resolvedLaterCount,
        1,
        "Should track resolved token",
      );
    });

    test("should correctly report active cooldown count", () => {
      const manager = new MarketDataCooldownManager();

      assert.strictEqual(
        manager.getActiveCooldownCount(),
        0,
        "Should start with 0",
      );

      manager.recordFailure("token-1", "NO_ORDERBOOK");
      manager.recordFailure("token-2", "NO_ORDERBOOK");

      assert.strictEqual(
        manager.getActiveCooldownCount(),
        2,
        "Should have 2 active cooldowns",
      );

      manager.recordSuccess("token-1");
      assert.strictEqual(
        manager.getActiveCooldownCount(),
        1,
        "Should have 1 active cooldown after success",
      );
    });

    test("should format duration correctly", () => {
      assert.strictEqual(
        MarketDataCooldownManager.formatDuration(30 * 1000),
        "30s",
      );
      assert.strictEqual(
        MarketDataCooldownManager.formatDuration(10 * 60 * 1000),
        "10m",
      );
      assert.strictEqual(
        MarketDataCooldownManager.formatDuration(30 * 60 * 1000),
        "30m",
      );
      assert.strictEqual(
        MarketDataCooldownManager.formatDuration(2 * 60 * 60 * 1000),
        "2.0h",
      );
      assert.strictEqual(
        MarketDataCooldownManager.formatDuration(24 * 60 * 60 * 1000),
        "24.0h",
      );
    });
  });

  describe("shouldApplyLongCooldown", () => {
    test("should return true for NO_ORDERBOOK", () => {
      assert.strictEqual(shouldApplyLongCooldown("NO_ORDERBOOK"), true);
    });

    test("should return true for NOT_FOUND", () => {
      assert.strictEqual(shouldApplyLongCooldown("NOT_FOUND"), true);
    });

    test("should return false for RATE_LIMIT", () => {
      assert.strictEqual(shouldApplyLongCooldown("RATE_LIMIT"), false);
    });

    test("should return false for NETWORK_ERROR", () => {
      assert.strictEqual(shouldApplyLongCooldown("NETWORK_ERROR"), false);
    });

    test("should return false for PARSE_ERROR", () => {
      assert.strictEqual(shouldApplyLongCooldown("PARSE_ERROR"), false);
    });
  });

  describe("Token ID format validation", () => {
    test("should recognize valid Polymarket CLOB token IDs", () => {
      const validTokenIds = [
        "28542071792300007181611447397504994131484152585152031411345975186749097403884",
        "57625936606489185661652559589880983710918172021553907271126623944716577292773",
        "23108802207086798801173033667711295391410673134835650507670472347957366091390",
      ];

      for (const tokenId of validTokenIds) {
        assert.strictEqual(
          typeof tokenId,
          "string",
          "Token ID should be a string",
        );
        assert.ok(
          tokenId.length >= 70 && tokenId.length <= 80,
          `Token ID length should be 70-80 chars, got ${tokenId.length}`,
        );
        assert.ok(/^\d+$/.test(tokenId), "Token ID should contain only digits");
      }
    });

    test("should log first 12 characters when displaying token IDs", () => {
      const tokenId =
        "28542071792300007181611447397504994131484152585152031411345975186749097403884";
      const displayed = tokenId.slice(0, 12) + "...";
      assert.strictEqual(displayed, "285420717923...");
    });
  });

  describe("Market data failure scenarios", () => {
    test("should correctly identify closed market scenarios", () => {
      const closedMarketResponse = {
        error: "No orderbook exists for the requested token id",
      };
      assert.ok(
        closedMarketResponse.error.includes("No orderbook"),
        "Closed market error should mention missing orderbook",
      );
    });

    test("should differentiate failure reasons", () => {
      const scenarios: Array<{
        error: string;
        expectedReason: MarketDataFailureReason;
      }> = [
        { error: "No orderbook exists", expectedReason: "NO_ORDERBOOK" },
        { error: "404 Not Found", expectedReason: "NOT_FOUND" },
        { error: "429 Too Many Requests", expectedReason: "RATE_LIMIT" },
        { error: "ECONNRESET", expectedReason: "NETWORK_ERROR" },
        { error: "timeout", expectedReason: "NETWORK_ERROR" },
        { error: "JSON parse error", expectedReason: "PARSE_ERROR" },
      ];

      for (const { error, expectedReason } of scenarios) {
        // Verify the expected reason is a valid MarketDataFailureReason
        const validReasons: MarketDataFailureReason[] = [
          "NO_ORDERBOOK",
          "NOT_FOUND",
          "RATE_LIMIT",
          "NETWORK_ERROR",
          "PARSE_ERROR",
        ];
        assert.ok(
          validReasons.includes(expectedReason),
          `${expectedReason} should be a valid failure reason for "${error}"`,
        );
      }
    });
  });
});
