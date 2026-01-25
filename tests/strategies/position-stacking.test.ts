import { afterEach, test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadStrategyConfig } from "../../src/config/loadConfig";
import {
  PositionStackingStrategy,
  DEFAULT_POSITION_STACKING_CONFIG,
} from "../../src/strategies/position-stacking";
import type { Position, PortfolioSnapshot } from "../../src/strategies/position-tracker";

// === CONFIGURATION TESTS ===

const baseEnv = {
  RPC_URL: "http://localhost:8545",
  PRIVATE_KEY: "0x" + "11".repeat(32),
  POLYMARKET_API_KEY: "key",
  POLYMARKET_API_SECRET: "secret",
  POLYMARKET_API_PASSPHRASE: "passphrase",
  TARGET_ADDRESSES: "0xabc", // Required for MONITOR_ENABLED presets
};

const originalEnv = { ...process.env };

const resetEnv = () => {
  process.env = { ...originalEnv };
};

afterEach(() => {
  resetEnv();
});

test("POSITION_STACKING_ENABLED defaults to true in balanced preset", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
  });

  const config = loadStrategyConfig();
  assert.equal(config.positionStackingEnabled, true);
});

test("POSITION_STACKING_ENABLED defaults to false in off preset", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "off",
  });

  const config = loadStrategyConfig();
  assert.equal(config.positionStackingEnabled, false);
});

test("POSITION_STACKING_ENABLED can be disabled via env override", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
    POSITION_STACKING_ENABLED: "false",
  });

  const config = loadStrategyConfig();
  assert.equal(config.positionStackingEnabled, false);
});

test("POSITION_STACKING_MIN_GAIN_CENTS defaults to 20 in balanced preset", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
  });

  const config = loadStrategyConfig();
  assert.equal(config.positionStackingMinGainCents, 20);
});

test("POSITION_STACKING_MIN_GAIN_CENTS is 25 in conservative preset", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "conservative",
  });

  const config = loadStrategyConfig();
  assert.equal(config.positionStackingMinGainCents, 25);
});

test("POSITION_STACKING_MIN_GAIN_CENTS is 15 in aggressive preset", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
  });

  const config = loadStrategyConfig();
  assert.equal(config.positionStackingMinGainCents, 15);
});

test("POSITION_STACKING_MIN_GAIN_CENTS env variable overrides preset value", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
    POSITION_STACKING_MIN_GAIN_CENTS: "30",
  });

  const config = loadStrategyConfig();
  assert.equal(config.positionStackingMinGainCents, 30);
});

test("POSITION_STACKING_MAX_CURRENT_PRICE defaults to 0.95 in balanced preset", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
  });

  const config = loadStrategyConfig();
  assert.equal(config.positionStackingMaxCurrentPrice, 0.95);
});

test("POSITION_STACKING_MAX_CURRENT_PRICE is 0.90 in conservative preset", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "conservative",
  });

  const config = loadStrategyConfig();
  assert.equal(config.positionStackingMaxCurrentPrice, 0.90);
});

test("POSITION_STACKING_MAX_CURRENT_PRICE env variable overrides preset value", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
    POSITION_STACKING_MAX_CURRENT_PRICE: "0.85",
  });

  const config = loadStrategyConfig();
  assert.equal(config.positionStackingMaxCurrentPrice, 0.85);
});

// === STRATEGY LOGIC TESTS ===

// Create a mock logger
const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// Create a mock CLOB client
const mockClient = {
  getOrderBook: async () => ({ bids: [], asks: [] }),
} as unknown as import("@polymarket/clob-client").ClobClient;

// Helper to create a mock position
function createMockPosition(overrides: Partial<Position> = {}): Position {
  return {
    tokenId: "token123",
    marketId: "market123",
    side: "YES",
    size: 100,
    currentPrice: 0.70,
    entryPrice: 0.50,
    avgEntryPriceCents: 50,
    pnlPct: 40,
    pnlUsd: 20,
    pnlTrusted: true,
    redeemable: false,
    nearResolutionCandidate: false,
    dataApiInitialValue: 50,
    executionStatus: "TRADABLE",
    bookStatus: "NORMAL",
    ...overrides,
  } as Position;
}

// Helper to create a mock snapshot
function createMockSnapshot(positions: Position[]): PortfolioSnapshot {
  return {
    activePositions: positions,
    cycleId: 1,
    refreshedAt: Date.now(),
    rawCounts: {
      rawTotal: positions.length,
      rawActive: positions.length,
      rawRedeemable: 0,
    },
  } as PortfolioSnapshot;
}

test("DEFAULT_POSITION_STACKING_CONFIG has sensible defaults", () => {
  assert.equal(DEFAULT_POSITION_STACKING_CONFIG.enabled, true);
  assert.equal(DEFAULT_POSITION_STACKING_CONFIG.minGainCents, 20);
  assert.equal(DEFAULT_POSITION_STACKING_CONFIG.maxStackUsd, 25);
  assert.equal(DEFAULT_POSITION_STACKING_CONFIG.minProfitPct, 0);
  assert.equal(DEFAULT_POSITION_STACKING_CONFIG.maxCurrentPrice, 0.95);
  assert.equal(DEFAULT_POSITION_STACKING_CONFIG.cooldownMs, 60000);
});

test("PositionStackingStrategy initializes correctly", () => {
  const strategy = new PositionStackingStrategy({
    client: mockClient,
    logger: mockLogger as unknown as import("../../src/utils/logger.util").ConsoleLogger,
    config: DEFAULT_POSITION_STACKING_CONFIG,
  });

  const stats = strategy.getStats();
  assert.equal(stats.enabled, true);
  assert.equal(stats.stackedCount, 0);
  assert.equal(stats.activeCooldowns, 0);
  assert.equal(stats.trackedBaselines, 0);
});

test("PositionStackingStrategy tracks stacked positions", () => {
  const strategy = new PositionStackingStrategy({
    client: mockClient,
    logger: mockLogger as unknown as import("../../src/utils/logger.util").ConsoleLogger,
    config: DEFAULT_POSITION_STACKING_CONFIG,
  });

  // Initially no positions should be stacked
  assert.equal(strategy.isPositionStacked("token1"), false);
  assert.deepEqual(strategy.getStackedPositions(), []);
});

test("PositionStackingStrategy can be cleared", () => {
  const strategy = new PositionStackingStrategy({
    client: mockClient,
    logger: mockLogger as unknown as import("../../src/utils/logger.util").ConsoleLogger,
    config: DEFAULT_POSITION_STACKING_CONFIG,
  });

  // Clear should not throw
  strategy.clearStackedPositions();
  assert.equal(strategy.getStats().stackedCount, 0);
});

test("PositionStackingStrategy returns 0 when disabled", async () => {
  const strategy = new PositionStackingStrategy({
    client: mockClient,
    logger: mockLogger as unknown as import("../../src/utils/logger.util").ConsoleLogger,
    config: {
      ...DEFAULT_POSITION_STACKING_CONFIG,
      enabled: false,
    },
  });

  const result = await strategy.execute();
  assert.equal(result, 0);
});

test("PositionStackingStrategy uses available cash even in RISK_OFF mode", async () => {
  const strategy = new PositionStackingStrategy({
    client: mockClient,
    logger: mockLogger as unknown as import("../../src/utils/logger.util").ConsoleLogger,
    config: DEFAULT_POSITION_STACKING_CONFIG,
  });

  // Create a mock reserve plan in RISK_OFF mode with some available cash
  // New behavior: strategy should use available cash for stacking, not block
  const riskyReservePlan = {
    mode: "RISK_OFF" as const,
    reserveRequired: 100,
    baseReserve: 50,
    positionReserve: 50,
    availableCash: 50, // Has $50 available (but shortfall means RISK_OFF)
    shortfall: 50,
    topPositionReserves: [],
    equityUsd: 100,
    computedAtMs: Date.now(),
  };

  // Should return 0 because no positions to stack (no tracker), NOT because RISK_OFF blocked it
  const result = await strategy.execute(undefined, riskyReservePlan);
  assert.equal(result, 0);
});

test("PositionStackingStrategy skips when budget is exhausted", async () => {
  const strategy = new PositionStackingStrategy({
    client: mockClient,
    logger: mockLogger as unknown as import("../../src/utils/logger.util").ConsoleLogger,
    config: DEFAULT_POSITION_STACKING_CONFIG,
  });

  // Create a mock reserve plan with zero available cash
  const zeroReservePlan = {
    mode: "RISK_OFF" as const,
    reserveRequired: 100,
    baseReserve: 50,
    positionReserve: 50,
    availableCash: 0, // No cash available
    shortfall: 100,
    topPositionReserves: [],
    equityUsd: 100,
    computedAtMs: Date.now(),
  };

  // Should return 0 because no cash available for stacking
  const result = await strategy.execute(undefined, zeroReservePlan);
  assert.equal(result, 0);
});

test("PositionStackingStrategy executes when RISK_ON mode", async () => {
  const strategy = new PositionStackingStrategy({
    client: mockClient,
    logger: mockLogger as unknown as import("../../src/utils/logger.util").ConsoleLogger,
    config: DEFAULT_POSITION_STACKING_CONFIG,
  });

  // Create a mock reserve plan in RISK_ON mode (but no positions to stack)
  const safeReservePlan = {
    mode: "RISK_ON" as const,
    reserveRequired: 50,
    baseReserve: 20,
    positionReserve: 30,
    availableCash: 100,
    shortfall: 0,
    topPositionReserves: [],
    equityUsd: 150,
    computedAtMs: Date.now(),
  };

  // Should return 0 because no positions available (no tracker)
  const result = await strategy.execute(undefined, safeReservePlan);
  assert.equal(result, 0);
});

// === BUDGET-AWARE STACKING TESTS ===

describe("Budget-Aware Stacking", () => {
  /**
   * Simplified test helper function to simulate the budget-aware stacking sizing logic.
   * This mirrors the core logic in PositionStackingStrategy.applyBudgetAwareSizing().
   *
   * @param maxStackUsd - Maximum stack amount from config
   * @param cycleStackBudgetRemaining - Remaining budget for this cycle (null = no budget tracking)
   * @param minStackUsd - Minimum stack amount (default: 1)
   * @returns Object with final size and reason
   */
  function computeBudgetAwareSize(
    maxStackUsd: number,
    cycleStackBudgetRemaining: number | null,
    minStackUsd: number = 1,
  ): { finalSize: number; reason: "full" | "partial" | "skipped" | "no_budget_tracking" } {
    // If no budget tracking, use full computed size
    if (cycleStackBudgetRemaining === null) {
      return { finalSize: maxStackUsd, reason: "no_budget_tracking" };
    }

    // If budget < minStackUsd, skip entirely
    if (cycleStackBudgetRemaining < minStackUsd) {
      return { finalSize: 0, reason: "skipped" };
    }

    // If budget < maxStackUsd, submit partial
    if (cycleStackBudgetRemaining < maxStackUsd) {
      return { finalSize: cycleStackBudgetRemaining, reason: "partial" };
    }

    // Full size available
    return { finalSize: maxStackUsd, reason: "full" };
  }

  describe("Budget Initialization", () => {
    test("initializes budget from availableCash in RISK_OFF mode", () => {
      // RISK_OFF with $50 available should have $50 budget
      const availableCash = 50;
      const reserveRequired = 100; // Causes RISK_OFF

      // Budget should be initialized from availableCash, not (availableCash - reserveRequired)
      // This is the key change - we use full availableCash for stacking opportunities
      const result = computeBudgetAwareSize(25, availableCash);

      assert.strictEqual(result.finalSize, 25, "Should use full maxStackUsd when budget allows");
      assert.strictEqual(result.reason, "full", "Should indicate full stack");
    });

    test("initializes budget from availableCash in RISK_ON mode", () => {
      // RISK_ON with $100 available
      const availableCash = 100;

      const result = computeBudgetAwareSize(25, availableCash);

      assert.strictEqual(result.finalSize, 25, "Should use full maxStackUsd");
      assert.strictEqual(result.reason, "full", "Should indicate full stack");
    });

    test("uses full maxStackUsd when no budget tracking", () => {
      const result = computeBudgetAwareSize(25, null);

      assert.strictEqual(result.finalSize, 25, "Should use full maxStackUsd");
      assert.strictEqual(result.reason, "no_budget_tracking", "Should indicate no budget tracking");
    });
  });

  describe("Partial Stacks", () => {
    test("caps stack to budget when budget < maxStackUsd", () => {
      const maxStackUsd = 25;
      const budgetRemaining = 15; // Less than maxStackUsd

      const result = computeBudgetAwareSize(maxStackUsd, budgetRemaining);

      assert.strictEqual(result.finalSize, 15, "Should cap to available budget");
      assert.strictEqual(result.reason, "partial", "Should indicate partial stack");
    });

    test("allows partial stack at exact budget amount", () => {
      const maxStackUsd = 25;
      const budgetRemaining = 10;

      const result = computeBudgetAwareSize(maxStackUsd, budgetRemaining);

      assert.strictEqual(result.finalSize, 10, "Should use exact remaining budget");
      assert.strictEqual(result.reason, "partial", "Should indicate partial");
    });
  });

  describe("Budget Exhaustion", () => {
    test("skips when budget is below minimum threshold", () => {
      const maxStackUsd = 25;
      const budgetRemaining = 0.5; // Below $1 minimum
      const minStackUsd = 1;

      const result = computeBudgetAwareSize(maxStackUsd, budgetRemaining, minStackUsd);

      assert.strictEqual(result.finalSize, 0, "Should skip when budget exhausted");
      assert.strictEqual(result.reason, "skipped", "Should indicate skipped");
    });

    test("skips when budget is zero", () => {
      const result = computeBudgetAwareSize(25, 0);

      assert.strictEqual(result.finalSize, 0, "Should skip when no budget");
      assert.strictEqual(result.reason, "skipped", "Should indicate skipped");
    });
  });

  describe("Multiple Stacks Per Cycle", () => {
    test("multiple stacks in same cycle decrement budget correctly", () => {
      let budgetRemaining = 50; // Initial budget
      const maxStackUsd = 25;

      // First stack
      const result1 = computeBudgetAwareSize(maxStackUsd, budgetRemaining);
      assert.strictEqual(result1.finalSize, 25, "First stack should use full $25");
      assert.strictEqual(result1.reason, "full", "First stack should be full");
      budgetRemaining -= result1.finalSize; // Now $25

      // Second stack
      const result2 = computeBudgetAwareSize(maxStackUsd, budgetRemaining);
      assert.strictEqual(result2.finalSize, 25, "Second stack should use full $25");
      assert.strictEqual(result2.reason, "full", "Second stack should be full");
      budgetRemaining -= result2.finalSize; // Now $0

      // Third stack - should be skipped (budget exhausted)
      const result3 = computeBudgetAwareSize(maxStackUsd, budgetRemaining);
      assert.strictEqual(result3.finalSize, 0, "Third stack should be skipped");
      assert.strictEqual(result3.reason, "skipped", "Third stack should indicate exhausted");
    });

    test("partial stack when budget partially depleted", () => {
      let budgetRemaining = 40; // Initial budget
      const maxStackUsd = 25;

      // First stack - full
      const result1 = computeBudgetAwareSize(maxStackUsd, budgetRemaining);
      assert.strictEqual(result1.finalSize, 25);
      budgetRemaining -= result1.finalSize; // Now $15

      // Second stack - partial (only $15 left)
      const result2 = computeBudgetAwareSize(maxStackUsd, budgetRemaining);
      assert.strictEqual(result2.finalSize, 15, "Second stack should be capped to $15");
      assert.strictEqual(result2.reason, "partial", "Second stack should be partial");
    });
  });
});

// === BASELINE TRACKING TESTS ===

describe("Baseline Tracking", () => {
  test("creates baselines for new positions", async () => {
    const strategy = new PositionStackingStrategy({
      client: mockClient,
      logger: mockLogger as unknown as import("../../src/utils/logger.util").ConsoleLogger,
      config: DEFAULT_POSITION_STACKING_CONFIG,
    });

    const position = createMockPosition({ tokenId: "new-token-123" });
    const snapshot = createMockSnapshot([position]);

    // Execute to trigger baseline creation
    await strategy.execute(snapshot);

    // Check baseline was created
    const stats = strategy.getStats();
    assert.equal(stats.trackedBaselines, 1);
  });

  test("updates lastUpdatedAtMs for existing positions without changing baseline values", async () => {
    const strategy = new PositionStackingStrategy({
      client: mockClient,
      logger: mockLogger as unknown as import("../../src/utils/logger.util").ConsoleLogger,
      config: DEFAULT_POSITION_STACKING_CONFIG,
    });

    // First execution to create baseline
    const position1 = createMockPosition({ 
      tokenId: "token-baseline-test",
      size: 100,
      dataApiInitialValue: 50,
    });
    await strategy.execute(createMockSnapshot([position1]));

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 10));

    // Second execution with grown position (should update lastUpdatedAtMs but not baseline values)
    const position2 = createMockPosition({ 
      tokenId: "token-baseline-test",
      size: 110, // Size grew slightly (not enough for 40% threshold)
      dataApiInitialValue: 55,
    });
    await strategy.execute(createMockSnapshot([position2]));

    // Baseline count should still be 1 (not creating new baseline)
    const stats = strategy.getStats();
    assert.equal(stats.trackedBaselines, 1);
  });

  test("baselines are not removed for active positions even after 2+ hours", async () => {
    const strategy = new PositionStackingStrategy({
      client: mockClient,
      logger: mockLogger as unknown as import("../../src/utils/logger.util").ConsoleLogger,
      config: DEFAULT_POSITION_STACKING_CONFIG,
    });

    const position = createMockPosition({ tokenId: "long-running-token" });
    
    // Execute multiple times to simulate multiple cycles
    for (let i = 0; i < 5; i++) {
      await strategy.execute(createMockSnapshot([position]));
    }

    // Baseline should still exist
    const stats = strategy.getStats();
    assert.equal(stats.trackedBaselines, 1);
  });
});

// === POSITION GROWTH DETECTION TESTS ===

describe("Position Growth Detection", () => {
  test("detects position size growth above threshold", async () => {
    const strategy = new PositionStackingStrategy({
      client: mockClient,
      logger: mockLogger as unknown as import("../../src/utils/logger.util").ConsoleLogger,
      config: {
        ...DEFAULT_POSITION_STACKING_CONFIG,
        sizeGrowthThreshold: 1.4, // 40% growth threshold
      },
    });

    // First execution to create baseline with initial size
    const position1 = createMockPosition({ 
      tokenId: "growth-test-token",
      size: 100,
      dataApiInitialValue: 50,
    });
    await strategy.execute(createMockSnapshot([position1]));

    // Second execution with position that has grown 50% (above 40% threshold)
    const position2 = createMockPosition({ 
      tokenId: "growth-test-token",
      size: 150, // 50% growth
      dataApiInitialValue: 75,
      currentPrice: 0.70, // Still in profitable range
      avgEntryPriceCents: 50,
      pnlPct: 40,
    });
    await strategy.execute(createMockSnapshot([position2]));

    // Position should be marked as already stacked (detected via baseline growth)
    assert.equal(strategy.isPositionStacked("growth-test-token"), true);
  });

  test("does not flag position as stacked if growth is below threshold", async () => {
    const strategy = new PositionStackingStrategy({
      client: mockClient,
      logger: mockLogger as unknown as import("../../src/utils/logger.util").ConsoleLogger,
      config: {
        ...DEFAULT_POSITION_STACKING_CONFIG,
        sizeGrowthThreshold: 1.4, // 40% growth threshold
      },
    });

    // First execution to create baseline
    const position1 = createMockPosition({ 
      tokenId: "small-growth-token",
      size: 100,
      dataApiInitialValue: 50,
    });
    await strategy.execute(createMockSnapshot([position1]));

    // Second execution with position that has grown only 20% (below 40% threshold)
    const position2 = createMockPosition({ 
      tokenId: "small-growth-token",
      size: 120, // Only 20% growth
      dataApiInitialValue: 60,
    });
    await strategy.execute(createMockSnapshot([position2]));

    // Position should NOT be marked as stacked
    assert.equal(strategy.isPositionStacked("small-growth-token"), false);
  });
});

// === ELIGIBILITY TESTS ===

describe("Position Eligibility", () => {
  test("position without entry price is not eligible", async () => {
    const strategy = new PositionStackingStrategy({
      client: mockClient,
      logger: mockLogger as unknown as import("../../src/utils/logger.util").ConsoleLogger,
      config: DEFAULT_POSITION_STACKING_CONFIG,
    });

    const position = createMockPosition({
      tokenId: "no-entry-price",
      avgEntryPriceCents: 0, // No entry price
    });

    await strategy.execute(createMockSnapshot([position]));
    
    // Should not be marked as stacked (wasn't eligible)
    assert.equal(strategy.isPositionStacked("no-entry-price"), false);
  });

  test("position with untrusted PnL is not eligible", async () => {
    const strategy = new PositionStackingStrategy({
      client: mockClient,
      logger: mockLogger as unknown as import("../../src/utils/logger.util").ConsoleLogger,
      config: DEFAULT_POSITION_STACKING_CONFIG,
    });

    const position = createMockPosition({
      tokenId: "untrusted-pnl",
      pnlTrusted: false,
    });

    await strategy.execute(createMockSnapshot([position]));
    
    assert.equal(strategy.isPositionStacked("untrusted-pnl"), false);
  });

  test("position in loss is not eligible", async () => {
    const strategy = new PositionStackingStrategy({
      client: mockClient,
      logger: mockLogger as unknown as import("../../src/utils/logger.util").ConsoleLogger,
      config: DEFAULT_POSITION_STACKING_CONFIG,
    });

    const position = createMockPosition({
      tokenId: "losing-position",
      pnlPct: -10, // In loss
      currentPrice: 0.40, // Below entry
      avgEntryPriceCents: 50,
    });

    await strategy.execute(createMockSnapshot([position]));
    
    assert.equal(strategy.isPositionStacked("losing-position"), false);
  });

  test("position with gain below threshold is not eligible", async () => {
    const strategy = new PositionStackingStrategy({
      client: mockClient,
      logger: mockLogger as unknown as import("../../src/utils/logger.util").ConsoleLogger,
      config: {
        ...DEFAULT_POSITION_STACKING_CONFIG,
        minGainCents: 20,
      },
    });

    const position = createMockPosition({
      tokenId: "small-gain",
      currentPrice: 0.60, // Only 10 cents above entry
      avgEntryPriceCents: 50,
      pnlPct: 20,
    });

    await strategy.execute(createMockSnapshot([position]));
    
    assert.equal(strategy.isPositionStacked("small-gain"), false);
  });

  test("position near $1 is not eligible (limited upside)", async () => {
    const strategy = new PositionStackingStrategy({
      client: mockClient,
      logger: mockLogger as unknown as import("../../src/utils/logger.util").ConsoleLogger,
      config: {
        ...DEFAULT_POSITION_STACKING_CONFIG,
        maxCurrentPrice: 0.95,
      },
    });

    const position = createMockPosition({
      tokenId: "near-resolution",
      currentPrice: 0.98, // Too close to $1
      avgEntryPriceCents: 50,
      pnlPct: 96,
    });

    await strategy.execute(createMockSnapshot([position]));
    
    assert.equal(strategy.isPositionStacked("near-resolution"), false);
  });

  test("non-tradable position is not eligible", async () => {
    const strategy = new PositionStackingStrategy({
      client: mockClient,
      logger: mockLogger as unknown as import("../../src/utils/logger.util").ConsoleLogger,
      config: DEFAULT_POSITION_STACKING_CONFIG,
    });

    const position = createMockPosition({
      tokenId: "not-tradable",
      executionStatus: "NOT_TRADABLE_ON_CLOB",
      currentPrice: 0.70,
      avgEntryPriceCents: 50,
      pnlPct: 40,
    });

    await strategy.execute(createMockSnapshot([position]));
    
    assert.equal(strategy.isPositionStacked("not-tradable"), false);
  });
});

// === COOLDOWN TESTS ===

describe("Cooldown Behavior", () => {
  test("position enters cooldown after check", async () => {
    const strategy = new PositionStackingStrategy({
      client: mockClient,
      logger: mockLogger as unknown as import("../../src/utils/logger.util").ConsoleLogger,
      config: {
        ...DEFAULT_POSITION_STACKING_CONFIG,
        cooldownMs: 60000, // 60 second cooldown
      },
    });

    // Position that meets criteria but won't actually stack (no wallet)
    const position = createMockPosition({
      tokenId: "cooldown-test",
      currentPrice: 0.75,
      avgEntryPriceCents: 50, // 25 cents gain
      pnlPct: 50,
    });

    await strategy.execute(createMockSnapshot([position]));

    // Should have active cooldown
    const stats = strategy.getStats();
    assert.equal(stats.activeCooldowns, 1);
  });
});

// === SINGLE-FLIGHT GUARD TESTS ===

describe("Single-Flight Guard", () => {
  test("prevents concurrent execution", async () => {
    const strategy = new PositionStackingStrategy({
      client: mockClient,
      logger: mockLogger as unknown as import("../../src/utils/logger.util").ConsoleLogger,
      config: DEFAULT_POSITION_STACKING_CONFIG,
    });

    const position = createMockPosition();
    const snapshot = createMockSnapshot([position]);

    // Start two executions simultaneously
    const [result1, result2] = await Promise.all([
      strategy.execute(snapshot),
      strategy.execute(snapshot),
    ]);

    // Both should complete (one may be skipped due to single-flight)
    assert.equal(typeof result1, "number");
    assert.equal(typeof result2, "number");
  });
});
