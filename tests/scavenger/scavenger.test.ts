import assert from "node:assert";
import { test, describe } from "node:test";

/**
 * Unit tests for V2 Scavenger Mode - Scavenger Logic
 *
 * These tests verify:
 * 1. Scavenger state management
 * 2. Green position exit logic
 * 3. Red position recovery monitoring
 * 4. Risk constraints (position cap, capital limits, cooldowns)
 * 5. No churn in dead markets
 * 6. No forced losses
 */

import {
  createScavengerState,
  resetScavengerState,
  updatePriceHistory,
  isPriceStalled,
  isOnCooldown,
  setTokenCooldown,
  cleanExpiredCooldowns,
  isGreenPosition,
  hasRedPositionRecovered,
  canMicroBuy,
  getScavengerSummary,
  type ScavengerState,
} from "../../src/lib/scavenger";

import {
  DEFAULT_SCAVENGER_CONFIG,
  type ScavengerConfig,
} from "../../src/lib/scavenger-config";

// Helper to create a mock position
function createMockPosition(
  overrides: Partial<{
    tokenId: string;
    conditionId: string;
    marketId: string;
    outcome: string;
    size: number;
    avgPrice: number;
    curPrice: number;
    pnlPct: number;
    pnlUsd: number;
    gainCents: number;
    value: number;
  }> = {},
) {
  const size = overrides.size ?? 100;
  const avgPrice = overrides.avgPrice ?? 0.5;
  const curPrice = overrides.curPrice ?? 0.55;
  const value = size * curPrice;
  const cost = size * avgPrice;
  const pnlUsd = value - cost;
  const pnlPct = cost > 0 ? (pnlUsd / cost) * 100 : 0;

  return {
    tokenId: overrides.tokenId ?? "token-123",
    conditionId: overrides.conditionId ?? "condition-123",
    marketId: overrides.marketId ?? "market-123",
    outcome: overrides.outcome ?? "YES",
    size,
    avgPrice,
    curPrice,
    pnlPct: overrides.pnlPct ?? pnlPct,
    pnlUsd: overrides.pnlUsd ?? pnlUsd,
    gainCents: overrides.gainCents ?? (curPrice - avgPrice) * 100,
    value: overrides.value ?? value,
  };
}

describe("V2 Scavenger State Management", () => {
  describe("State Creation and Reset", () => {
    test("creates initial state with empty collections", () => {
      const state = createScavengerState();

      assert.strictEqual(state.tokenCooldowns.size, 0);
      assert.strictEqual(state.priceHistory.size, 0);
      assert.strictEqual(state.deployedCapitalUsd, 0);
      assert.strictEqual(state.scavengerPositionCount, 0);
      assert.strictEqual(state.monitoredRedPositions.size, 0);
      assert.strictEqual(state.scavengerEntryPrices.size, 0);
    });

    test("resetScavengerState preserves cooldowns but clears tracking", () => {
      let state = createScavengerState();

      // Add some data
      state = setTokenCooldown(state, "token-1", 60000);
      state = updatePriceHistory(state, "token-2", 0.5);
      state.deployedCapitalUsd = 100;
      state.scavengerPositionCount = 5;
      state.monitoredRedPositions.add("token-3");

      const reset = resetScavengerState(state);

      // Cooldowns should persist
      assert.strictEqual(reset.tokenCooldowns.size, 1);

      // Tracking should be reset
      assert.strictEqual(reset.priceHistory.size, 0);
      assert.strictEqual(reset.deployedCapitalUsd, 0);
      assert.strictEqual(reset.scavengerPositionCount, 0);
      assert.strictEqual(reset.monitoredRedPositions.size, 0);
    });
  });

  describe("Price History and Stall Detection", () => {
    test("updatePriceHistory adds samples", () => {
      let state = createScavengerState();
      state = updatePriceHistory(state, "token-1", 0.5, 60000);
      state = updatePriceHistory(state, "token-1", 0.51, 60000);

      const history = state.priceHistory.get("token-1");
      assert.ok(history);
      assert.strictEqual(history.length, 2);
    });

    test("updatePriceHistory prunes old samples", () => {
      let state = createScavengerState();

      // Add samples with old timestamps (simulated)
      state = updatePriceHistory(state, "token-1", 0.5, 1000); // Very short window

      // Add more samples - old ones should be pruned
      state = updatePriceHistory(state, "token-1", 0.51, 1000);
      state = updatePriceHistory(state, "token-1", 0.52, 1000);

      const history = state.priceHistory.get("token-1");
      assert.ok(history);
      // Should have samples based on window
      assert.ok(history.length > 0);
      assert.ok(history.length <= 50); // Max cap
    });

    test("isPriceStalled returns false with insufficient history", () => {
      const state = createScavengerState();
      assert.strictEqual(isPriceStalled(state, "token-1", 30000), false);
    });

    test("isPriceStalled detects stalled prices", () => {
      let state = createScavengerState();

      // Add samples at the same price
      state = updatePriceHistory(state, "token-1", 0.5, 60000);
      state = updatePriceHistory(state, "token-1", 0.5, 60000);
      state = updatePriceHistory(state, "token-1", 0.5, 60000);

      // Should detect stall (price hasn't moved)
      assert.strictEqual(isPriceStalled(state, "token-1", 60000), true);
    });

    test("isPriceStalled returns false when price is increasing", () => {
      let state = createScavengerState();

      // Add samples with increasing price
      state = updatePriceHistory(state, "token-1", 0.5, 60000);
      state = updatePriceHistory(state, "token-1", 0.55, 60000); // +10% increase

      // Price is moving, not stalled
      assert.strictEqual(isPriceStalled(state, "token-1", 60000), false);
    });
  });

  describe("Cooldown Management", () => {
    test("isOnCooldown returns false for unknown token", () => {
      const state = createScavengerState();
      assert.strictEqual(isOnCooldown(state, "unknown-token"), false);
    });

    test("setTokenCooldown adds cooldown", () => {
      let state = createScavengerState();
      state = setTokenCooldown(state, "token-1", 60000);

      assert.strictEqual(isOnCooldown(state, "token-1"), true);
    });

    test("isOnCooldown returns false for expired cooldown", () => {
      let state = createScavengerState();

      // Set cooldown that expires immediately (0ms)
      state = setTokenCooldown(state, "token-1", -1000); // Expired 1 second ago

      assert.strictEqual(isOnCooldown(state, "token-1"), false);
    });

    test("cleanExpiredCooldowns removes expired entries", () => {
      let state = createScavengerState();

      // Add one active and one expired cooldown
      state = setTokenCooldown(state, "active-token", 60000);
      state = setTokenCooldown(state, "expired-token", -1000);

      state = cleanExpiredCooldowns(state);

      assert.strictEqual(state.tokenCooldowns.size, 1);
      assert.ok(state.tokenCooldowns.has("active-token"));
      assert.ok(!state.tokenCooldowns.has("expired-token"));
    });
  });
});

describe("V2 Scavenger Position Logic", () => {
  describe("Green Position Detection", () => {
    test("identifies green position meeting all criteria", () => {
      const position = createMockPosition({
        avgPrice: 0.5,
        curPrice: 0.55,
        pnlPct: 10,
        pnlUsd: 5,
      });

      assert.strictEqual(isGreenPosition(position, 1, 0.5), true);
    });

    test("rejects position below profit percentage", () => {
      const position = createMockPosition({
        pnlPct: 0.5, // Below 1% threshold
        pnlUsd: 5,
      });

      assert.strictEqual(isGreenPosition(position, 1, 0.5), false);
    });

    test("rejects position below profit USD", () => {
      const position = createMockPosition({
        pnlPct: 10,
        pnlUsd: 0.25, // Below $0.50 threshold
      });

      assert.strictEqual(isGreenPosition(position, 1, 0.5), false);
    });

    test("rejects red position", () => {
      const position = createMockPosition({
        pnlPct: -5,
        pnlUsd: -2.5,
      });

      assert.strictEqual(isGreenPosition(position, 1, 0.5), false);
    });
  });

  describe("Red Position Recovery Detection", () => {
    test("detects recovered red position", () => {
      const position = createMockPosition({
        pnlPct: 1, // Small profit
        pnlUsd: 0.5,
      });

      assert.strictEqual(hasRedPositionRecovered(position, 0.5, 0.25), true);
    });

    test("rejects position still in red", () => {
      const position = createMockPosition({
        pnlPct: -2,
        pnlUsd: -1,
      });

      assert.strictEqual(hasRedPositionRecovered(position, 0.5, 0.25), false);
    });

    test("rejects position with insufficient recovery profit", () => {
      const position = createMockPosition({
        pnlPct: 0.3, // Below 0.5% threshold
        pnlUsd: 0.15, // Below $0.25 threshold
      });

      assert.strictEqual(hasRedPositionRecovered(position, 0.5, 0.25), false);
    });
  });
});

describe("V2 Scavenger Risk Constraints", () => {
  const config: ScavengerConfig = {
    ...DEFAULT_SCAVENGER_CONFIG,
    microBuy: {
      ...DEFAULT_SCAVENGER_CONFIG.microBuy,
      enabled: true,
      maxCapitalFraction: 0.05,
      maxPositionUsd: 10,
    },
    risk: {
      maxDeployedCapitalUsd: 100,
      maxScavengePositions: 10,
      tokenCooldownMs: 300000,
    },
  };

  describe("Micro-Buy Eligibility", () => {
    test("allows micro-buy when all constraints met", () => {
      const state = createScavengerState();
      const result = canMicroBuy(state, config, 1000, "new-token");

      assert.strictEqual(result.allowed, true);
      assert.ok(result.maxSizeUsd);
      assert.ok(result.maxSizeUsd <= config.microBuy.maxPositionUsd);
    });

    test("blocks micro-buy when disabled", () => {
      const disabledConfig = {
        ...config,
        microBuy: { ...config.microBuy, enabled: false },
      };
      const state = createScavengerState();
      const result = canMicroBuy(state, disabledConfig, 1000, "token");

      assert.strictEqual(result.allowed, false);
      assert.ok(result.reason?.includes("disabled"));
    });

    test("blocks micro-buy when token on cooldown", () => {
      let state = createScavengerState();
      state = setTokenCooldown(state, "cooled-token", 60000);

      const result = canMicroBuy(state, config, 1000, "cooled-token");

      assert.strictEqual(result.allowed, false);
      assert.ok(result.reason?.includes("cooldown"));
    });

    test("blocks micro-buy when at position cap", () => {
      const state = createScavengerState();
      state.scavengerPositionCount = config.risk.maxScavengePositions;

      const result = canMicroBuy(state, config, 1000, "token");

      assert.strictEqual(result.allowed, false);
      assert.ok(result.reason?.includes("positions"));
    });

    test("blocks micro-buy when at capital cap", () => {
      const state = createScavengerState();
      state.deployedCapitalUsd = config.risk.maxDeployedCapitalUsd;

      const result = canMicroBuy(state, config, 1000, "token");

      assert.strictEqual(result.allowed, false);
      assert.ok(result.reason?.includes("capital"));
    });

    test("limits size based on capital fraction", () => {
      const state = createScavengerState();
      const availableCapital = 100; // $100 available

      const result = canMicroBuy(state, config, availableCapital, "token");

      assert.strictEqual(result.allowed, true);
      // Max should be min of: 5% of $100 = $5, or $10 position cap
      assert.ok(result.maxSizeUsd);
      assert.ok(result.maxSizeUsd <= 5);
    });
  });

  describe("No Churn in Dead Markets", () => {
    test("cooldowns prevent rapid re-entry", () => {
      let state = createScavengerState();

      // Simulate exit
      state = setTokenCooldown(
        state,
        "exited-token",
        config.risk.tokenCooldownMs,
      );

      // Immediate re-entry attempt should fail
      const result = canMicroBuy(state, config, 1000, "exited-token");

      assert.strictEqual(result.allowed, false);
      assert.ok(result.reason?.includes("cooldown"));
    });

    test("position cap limits exposure", () => {
      const state = createScavengerState();
      state.scavengerPositionCount = config.risk.maxScavengePositions;

      // Cannot open more positions
      const result = canMicroBuy(state, config, 1000, "new-token");

      assert.strictEqual(result.allowed, false);
    });

    test("capital cap limits total deployment", () => {
      const state = createScavengerState();
      state.deployedCapitalUsd = config.risk.maxDeployedCapitalUsd;

      // Cannot deploy more capital
      const result = canMicroBuy(state, config, 1000, "new-token");

      assert.strictEqual(result.allowed, false);
    });
  });

  describe("No Forced Losses", () => {
    test("green exit requires minimum profit", () => {
      const config = DEFAULT_SCAVENGER_CONFIG;
      const marginalPosition = createMockPosition({
        pnlPct: 0.5, // Below 1% threshold
        pnlUsd: 0.3, // Below $0.50 threshold
      });

      // Should NOT qualify for green exit
      assert.strictEqual(
        isGreenPosition(
          marginalPosition,
          config.exit.minGreenProfitPct,
          config.exit.minAcceptableProfitUsd,
        ),
        false,
      );
    });

    test("recovery exit requires positive profit", () => {
      const config = DEFAULT_SCAVENGER_CONFIG;
      const stillRedPosition = createMockPosition({
        pnlPct: -0.5,
        pnlUsd: -0.25,
      });

      // Should NOT qualify for recovery exit
      assert.strictEqual(
        hasRedPositionRecovered(
          stillRedPosition,
          config.redMonitor.smallProfitThresholdPct,
          config.redMonitor.minRecoveryProfitUsd,
        ),
        false,
      );
    });
  });
});

describe("V2 Scavenger Summary", () => {
  test("generates readable summary", () => {
    const state = createScavengerState();
    state.deployedCapitalUsd = 50;
    state.scavengerPositionCount = 3;
    state.monitoredRedPositions.add("token-1");
    state.monitoredRedPositions.add("token-2");

    const summary = getScavengerSummary(state, DEFAULT_SCAVENGER_CONFIG);

    assert.ok(summary.includes("Scavenger Mode"));
    assert.ok(summary.includes("Deployed"));
    assert.ok(summary.includes("$50.00"));
    assert.ok(summary.includes("Positions: 3"));
    assert.ok(summary.includes("Red Monitored: 2"));
  });
});
