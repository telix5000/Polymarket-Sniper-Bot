import assert from "node:assert";
import { test, describe } from "node:test";

/**
 * Unit tests for V2 Scavenger Mode
 *
 * Tests the unified scavenger module that handles:
 * - State management
 * - Mode detection and switching
 * - Green position exit logic
 * - Red position recovery
 * - Risk constraints
 */

import {
  // State management
  createScavengerState,
  resetScavengerState,
  updatePriceHistory,
  isPriceStalled,
  isOnCooldown,
  setTokenCooldown,
  cleanExpiredCooldowns,
  // Position checks
  isGreenPosition,
  hasRedPositionRecovered,
  canMicroBuy,
  // Detection
  recordVolumeSample,
  recordOrderBookSnapshot,
  recordTargetActivity,
  analyzeMarketConditions,
  // Helpers
  isScavengerMode,
  formatModeState,
  getScavengerSummary,
  // Types & config
  TradingMode,
  DEFAULT_SCAVENGER_CONFIG,
  type ScavengerState,
  type ScavengerConfig,
} from "../../src/lib/scavenger";

// Helper to create a mock position
function createMockPosition(
  overrides: Partial<{
    tokenId: string;
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
    conditionId: "condition-123",
    marketId: "market-123",
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

describe("Scavenger State Management", () => {
  test("creates initial state", () => {
    const state = createScavengerState();
    assert.strictEqual(state.mode, TradingMode.NORMAL);
    assert.strictEqual(state.tokenCooldowns.size, 0);
    assert.strictEqual(state.deployedCapitalUsd, 0);
  });

  test("resets state preserving cooldowns", () => {
    let state = createScavengerState();
    state = setTokenCooldown(state, "token-1", 60000);
    state.deployedCapitalUsd = 100;
    state.monitoredRedPositions.add("token-2");
    state.volumeSamples.push({ timestamp: Date.now(), volumeUsd: 1000 });
    state.lowLiquidityDetectedAt = Date.now();

    const reset = resetScavengerState(state);
    assert.strictEqual(reset.tokenCooldowns.size, 1); // Preserved
    assert.strictEqual(reset.deployedCapitalUsd, 0); // Reset
    assert.strictEqual(reset.monitoredRedPositions.size, 0); // Reset
    assert.strictEqual(reset.volumeSamples.length, 0); // Detection history reset
    assert.strictEqual(reset.lowLiquidityDetectedAt, null); // Detection timestamp reset
  });
});

describe("Scavenger Price Tracking", () => {
  test("updates price history", () => {
    let state = createScavengerState();
    state = updatePriceHistory(state, "token-1", 0.5, 60000);
    state = updatePriceHistory(state, "token-1", 0.51, 60000);
    assert.strictEqual(state.priceHistory.get("token-1")?.length, 2);
  });

  test("detects stalled prices", () => {
    let state = createScavengerState();
    state = updatePriceHistory(state, "token-1", 0.5, 60000);
    state = updatePriceHistory(state, "token-1", 0.5, 60000);
    state = updatePriceHistory(state, "token-1", 0.5, 60000);
    assert.strictEqual(isPriceStalled(state, "token-1", 60000), true);
  });

  test("detects moving prices", () => {
    let state = createScavengerState();
    state = updatePriceHistory(state, "token-1", 0.5, 60000);
    state = updatePriceHistory(state, "token-1", 0.55, 60000);
    assert.strictEqual(isPriceStalled(state, "token-1", 60000), false);
  });
});

describe("Scavenger Cooldowns", () => {
  test("sets and checks cooldown", () => {
    let state = createScavengerState();
    state = setTokenCooldown(state, "token-1", 60000);
    assert.strictEqual(isOnCooldown(state, "token-1"), true);
    assert.strictEqual(isOnCooldown(state, "unknown"), false);
  });

  test("cleans expired cooldowns", () => {
    let state = createScavengerState();
    state = setTokenCooldown(state, "active", 60000);
    state = setTokenCooldown(state, "expired", -1000);
    state = cleanExpiredCooldowns(state);
    assert.strictEqual(state.tokenCooldowns.size, 1);
    assert.ok(state.tokenCooldowns.has("active"));
  });
});

describe("Scavenger Position Logic", () => {
  test("identifies green position", () => {
    const pos = createMockPosition({ pnlPct: 10, pnlUsd: 5 });
    assert.strictEqual(isGreenPosition(pos, 1, 0.5), true);
  });

  test("rejects position below thresholds", () => {
    const pos = createMockPosition({ pnlPct: 0.5, pnlUsd: 0.25 });
    assert.strictEqual(isGreenPosition(pos, 1, 0.5), false);
  });

  test("detects recovered red position", () => {
    const pos = createMockPosition({ pnlPct: 1, pnlUsd: 0.5 });
    assert.strictEqual(hasRedPositionRecovered(pos, 0.5, 0.25), true);
  });

  test("rejects still-red position", () => {
    const pos = createMockPosition({ pnlPct: -2, pnlUsd: -1 });
    assert.strictEqual(hasRedPositionRecovered(pos, 0.5, 0.25), false);
  });
});

describe("Scavenger Risk Constraints", () => {
  const config: ScavengerConfig = {
    ...DEFAULT_SCAVENGER_CONFIG,
    microBuy: { ...DEFAULT_SCAVENGER_CONFIG.microBuy, enabled: true },
  };

  test("allows micro-buy when constraints met", () => {
    const state = createScavengerState();
    const result = canMicroBuy(state, config, 1000, "new-token");
    assert.strictEqual(result.allowed, true);
    assert.ok(result.maxSizeUsd);
  });

  test("blocks micro-buy when disabled", () => {
    const disabled = {
      ...config,
      microBuy: { ...config.microBuy, enabled: false },
    };
    const result = canMicroBuy(createScavengerState(), disabled, 1000, "token");
    assert.strictEqual(result.allowed, false);
  });

  test("blocks micro-buy on cooldown", () => {
    let state = createScavengerState();
    state = setTokenCooldown(state, "cooled", 60000);
    const result = canMicroBuy(state, config, 1000, "cooled");
    assert.strictEqual(result.allowed, false);
  });

  test("blocks micro-buy at position cap", () => {
    const state = createScavengerState();
    state.scavengerPositionCount = config.risk.maxScavengePositions;
    const result = canMicroBuy(state, config, 1000, "token");
    assert.strictEqual(result.allowed, false);
  });

  test("blocks micro-buy at capital cap", () => {
    const state = createScavengerState();
    state.deployedCapitalUsd = config.risk.maxDeployedCapitalUsd;
    const result = canMicroBuy(state, config, 1000, "token");
    assert.strictEqual(result.allowed, false);
  });
});

describe("Scavenger Mode Detection", () => {
  test("records volume samples", () => {
    let state = createScavengerState();
    state = recordVolumeSample(state, 1000, 300000);
    state = recordVolumeSample(state, 2000, 300000);
    assert.strictEqual(state.volumeSamples.length, 2);
  });

  test("records order book snapshots", () => {
    let state = createScavengerState();
    state = recordOrderBookSnapshot(
      state,
      { bidDepthUsd: 500, askDepthUsd: 500, bestBid: 0.5, bestAsk: 0.51 },
      120000,
    );
    assert.strictEqual(state.orderBookSnapshots.length, 1);
  });

  test("records target activity", () => {
    let state = createScavengerState();
    state = recordTargetActivity(state, 5, 10, 300000);
    assert.strictEqual(state.targetActivitySamples.length, 1);
  });

  test("detects low liquidity conditions", () => {
    let state = createScavengerState();
    state = recordVolumeSample(state, 100, 300000); // Low volume
    state = recordOrderBookSnapshot(
      state,
      { bidDepthUsd: 100, askDepthUsd: 100, bestBid: 0.5, bestAsk: 0.51 },
      120000,
    ); // Thin book
    state = recordTargetActivity(state, 0, 10, 300000); // No active targets

    const { reasons } = analyzeMarketConditions(
      state,
      DEFAULT_SCAVENGER_CONFIG,
    );
    assert.ok(reasons.length > 0);
  });

  test("triggers mode switch after sustained low liquidity", () => {
    let state = createScavengerState();
    state.lowLiquidityDetectedAt = Date.now() - 300000; // 5 min ago
    state = recordVolumeSample(state, 100, 300000);
    state = recordOrderBookSnapshot(
      state,
      { bidDepthUsd: 100, askDepthUsd: 100, bestBid: 0.5, bestAsk: 0.51 },
      120000,
    );
    state = recordTargetActivity(state, 0, 10, 300000);

    const { shouldSwitch, newMode } = analyzeMarketConditions(
      state,
      DEFAULT_SCAVENGER_CONFIG,
    );
    assert.strictEqual(shouldSwitch, true);
    assert.strictEqual(newMode, TradingMode.SCAVENGER);
  });
});

describe("Scavenger Helpers", () => {
  test("isScavengerMode checks mode correctly", () => {
    const normal = createScavengerState();
    assert.strictEqual(isScavengerMode(normal), false);

    const scavenger = { ...normal, mode: TradingMode.SCAVENGER };
    assert.strictEqual(isScavengerMode(scavenger), true);
  });

  test("formatModeState returns readable string", () => {
    const state = createScavengerState();
    const formatted = formatModeState(state);
    assert.ok(formatted.includes("NORMAL"));
  });

  test("getScavengerSummary returns info", () => {
    const state = createScavengerState();
    state.deployedCapitalUsd = 50;
    state.scavengerPositionCount = 3;
    state.monitoredRedPositions.add("token-1");

    const summary = getScavengerSummary(state, DEFAULT_SCAVENGER_CONFIG);
    assert.ok(summary.includes("Scavenger"));
    assert.ok(summary.includes("$50.00"));
    assert.ok(summary.includes("3"));
  });
});
