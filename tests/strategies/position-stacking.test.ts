import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { loadStrategyConfig } from "../../src/config/loadConfig";
import {
  PositionStackingStrategy,
  DEFAULT_POSITION_STACKING_CONFIG,
} from "../../src/strategies/position-stacking";

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

test("PositionStackingStrategy respects RISK_OFF mode", async () => {
  const strategy = new PositionStackingStrategy({
    client: mockClient,
    logger: mockLogger as unknown as import("../../src/utils/logger.util").ConsoleLogger,
    config: DEFAULT_POSITION_STACKING_CONFIG,
  });

  // Create a mock reserve plan in RISK_OFF mode
  const riskyReservePlan = {
    mode: "RISK_OFF" as const,
    reserveRequired: 100,
    baseReserve: 50,
    positionReserve: 50,
    availableCash: 50,
    shortfall: 50,
    topPositionReserves: [],
    equityUsd: 100,
    computedAtMs: Date.now(),
  };

  const result = await strategy.execute(undefined, riskyReservePlan);
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
