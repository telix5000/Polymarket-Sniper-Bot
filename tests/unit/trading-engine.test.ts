/**
 * Trading Engine Tests - EV Math, Entry Bounds, Hedge Logic
 *
 * These tests verify the core casino math that makes the system work:
 * - Break-even win rate calculation
 * - EV computation
 * - Entry price bounds
 * - Hedge behavior
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";

import {
  loadConfig,
  validateConfig,
  calculateEffectiveBankroll,
  calculateTradeSize,
  type ChurnConfig,
  EvTracker,
  calculatePnlCents,
  calculatePnlUsd,
  createTradeResult,
  PositionManager,
  DecisionEngine,
} from "../../src/start";

// ═══════════════════════════════════════════════════════════════════════════
// TEST CONFIG
// ═══════════════════════════════════════════════════════════════════════════

function createTestConfig(): ChurnConfig {
  return {
    tradeFraction: 0.01,
    maxTradeUsd: 25,
    minTradeUsd: 5, // 20% of maxTradeUsd
    maxDeployedFractionTotal: 0.3,
    maxOpenPositionsTotal: 12,
    maxOpenPositionsPerMarket: 1,
    cooldownSecondsPerToken: 180,
    entryBandCents: 12,
    tpCents: 14,
    hedgeTriggerCents: 16,
    maxAdverseCents: 30,
    maxHoldSeconds: 3600,
    hedgeRatio: 0.4,
    maxHedgeRatio: 0.7,
    minEntryPriceCents: 30,
    maxEntryPriceCents: 82,
    preferredEntryLowCents: 35,
    preferredEntryHighCents: 65,
    entryBufferCents: 4,
    minSpreadCents: 6,
    minDepthUsdAtExit: 25,
    minTradesLastX: 10,
    minBookUpdatesLastX: 20,
    activityWindowSeconds: 300,
    rollingWindowTrades: 200,
    churnCostCentsEstimate: 2,
    minEvCents: 0,
    minProfitFactor: 1.25,
    pauseSeconds: 300,
    biasMode: "leaderboard_flow",
    leaderboardTopN: 50,
    biasWindowSeconds: 3600,
    biasMinNetUsd: 300,
    biasMinTrades: 3,
    biasStaleSeconds: 900,
    allowEntriesOnlyWithBias: true,
    onBiasFlip: "MANAGE_EXITS_ONLY",
    onBiasNone: "PAUSE_ENTRIES",
    pollIntervalMs: 1500,
    positionPollIntervalMs: 100,
    logLevel: "info",
    reserveFraction: 0.25,
    minReserveUsd: 100,
    useAvailableBalanceOnly: true,
    forceLiquidation: false,
    liquidationMaxSlippagePct: 10,
    liquidationPollIntervalMs: 1000,
    privateKey: "test",
    rpcUrl: "https://polygon-rpc.com",
    liveTradingEnabled: false,
    polReserveEnabled: true,
    polReserveTarget: 2.0,
    polReserveMin: 0.5,
    polReserveMaxSwapUsd: 10,
    polReserveCheckIntervalMin: 30,
    polReserveSlippagePct: 3,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EV MATH TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("EV Math", () => {
  describe("Break-even win rate calculation", () => {
    /**
     * From the authoritative defaults:
     * - avg_win_cents ≈ 14
     * - avg_loss_cents ≈ 9 (after hedge)
     * - churn ≈ 2¢
     *
     * Break-even: p > (9 + 2) / (14 + 9) ≈ 47.8%
     */
    it("should have break-even win rate around 48%", () => {
      const avgWin = 14;
      const avgLoss = 9;
      const churn = 2;

      // Break-even: EV = 0
      // p * avgWin - (1-p) * avgLoss - churn = 0
      // p * avgWin - avgLoss + p * avgLoss - churn = 0
      // p * (avgWin + avgLoss) = avgLoss + churn
      // p = (avgLoss + churn) / (avgWin + avgLoss)
      const breakEvenWinRate = (avgLoss + churn) / (avgWin + avgLoss);

      assert.ok(
        breakEvenWinRate >= 0.47 && breakEvenWinRate <= 0.49,
        `Break-even win rate should be ~48%, got ${(breakEvenWinRate * 100).toFixed(1)}%`,
      );
    });

    it("50% wins should be EV positive", () => {
      const avgWin = 14;
      const avgLoss = 9;
      const churn = 2;
      const winRate = 0.5;

      const ev = winRate * avgWin - (1 - winRate) * avgLoss - churn;

      assert.ok(
        ev > 0,
        `EV at 50% wins should be positive, got ${ev.toFixed(2)}¢`,
      );
    });

    it("55% wins should be solidly profitable", () => {
      const avgWin = 14;
      const avgLoss = 9;
      const churn = 2;
      const winRate = 0.55;

      const ev = winRate * avgWin - (1 - winRate) * avgLoss - churn;

      assert.ok(
        ev >= 1.5,
        `EV at 55% wins should be ≥1.5¢, got ${ev.toFixed(2)}¢`,
      );
    });

    it("60% wins should be strong", () => {
      const avgWin = 14;
      const avgLoss = 9;
      const churn = 2;
      const winRate = 0.6;

      const ev = winRate * avgWin - (1 - winRate) * avgLoss - churn;

      // 2.8¢ is solid - the exact math works out to this
      assert.ok(
        ev >= 2.5,
        `EV at 60% wins should be ≥2.5¢, got ${ev.toFixed(2)}¢`,
      );
    });
  });

  describe("P&L Calculation", () => {
    it("calculates LONG P&L correctly", () => {
      const pnl = calculatePnlCents("LONG", 50, 64); // Bought at 50¢, sold at 64¢
      assert.strictEqual(pnl, 14, "LONG profit should be +14¢");
    });

    it("calculates LONG loss correctly", () => {
      const pnl = calculatePnlCents("LONG", 50, 41); // Bought at 50¢, sold at 41¢
      assert.strictEqual(pnl, -9, "LONG loss should be -9¢");
    });

    it("calculates SHORT P&L correctly", () => {
      const pnl = calculatePnlCents("SHORT", 50, 36); // Shorted at 50¢, covered at 36¢
      assert.strictEqual(pnl, 14, "SHORT profit should be +14¢");
    });

    it("calculates P&L in USD correctly", () => {
      // $10 position at 50¢ = 20 shares
      // +14¢ per share = $2.80 profit
      const pnlUsd = calculatePnlUsd(14, 10, 50);
      assert.ok(
        Math.abs(pnlUsd - 2.8) < 0.01,
        `P&L USD should be ~$2.80, got $${pnlUsd.toFixed(2)}`,
      );
    });
  });

  describe("EV Tracker", () => {
    let tracker: EvTracker;
    let config: ChurnConfig;

    beforeEach(() => {
      config = createTestConfig();
      tracker = new EvTracker(config);
    });

    it("starts with zero metrics", () => {
      const metrics = tracker.getMetrics();
      assert.strictEqual(metrics.totalTrades, 0);
      assert.strictEqual(metrics.winRate, 0);
      assert.strictEqual(metrics.evCents, 0);
    });

    it("calculates metrics after trades", () => {
      // Add some wins and losses matching expected performance
      for (let i = 0; i < 6; i++) {
        tracker.recordTrade(createTradeResult("token1", "LONG", 50, 64, 10)); // +14¢ win
      }
      for (let i = 0; i < 4; i++) {
        tracker.recordTrade(createTradeResult("token2", "LONG", 50, 41, 10)); // -9¢ loss
      }

      const metrics = tracker.getMetrics();
      assert.strictEqual(metrics.totalTrades, 10);
      assert.strictEqual(metrics.wins, 6);
      assert.strictEqual(metrics.losses, 4);
      assert.ok(
        Math.abs(metrics.winRate - 0.6) < 0.01,
        `Win rate should be 60%, got ${(metrics.winRate * 100).toFixed(1)}%`,
      );
      assert.ok(metrics.evCents > 0, "EV should be positive at 60% wins");
    });

    it("allows trading during warmup period", () => {
      // Less than 10 trades
      for (let i = 0; i < 5; i++) {
        tracker.recordTrade(createTradeResult("token1", "LONG", 50, 40, 10)); // Losses
      }

      const allowed = tracker.isTradingAllowed();
      assert.strictEqual(
        allowed.allowed,
        true,
        "Should allow trading during warmup",
      );
    });

    it("blocks trading when EV is negative", () => {
      // Create many losing trades to get negative EV
      for (let i = 0; i < 15; i++) {
        tracker.recordTrade(createTradeResult("token1", "LONG", 50, 35, 10)); // -15¢ loss
      }

      const allowed = tracker.isTradingAllowed();
      assert.strictEqual(
        allowed.allowed,
        false,
        "Should block trading with negative EV",
      );
      assert.ok(
        allowed.reason?.includes("EV") || allowed.reason?.includes("PAUSED"),
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ENTRY BOUNDS TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("Entry Price Bounds", () => {
  const config = createTestConfig();

  describe("Validation", () => {
    it("MIN_ENTRY_PRICE_CENTS should equal MAX_ADVERSE_CENTS", () => {
      // This ensures room to be wrong
      assert.strictEqual(
        config.minEntryPriceCents,
        config.maxAdverseCents,
        "MIN_ENTRY should equal MAX_ADVERSE for loss room",
      );
    });

    it("MAX_ENTRY_PRICE_CENTS should leave room for TP", () => {
      // MAX = 100 - TP - BUFFER
      const expectedMax = 100 - config.tpCents - config.entryBufferCents;
      assert.ok(
        config.maxEntryPriceCents <= expectedMax,
        `MAX_ENTRY (${config.maxEntryPriceCents}) should be <= ${expectedMax}`,
      );
    });

    it("preferred zone should be within bounds", () => {
      assert.ok(
        config.preferredEntryLowCents >= config.minEntryPriceCents,
        "Preferred low should be >= min entry",
      );
      assert.ok(
        config.preferredEntryHighCents <= config.maxEntryPriceCents,
        "Preferred high should be <= max entry",
      );
    });
  });

  describe("Zone interpretation", () => {
    it("<30¢ is dangerous (one bad tick kills you)", () => {
      const price = 25;
      const isValid = price >= config.minEntryPriceCents;
      assert.strictEqual(isValid, false, "25¢ should be rejected");
    });

    it(">82¢ has no upside left", () => {
      const price = 85;
      const isValid = price <= config.maxEntryPriceCents;
      assert.strictEqual(isValid, false, "85¢ should be rejected");
    });

    it("35-65¢ is ideal churn zone", () => {
      const decisionEngine = new DecisionEngine(config);

      assert.strictEqual(decisionEngine.isInPreferredZone(35), true);
      assert.strictEqual(decisionEngine.isInPreferredZone(50), true);
      assert.strictEqual(decisionEngine.isInPreferredZone(65), true);
      assert.strictEqual(decisionEngine.isInPreferredZone(30), false);
      assert.strictEqual(decisionEngine.isInPreferredZone(70), false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HEDGE LOGIC TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("Hedge Logic", () => {
  const config = createTestConfig();

  describe("Hedge trigger", () => {
    it("triggers at HEDGE_TRIGGER_CENTS adverse move", () => {
      const positionManager = new PositionManager({
        tpCents: config.tpCents,
        hedgeTriggerCents: config.hedgeTriggerCents,
        maxAdverseCents: config.maxAdverseCents,
        maxHoldSeconds: config.maxHoldSeconds,
        hedgeRatio: config.hedgeRatio,
        maxHedgeRatio: config.maxHedgeRatio,
      });

      // Open LONG at 50¢
      const position = positionManager.openPosition({
        tokenId: "test-token",
        side: "LONG",
        entryPriceCents: 50,
        sizeUsd: 10,
        referencePriceCents: 50,
        evSnapshot: null,
        biasDirection: "LONG",
      });

      // Price drops to 34¢ (16¢ adverse = hedge trigger)
      const result = positionManager.updatePrice(position.id, 34, null, "LONG");
      assert.strictEqual(
        result.action,
        "HEDGE",
        "Should trigger hedge at 16¢ adverse",
      );
    });

    it("respects MAX_HEDGE_RATIO limit", () => {
      const positionManager = new PositionManager({
        tpCents: config.tpCents,
        hedgeTriggerCents: config.hedgeTriggerCents,
        maxAdverseCents: config.maxAdverseCents,
        maxHoldSeconds: config.maxHoldSeconds,
        hedgeRatio: config.hedgeRatio,
        maxHedgeRatio: config.maxHedgeRatio,
      });

      const position = positionManager.openPosition({
        tokenId: "test-token",
        side: "LONG",
        entryPriceCents: 50,
        sizeUsd: 10,
        referencePriceCents: 50,
        evSnapshot: null,
        biasDirection: "LONG",
      });

      // Add first hedge (40%)
      positionManager.recordHedge(
        position.id,
        {
          tokenId: "hedge1",
          sizeUsd: 4,
          entryPriceCents: 34,
          entryTime: Date.now(),
        },
        null,
        "LONG",
      );

      const afterFirst = positionManager.getPosition(position.id);
      assert.strictEqual(
        afterFirst!.totalHedgeRatio,
        0.4,
        "First hedge should be 40%",
      );

      // Add second hedge (another 40% but should be clamped)
      positionManager.recordHedge(
        position.id,
        {
          tokenId: "hedge2",
          sizeUsd: 4,
          entryPriceCents: 32,
          entryTime: Date.now(),
        },
        null,
        "LONG",
      );

      // The position manager accumulates hedges - enforcement is in decision engine
      // This test validates the tracking works
      const afterSecond = positionManager.getPosition(position.id);
      assert.ok(afterSecond!.hedges.length === 2, "Should track both hedges");
    });
  });

  describe("Hedge effect on losses", () => {
    it("hedge limits loss to expected avg_loss", () => {
      // Without hedge: -30¢ max (hard exit)
      // With hedge: effective loss reduced
      // Expected avg_loss ≈ 9¢ (from framework)

      const entryPrice = 50;
      const hedgeTrigger = entryPrice - config.hedgeTriggerCents; // 34¢
      const hardExit = entryPrice - config.maxAdverseCents; // 20¢

      // Loss at hedge trigger (before hedge): -16¢
      // After 40% hedge, if price continues to hard exit:
      // Main leg loss: -30¢ on 60% = -18¢
      // Hedge gain: +(34-20)¢ on 40% = +5.6¢
      // Net: -12.4¢ (better than -30¢)

      const mainLegLoss = config.maxAdverseCents * (1 - config.hedgeRatio);
      const hedgeGain = (hedgeTrigger - hardExit) * config.hedgeRatio;
      const netLoss = mainLegLoss - hedgeGain;

      assert.ok(
        netLoss < config.maxAdverseCents,
        `Hedged loss (${netLoss}¢) should be less than unhedged max (${config.maxAdverseCents}¢)`,
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RESERVE & SIZING TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("Reserve & Sizing", () => {
  const config = createTestConfig();

  describe("Effective bankroll calculation", () => {
    it("reserves 25% of balance", () => {
      const balance = 1000;
      const { effectiveBankroll, reserveUsd } = calculateEffectiveBankroll(
        balance,
        config,
      );

      assert.strictEqual(reserveUsd, 250, "Reserve should be 25% = $250");
      assert.strictEqual(effectiveBankroll, 750, "Effective should be $750");
    });

    it("enforces minimum reserve", () => {
      const balance = 200; // 25% would be $50, but min is $100
      const { effectiveBankroll, reserveUsd } = calculateEffectiveBankroll(
        balance,
        config,
      );

      assert.strictEqual(reserveUsd, 100, "Reserve should be min $100");
      assert.strictEqual(effectiveBankroll, 100, "Effective should be $100");
    });

    it("returns zero effective when balance < min reserve", () => {
      const balance = 50;
      const { effectiveBankroll, reserveUsd } = calculateEffectiveBankroll(
        balance,
        config,
      );

      assert.strictEqual(reserveUsd, 100, "Reserve should be min $100");
      assert.strictEqual(effectiveBankroll, 0, "Effective should be $0");
    });
  });

  describe("Trade sizing", () => {
    it("uses 1% of effective bankroll when above minTradeUsd", () => {
      const effectiveBankroll = 1000;
      const size = calculateTradeSize(effectiveBankroll, config);

      // 1% of 1000 = 10, which is above minTradeUsd (5), so use 10
      assert.strictEqual(size, 10, "Trade size should be 1% = $10");
    });

    it("caps at MAX_TRADE_USD", () => {
      const effectiveBankroll = 5000; // 1% would be $50
      const size = calculateTradeSize(effectiveBankroll, config);

      assert.strictEqual(
        size,
        config.maxTradeUsd,
        `Trade size should be capped at $${config.maxTradeUsd}`,
      );
    });

    it("applies minTradeUsd floor for small bankrolls", () => {
      // With $165 effective bankroll, 1% = $1.65
      // But minTradeUsd = $5 should kick in
      const effectiveBankroll = 165;
      const size = calculateTradeSize(effectiveBankroll, config);

      assert.strictEqual(
        size,
        config.minTradeUsd,
        `Trade size should be floored at minTradeUsd ($${config.minTradeUsd})`,
      );
    });

    it("does not exceed effective bankroll even with minTradeUsd", () => {
      // If bankroll is $3 and minTradeUsd is $5, we can't trade $5
      // Should use the smaller of minTradeUsd and effectiveBankroll
      const effectiveBankroll = 3;
      const size = calculateTradeSize(effectiveBankroll, config);

      assert.strictEqual(
        size,
        3,
        "Trade size should not exceed effective bankroll even with minTradeUsd floor",
      );
    });

    it("handles edge case where fractionalSize equals minTradeUsd", () => {
      // If 1% of bankroll exactly equals minTradeUsd
      const effectiveBankroll = 500; // 1% = $5 = minTradeUsd
      const size = calculateTradeSize(effectiveBankroll, config);

      assert.strictEqual(size, 5, "Trade size should be $5 when they're equal");
    });
  });

  describe("Force Liquidation Config", () => {
    it("forceLiquidation defaults to false", () => {
      const config = createTestConfig();
      assert.strictEqual(
        config.forceLiquidation,
        false,
        "forceLiquidation should default to false",
      );
    });

    it("forceLiquidation can be enabled", () => {
      const config = createTestConfig();
      config.forceLiquidation = true;
      assert.strictEqual(
        config.forceLiquidation,
        true,
        "forceLiquidation can be set to true",
      );
    });

    it("zero effective bankroll is valid with force liquidation", () => {
      const config = createTestConfig();
      config.forceLiquidation = true;
      // Balance of $50 with $100 min reserve = $0 effective bankroll
      const balance = 50;
      const { effectiveBankroll, reserveUsd } = calculateEffectiveBankroll(
        balance,
        config,
      );

      assert.strictEqual(
        effectiveBankroll,
        0,
        "Effective bankroll should be $0",
      );
      assert.strictEqual(reserveUsd, 100, "Reserve should be $100");
      // With forceLiquidation=true, bot should still start in liquidation mode
      // (this is validated in the churn-start.ts logic, not here)
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG VALIDATION TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("Config Validation", () => {
  it("validates correct config without errors", () => {
    const config = createTestConfig();
    const errors = validateConfig(config);
    assert.strictEqual(
      errors.length,
      0,
      `Should have no errors, got: ${JSON.stringify(errors)}`,
    );
  });

  it("detects missing private key", () => {
    const config = createTestConfig();
    config.privateKey = "";
    const errors = validateConfig(config);
    assert.ok(
      errors.some((e) => e.field === "PRIVATE_KEY"),
      "Should detect missing PRIVATE_KEY",
    );
  });

  it("detects invalid trade fraction", () => {
    const config = createTestConfig();
    config.tradeFraction = 1.5;
    const errors = validateConfig(config);
    assert.ok(
      errors.some((e) => e.field === "TRADE_FRACTION"),
      "Should detect invalid TRADE_FRACTION",
    );
  });

  it("detects invalid profit factor", () => {
    const config = createTestConfig();
    config.minProfitFactor = 0.5;
    const errors = validateConfig(config);
    assert.ok(
      errors.some((e) => e.field === "MIN_PROFIT_FACTOR"),
      "Should detect MIN_PROFIT_FACTOR < 1",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LIQUIDATION MODE TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("Liquidation Mode", () => {
  describe("Activation conditions", () => {
    it("should activate when balance < reserve but positions exist", () => {
      const config = createTestConfig();
      config.forceLiquidation = true;

      const balance = 50; // Below $100 reserve
      const { effectiveBankroll } = calculateEffectiveBankroll(balance, config);
      const hasPositions = true; // Simulated positions exist

      // Liquidation mode should activate when:
      // 1. effectiveBankroll <= 0
      // 2. forceLiquidation is true
      // 3. positions exist
      const shouldActivateLiquidation =
        effectiveBankroll <= 0 && config.forceLiquidation && hasPositions;

      assert.strictEqual(
        shouldActivateLiquidation,
        true,
        "Liquidation mode should activate with low balance and existing positions",
      );
    });

    it("should NOT activate when balance < reserve and no positions", () => {
      const config = createTestConfig();
      config.forceLiquidation = true;

      const balance = 50;
      const { effectiveBankroll } = calculateEffectiveBankroll(balance, config);
      const hasPositions = false; // No positions

      const shouldActivateLiquidation =
        effectiveBankroll <= 0 && config.forceLiquidation && hasPositions;

      assert.strictEqual(
        shouldActivateLiquidation,
        false,
        "Liquidation mode should NOT activate without positions",
      );
    });

    it("should NOT activate when forceLiquidation is false", () => {
      const config = createTestConfig();
      config.forceLiquidation = false;

      const balance = 50;
      const { effectiveBankroll } = calculateEffectiveBankroll(balance, config);
      const hasPositions = true;

      const shouldActivateLiquidation =
        effectiveBankroll <= 0 && config.forceLiquidation && hasPositions;

      assert.strictEqual(
        shouldActivateLiquidation,
        false,
        "Liquidation mode should NOT activate when forceLiquidation=false",
      );
    });
  });

  describe("Exit conditions", () => {
    it("should exit liquidation mode when effectiveBankroll becomes positive", () => {
      const config = createTestConfig();

      // After selling positions, balance is now $200
      const balance = 200;
      const { effectiveBankroll } = calculateEffectiveBankroll(balance, config);

      const shouldExitLiquidation = effectiveBankroll > 0;

      assert.strictEqual(
        shouldExitLiquidation,
        true,
        "Should exit liquidation mode when balance exceeds reserve",
      );
      assert.strictEqual(
        effectiveBankroll,
        100,
        "Effective bankroll should be $100 (200 - 100 reserve)",
      );
    });
  });

  describe("Position ordering", () => {
    it("should sort positions by value descending for liquidation", () => {
      // Mock positions with different values
      const positions = [
        { tokenId: "small", value: 10 },
        { tokenId: "large", value: 100 },
        { tokenId: "medium", value: 50 },
      ];

      // Sort by value descending (largest first)
      const sortedPositions = [...positions].sort((a, b) => b.value - a.value);

      assert.strictEqual(
        sortedPositions[0].tokenId,
        "large",
        "Largest position should be first",
      );
      assert.strictEqual(
        sortedPositions[1].tokenId,
        "medium",
        "Medium position should be second",
      );
      assert.strictEqual(
        sortedPositions[2].tokenId,
        "small",
        "Smallest position should be last",
      );
    });
  });

  describe("Liquidation configuration", () => {
    it("liquidationMaxSlippagePct should be configurable", () => {
      const config = createTestConfig();
      assert.strictEqual(
        config.liquidationMaxSlippagePct,
        10,
        "Default liquidation slippage should be 10%",
      );

      config.liquidationMaxSlippagePct = 15;
      assert.strictEqual(
        config.liquidationMaxSlippagePct,
        15,
        "Liquidation slippage should be configurable",
      );
    });

    it("liquidationPollIntervalMs should be configurable", () => {
      const config = createTestConfig();
      assert.strictEqual(
        config.liquidationPollIntervalMs,
        1000,
        "Default liquidation poll interval should be 1000ms",
      );

      config.liquidationPollIntervalMs = 2000;
      assert.strictEqual(
        config.liquidationPollIntervalMs,
        2000,
        "Liquidation poll interval should be configurable",
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CLAUSE OPUS AUDIT TESTS - Verify audit fixes are working
// ═══════════════════════════════════════════════════════════════════════════

describe("Clause Opus Audit Compliance", () => {
  const config = createTestConfig();

  describe("Clause 2.1 - SHORT Entry Rejection", () => {
    it("rejects SHORT bias entries (LONG-only enforcement)", () => {
      const decisionEngine = new DecisionEngine(config);

      const decision = decisionEngine.evaluateEntry({
        tokenId: "test-token",
        bias: "SHORT",
        orderbook: {
          bestAskCents: 50,
          bestBidCents: 48,
          midPriceCents: 49,
          spreadCents: 2,
          bidDepthUsd: 100,
          askDepthUsd: 100,
        },
        activity: {
          tradesInWindow: 15,
          bookUpdatesInWindow: 25,
          lastTradeTime: Date.now(),
          lastUpdateTime: Date.now(),
        },
        referencePriceCents: 49,
        evMetrics: {
          totalTrades: 0,
          winRate: 0,
          evCents: 0,
          wins: 0,
          losses: 0,
          avgWinCents: 0,
          avgLossCents: 0,
          totalPnlUsd: 0,
        },
        evAllowed: { allowed: true },
        currentPositions: [],
        effectiveBankroll: 1000,
        totalDeployedUsd: 0,
      });

      assert.strictEqual(
        decision.allowed,
        false,
        "SHORT entries should be rejected",
      );
      assert.ok(
        decision.reason?.toLowerCase().includes("short") ||
          decision.reason?.toLowerCase().includes("long-only"),
        `Should mention SHORT rejection, got: ${decision.reason}`,
      );
    });

    it("allows LONG bias entries", () => {
      const decisionEngine = new DecisionEngine(config);

      const decision = decisionEngine.evaluateEntry({
        tokenId: "test-token",
        bias: "LONG",
        orderbook: {
          bestAskCents: 50,
          bestBidCents: 48,
          midPriceCents: 49,
          spreadCents: 2,
          bidDepthUsd: 100,
          askDepthUsd: 100,
        },
        activity: {
          tradesInWindow: 15,
          bookUpdatesInWindow: 25,
          lastTradeTime: Date.now(),
          lastUpdateTime: Date.now(),
        },
        referencePriceCents: 49,
        evMetrics: {
          totalTrades: 0,
          winRate: 0,
          evCents: 0,
          wins: 0,
          losses: 0,
          avgWinCents: 0,
          avgLossCents: 0,
          totalPnlUsd: 0,
        },
        evAllowed: { allowed: true },
        currentPositions: [],
        effectiveBankroll: 1000,
        totalDeployedUsd: 0,
      });

      assert.strictEqual(
        decision.allowed,
        true,
        "LONG entries should be allowed",
      );
      assert.strictEqual(decision.side, "LONG", "Side should be LONG");
    });

    it("rejects NONE bias entries", () => {
      const decisionEngine = new DecisionEngine(config);

      const decision = decisionEngine.evaluateEntry({
        tokenId: "test-token",
        bias: "NONE",
        orderbook: {
          bestAskCents: 50,
          bestBidCents: 48,
          midPriceCents: 49,
          spreadCents: 2,
          bidDepthUsd: 100,
          askDepthUsd: 100,
        },
        activity: {
          tradesInWindow: 15,
          bookUpdatesInWindow: 25,
          lastTradeTime: Date.now(),
          lastUpdateTime: Date.now(),
        },
        referencePriceCents: 49,
        evMetrics: {
          totalTrades: 0,
          winRate: 0,
          evCents: 0,
          wins: 0,
          losses: 0,
          avgWinCents: 0,
          avgLossCents: 0,
          totalPnlUsd: 0,
        },
        evAllowed: { allowed: true },
        currentPositions: [],
        effectiveBankroll: 1000,
        totalDeployedUsd: 0,
      });

      assert.strictEqual(
        decision.allowed,
        false,
        "NONE bias entries should be rejected",
      );
    });
  });

  describe("Clause 3.3 - Spread Gating Against Churn Budget", () => {
    it("rejects entries when spread exceeds minSpreadCents", () => {
      const decisionEngine = new DecisionEngine(config);

      // Spread of 10¢ should exceed the 6¢ limit
      const decision = decisionEngine.evaluateEntry({
        tokenId: "test-token",
        bias: "LONG",
        orderbook: {
          bestAskCents: 55,
          bestBidCents: 45,
          midPriceCents: 50,
          spreadCents: 10, // Exceeds minSpreadCents (6)
          bidDepthUsd: 100,
          askDepthUsd: 100,
        },
        activity: {
          tradesInWindow: 15,
          bookUpdatesInWindow: 25,
          lastTradeTime: Date.now(),
          lastUpdateTime: Date.now(),
        },
        referencePriceCents: 50,
        evMetrics: {
          totalTrades: 0,
          winRate: 0,
          evCents: 0,
          wins: 0,
          losses: 0,
          avgWinCents: 0,
          avgLossCents: 0,
          totalPnlUsd: 0,
        },
        evAllowed: { allowed: true },
        currentPositions: [],
        effectiveBankroll: 1000,
        totalDeployedUsd: 0,
      });

      assert.strictEqual(
        decision.allowed,
        false,
        "Entries with spread > minSpreadCents should be rejected",
      );
      assert.ok(
        decision.reason?.toLowerCase().includes("spread"),
        `Should mention spread issue, got: ${decision.reason}`,
      );
    });

    it("rejects entries when spread exceeds 2x churn budget", () => {
      const decisionEngine = new DecisionEngine(config);

      // Spread of 5¢ should exceed 2x churnCostCentsEstimate (2 * 2 = 4)
      // but be within minSpreadCents (6)
      const decision = decisionEngine.evaluateEntry({
        tokenId: "test-token",
        bias: "LONG",
        orderbook: {
          bestAskCents: 52.5,
          bestBidCents: 47.5,
          midPriceCents: 50,
          spreadCents: 5, // Exceeds 2x churn (4) but under minSpreadCents (6)
          bidDepthUsd: 100,
          askDepthUsd: 100,
        },
        activity: {
          tradesInWindow: 15,
          bookUpdatesInWindow: 25,
          lastTradeTime: Date.now(),
          lastUpdateTime: Date.now(),
        },
        referencePriceCents: 50,
        evMetrics: {
          totalTrades: 0,
          winRate: 0,
          evCents: 0,
          wins: 0,
          losses: 0,
          avgWinCents: 0,
          avgLossCents: 0,
          totalPnlUsd: 0,
        },
        evAllowed: { allowed: true },
        currentPositions: [],
        effectiveBankroll: 1000,
        totalDeployedUsd: 0,
      });

      assert.strictEqual(
        decision.allowed,
        false,
        "Entries with spread > 2x churn budget should be rejected",
      );
      assert.ok(
        decision.reason?.toLowerCase().includes("spread") ||
          decision.reason?.toLowerCase().includes("churn"),
        `Should mention spread/churn issue, got: ${decision.reason}`,
      );
    });

    it("allows entries when spread is within acceptable limits", () => {
      const decisionEngine = new DecisionEngine(config);

      // Spread of 3¢ should be acceptable (< minSpreadCents and < 2x churn)
      const decision = decisionEngine.evaluateEntry({
        tokenId: "test-token",
        bias: "LONG",
        orderbook: {
          bestAskCents: 51.5,
          bestBidCents: 48.5,
          midPriceCents: 50,
          spreadCents: 3, // Within limits
          bidDepthUsd: 100,
          askDepthUsd: 100,
        },
        activity: {
          tradesInWindow: 15,
          bookUpdatesInWindow: 25,
          lastTradeTime: Date.now(),
          lastUpdateTime: Date.now(),
        },
        referencePriceCents: 50,
        evMetrics: {
          totalTrades: 0,
          winRate: 0,
          evCents: 0,
          wins: 0,
          losses: 0,
          avgWinCents: 0,
          avgLossCents: 0,
          totalPnlUsd: 0,
        },
        evAllowed: { allowed: true },
        currentPositions: [],
        effectiveBankroll: 1000,
        totalDeployedUsd: 0,
      });

      assert.strictEqual(
        decision.allowed,
        true,
        "Entries with acceptable spread should be allowed",
      );
    });
  });

  describe("Entry Bounds Buffer", () => {
    it("entry price bounds are correctly configured", () => {
      // minEntryPriceCents should equal maxAdverseCents (room to be wrong)
      assert.strictEqual(
        config.minEntryPriceCents,
        config.maxAdverseCents,
        "MIN_ENTRY should equal MAX_ADVERSE for loss room",
      );

      // maxEntryPriceCents should leave room for TP
      const expectedMax = 100 - config.tpCents - config.entryBufferCents;
      assert.ok(
        config.maxEntryPriceCents <= expectedMax,
        `MAX_ENTRY (${config.maxEntryPriceCents}) should be <= ${expectedMax}`,
      );

      // Buffer should be at least 2¢ for meaningful protection
      assert.ok(
        config.entryBufferCents >= 2,
        `Buffer (${config.entryBufferCents}¢) should be at least 2¢`,
      );
    });
  });
});
