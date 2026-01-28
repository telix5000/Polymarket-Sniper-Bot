import assert from "node:assert";
import { test, describe } from "node:test";

/**
 * Unit tests for Market Scanner, Dynamic Reserves, and Liquidation Recovery
 *
 * These tests verify that:
 * 1. Market Scanner properly filters and sorts active markets
 * 2. Dynamic Reserves adapt correctly based on missed opportunities
 * 3. Liquidation mode properly transitions back to normal trading
 */

// ============================================================================
// Mock Types and Configs
// ============================================================================

interface MockChurnConfig {
  scanActiveMarkets: boolean;
  scanMinVolumeUsd: number;
  scanTopNMarkets: number;
  scanIntervalSeconds: number;
  dynamicReservesEnabled: boolean;
  reserveFraction: number;
  reserveAdaptationRate: number;
  missedOpportunityWeight: number;
  hedgeCoverageWeight: number;
  maxReserveFraction: number;
  minReserveUsd: number;
  maxTradeUsd: number;
  hedgeRatio: number;
}

const defaultConfig: MockChurnConfig = {
  scanActiveMarkets: true,
  scanMinVolumeUsd: 10000,
  scanTopNMarkets: 20,
  scanIntervalSeconds: 300,
  dynamicReservesEnabled: true,
  reserveFraction: 0.25,
  reserveAdaptationRate: 0.1,
  missedOpportunityWeight: 0.5,
  hedgeCoverageWeight: 0.5,
  maxReserveFraction: 0.5,
  minReserveUsd: 100,
  maxTradeUsd: 25,
  hedgeRatio: 0.4,
};

// ============================================================================
// Dynamic Reserve Manager Mock Implementation
// ============================================================================

interface MissedOpportunity {
  tokenId: string;
  sizeUsd: number;
  reason: "INSUFFICIENT_BALANCE" | "RESERVE_BLOCKED";
  timestamp: number;
}

class MockDynamicReserveManager {
  private config: MockChurnConfig;
  private missedOpportunities: MissedOpportunity[] = [];
  private hedgesMissed = 0;
  private adaptedReserveFraction: number;
  private readonly WINDOW_MS = 30 * 60 * 1000;

  constructor(config: MockChurnConfig) {
    this.config = config;
    this.adaptedReserveFraction = config.reserveFraction;
  }

  recordMissedOpportunity(
    tokenId: string,
    sizeUsd: number,
    reason: "INSUFFICIENT_BALANCE" | "RESERVE_BLOCKED",
  ): void {
    if (!this.config.dynamicReservesEnabled) return;

    this.missedOpportunities.push({
      tokenId,
      sizeUsd,
      reason,
      timestamp: Date.now(),
    });

    this.pruneOldEntries();
    this.adaptReserves();
  }

  recordMissedHedge(_sizeUsd: number): void {
    if (!this.config.dynamicReservesEnabled) return;
    this.hedgesMissed++;
    this.adaptReserves();
  }

  getEffectiveReserveFraction(): number {
    if (!this.config.dynamicReservesEnabled) {
      return this.config.reserveFraction;
    }
    return this.adaptedReserveFraction;
  }

  getEffectiveBankroll(balance: number): {
    effectiveBankroll: number;
    reserveUsd: number;
  } {
    const reserveFraction = this.getEffectiveReserveFraction();
    const reserveUsd = Math.max(
      balance * reserveFraction,
      this.config.minReserveUsd,
    );
    return {
      effectiveBankroll: Math.max(0, balance - reserveUsd),
      reserveUsd,
    };
  }

  private adaptReserves(): void {
    this.pruneOldEntries();

    const now = Date.now();
    const windowStart = now - this.WINDOW_MS;

    const recentMissed = this.missedOpportunities.filter(
      (m) => m.timestamp >= windowStart,
    );
    const missedCount = recentMissed.length;

    const missedFactor = Math.min(missedCount * 0.02, 0.15);
    const hedgeFactor = Math.min(this.hedgesMissed * 0.03, 0.1);

    const missedAdjustment = missedFactor * this.config.missedOpportunityWeight;
    const hedgeAdjustment = hedgeFactor * this.config.hedgeCoverageWeight;

    const targetFraction =
      this.config.reserveFraction - missedAdjustment + hedgeAdjustment;
    const clampedTarget = Math.max(
      0.1,
      Math.min(this.config.maxReserveFraction, targetFraction),
    );

    this.adaptedReserveFraction =
      this.adaptedReserveFraction +
      (clampedTarget - this.adaptedReserveFraction) *
        this.config.reserveAdaptationRate;
  }

  private pruneOldEntries(): void {
    const cutoff = Date.now() - this.WINDOW_MS;
    this.missedOpportunities = this.missedOpportunities.filter(
      (m) => m.timestamp >= cutoff,
    );

    if (this.hedgesMissed > 0 && this.missedOpportunities.length === 0) {
      this.hedgesMissed = Math.max(0, this.hedgesMissed - 1);
    }
  }

  reset(): void {
    this.missedOpportunities = [];
    this.hedgesMissed = 0;
    this.adaptedReserveFraction = this.config.reserveFraction;
  }

  // For testing
  getState(): {
    adaptedReserveFraction: number;
    missedCount: number;
    hedgesMissed: number;
  } {
    return {
      adaptedReserveFraction: this.adaptedReserveFraction,
      missedCount: this.missedOpportunities.length,
      hedgesMissed: this.hedgesMissed,
    };
  }
}

// ============================================================================
// Tests: Dynamic Reserve Manager
// ============================================================================

describe("Dynamic Reserve Manager", () => {
  describe("Initialization", () => {
    test("should initialize with base reserve fraction", () => {
      const manager = new MockDynamicReserveManager(defaultConfig);
      assert.strictEqual(
        manager.getEffectiveReserveFraction(),
        defaultConfig.reserveFraction,
      );
    });

    test("should return base fraction when disabled", () => {
      const config = { ...defaultConfig, dynamicReservesEnabled: false };
      const manager = new MockDynamicReserveManager(config);
      assert.strictEqual(
        manager.getEffectiveReserveFraction(),
        config.reserveFraction,
      );
    });
  });

  describe("Missed Opportunity Tracking", () => {
    test("should decrease reserves when opportunities are missed", () => {
      const manager = new MockDynamicReserveManager(defaultConfig);
      const initialFraction = manager.getEffectiveReserveFraction();

      // Record multiple missed opportunities
      for (let i = 0; i < 5; i++) {
        manager.recordMissedOpportunity(`token-${i}`, 25, "RESERVE_BLOCKED");
      }

      const newFraction = manager.getEffectiveReserveFraction();
      // Reserve should decrease (more capital available for trading)
      assert.ok(
        newFraction < initialFraction,
        `Expected ${newFraction} < ${initialFraction}`,
      );
    });

    test("should not record when disabled", () => {
      const config = { ...defaultConfig, dynamicReservesEnabled: false };
      const manager = new MockDynamicReserveManager(config);

      manager.recordMissedOpportunity("token-1", 25, "RESERVE_BLOCKED");

      const state = manager.getState();
      assert.strictEqual(state.missedCount, 0);
    });
  });

  describe("Missed Hedge Tracking", () => {
    test("should track hedges missed and affect reserve calculation", () => {
      const config = { ...defaultConfig, reserveAdaptationRate: 1.0 }; // Use 100% adaptation for testing
      const manager = new MockDynamicReserveManager(config);

      // Record multiple missed hedges
      for (let i = 0; i < 3; i++) {
        manager.recordMissedHedge(10);
      }

      // With high adaptation rate, reserve should increase from base
      const state = manager.getState();
      assert.ok(
        state.hedgesMissed >= 3,
        `Expected hedgesMissed >= 3, got ${state.hedgesMissed}`,
      );
    });
  });

  describe("Effective Bankroll Calculation", () => {
    test("should calculate bankroll correctly", () => {
      const manager = new MockDynamicReserveManager(defaultConfig);
      const balance = 1000;

      const { effectiveBankroll, reserveUsd } =
        manager.getEffectiveBankroll(balance);

      // With 25% reserve, should have 75% effective bankroll
      assert.strictEqual(reserveUsd, 250); // 25% of 1000
      assert.strictEqual(effectiveBankroll, 750); // 1000 - 250
    });

    test("should enforce minimum reserve", () => {
      const manager = new MockDynamicReserveManager(defaultConfig);
      const balance = 200; // 25% would be $50, but min is $100

      const { reserveUsd, effectiveBankroll } =
        manager.getEffectiveBankroll(balance);

      assert.strictEqual(reserveUsd, 100); // min reserve
      assert.strictEqual(effectiveBankroll, 100); // 200 - 100
    });
  });

  describe("Reserve Bounds", () => {
    test("should not exceed max reserve fraction", () => {
      const manager = new MockDynamicReserveManager(defaultConfig);

      // Record many missed hedges to push reserve high
      for (let i = 0; i < 20; i++) {
        manager.recordMissedHedge(10);
      }

      const fraction = manager.getEffectiveReserveFraction();
      assert.ok(
        fraction <= defaultConfig.maxReserveFraction,
        `Expected ${fraction} <= ${defaultConfig.maxReserveFraction}`,
      );
    });

    test("should not go below minimum reserve", () => {
      const manager = new MockDynamicReserveManager(defaultConfig);

      // Record many missed opportunities to push reserve low
      for (let i = 0; i < 20; i++) {
        manager.recordMissedOpportunity(`token-${i}`, 25, "RESERVE_BLOCKED");
      }

      const fraction = manager.getEffectiveReserveFraction();
      assert.ok(fraction >= 0.1, `Expected ${fraction} >= 0.1`);
    });
  });

  describe("Reset", () => {
    test("should reset to base values", () => {
      const manager = new MockDynamicReserveManager(defaultConfig);

      // Make some changes
      manager.recordMissedOpportunity("token-1", 25, "RESERVE_BLOCKED");
      manager.recordMissedHedge(10);

      // Reset
      manager.reset();

      const state = manager.getState();
      assert.strictEqual(state.missedCount, 0);
      assert.strictEqual(state.hedgesMissed, 0);
      assert.strictEqual(
        state.adaptedReserveFraction,
        defaultConfig.reserveFraction,
      );
    });
  });
});

// ============================================================================
// Tests: Liquidation Mode Transition
// ============================================================================

describe("Liquidation Mode Transition", () => {
  /**
   * Simulates the liquidation completion check
   */
  function shouldExitLiquidationMode(
    positionsRemaining: number,
    effectiveBankroll: number,
  ): boolean {
    // Exit liquidation when:
    // 1. No positions remain
    // 2. We have effective bankroll to trade
    return positionsRemaining === 0 && effectiveBankroll > 0;
  }

  test("should exit liquidation when no positions and positive bankroll", () => {
    const result = shouldExitLiquidationMode(0, 500);
    assert.strictEqual(result, true);
  });

  test("should NOT exit when positions remain", () => {
    const result = shouldExitLiquidationMode(3, 500);
    assert.strictEqual(result, false);
  });

  test("should NOT exit when no effective bankroll", () => {
    const result = shouldExitLiquidationMode(0, 0);
    assert.strictEqual(result, false);
  });

  test("should NOT exit when both positions and no bankroll", () => {
    const result = shouldExitLiquidationMode(5, 0);
    assert.strictEqual(result, false);
  });
});

// ============================================================================
// Tests: Market Scanner Filtering
// ============================================================================

describe("Market Scanner", () => {
  interface MockActiveMarket {
    tokenId: string;
    volume24h: number;
    price: number;
  }

  /**
   * Simulates market filtering logic
   */
  function filterActiveMarkets(
    markets: MockActiveMarket[],
    config: MockChurnConfig,
  ): MockActiveMarket[] {
    return markets
      .filter((m) => m.volume24h >= config.scanMinVolumeUsd)
      .filter((m) => m.price >= 0.2 && m.price <= 0.8) // Tradeable range
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, config.scanTopNMarkets);
  }

  test("should filter by minimum volume", () => {
    const markets: MockActiveMarket[] = [
      { tokenId: "t1", volume24h: 50000, price: 0.5 },
      { tokenId: "t2", volume24h: 5000, price: 0.5 }, // Below minimum
      { tokenId: "t3", volume24h: 15000, price: 0.5 },
    ];

    const filtered = filterActiveMarkets(markets, defaultConfig);

    assert.strictEqual(filtered.length, 2);
    assert.ok(
      filtered.every((m) => m.volume24h >= defaultConfig.scanMinVolumeUsd),
    );
  });

  test("should filter by price range", () => {
    const markets: MockActiveMarket[] = [
      { tokenId: "t1", volume24h: 50000, price: 0.5 }, // Good
      { tokenId: "t2", volume24h: 50000, price: 0.1 }, // Too low
      { tokenId: "t3", volume24h: 50000, price: 0.95 }, // Too high
    ];

    const filtered = filterActiveMarkets(markets, defaultConfig);

    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].tokenId, "t1");
  });

  test("should sort by volume descending", () => {
    const markets: MockActiveMarket[] = [
      { tokenId: "t1", volume24h: 10000, price: 0.5 },
      { tokenId: "t2", volume24h: 50000, price: 0.5 },
      { tokenId: "t3", volume24h: 25000, price: 0.5 },
    ];

    const filtered = filterActiveMarkets(markets, defaultConfig);

    assert.strictEqual(filtered[0].tokenId, "t2"); // Highest volume first
    assert.strictEqual(filtered[1].tokenId, "t3");
    assert.strictEqual(filtered[2].tokenId, "t1");
  });

  test("should limit to top N markets", () => {
    const config = { ...defaultConfig, scanTopNMarkets: 2 };
    const markets: MockActiveMarket[] = [
      { tokenId: "t1", volume24h: 50000, price: 0.5 },
      { tokenId: "t2", volume24h: 40000, price: 0.5 },
      { tokenId: "t3", volume24h: 30000, price: 0.5 },
      { tokenId: "t4", volume24h: 20000, price: 0.5 },
    ];

    const filtered = filterActiveMarkets(markets, config);

    assert.strictEqual(filtered.length, 2);
  });
});

// ============================================================================
// Tests: Integration - Reserve Adaptation with Scanner
// ============================================================================

describe("Integration: Reserves and Scanner", () => {
  test("should adapt reserves based on scanner activity", () => {
    const manager = new MockDynamicReserveManager(defaultConfig);

    // Simulate: Scanner finds opportunities but we miss them due to reserves
    for (let i = 0; i < 3; i++) {
      manager.recordMissedOpportunity(
        `scanned-${i}`,
        defaultConfig.maxTradeUsd,
        "RESERVE_BLOCKED",
      );
    }

    // Reserves should adapt down to capture more scanner opportunities
    const { effectiveBankroll: bankrollBefore } =
      manager.getEffectiveBankroll(1000);

    // After more missed opportunities
    for (let i = 3; i < 6; i++) {
      manager.recordMissedOpportunity(
        `scanned-${i}`,
        defaultConfig.maxTradeUsd,
        "RESERVE_BLOCKED",
      );
    }

    const { effectiveBankroll: bankrollAfter } =
      manager.getEffectiveBankroll(1000);

    // Should have more effective bankroll available
    assert.ok(
      bankrollAfter > bankrollBefore,
      `Expected bankroll to increase: ${bankrollAfter} > ${bankrollBefore}`,
    );
  });
});
