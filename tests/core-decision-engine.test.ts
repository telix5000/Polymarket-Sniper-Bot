/**
 * Decision Engine Smoke Tests
 *
 * Tests for the core strategy decision logic.
 * Uses golden file patterns to validate decision boundaries.
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";

import {
  DecisionEngine,
  type DecisionEngineConfig,
  type OrderbookState,
  type MarketActivity,
  type ManagedPosition,
  type EvMetrics,
} from "../src/core/decision-engine";

import {
  EvTracker,
  createTradeResult,
  calculatePnlCents,
  calculatePnlUsd,
  type EvTrackerConfig,
} from "../src/core/ev-tracker";

// ═══════════════════════════════════════════════════════════════════════════
// Test Fixtures
// ═══════════════════════════════════════════════════════════════════════════

function createTestConfig(): DecisionEngineConfig {
  return {
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
    maxOpenPositionsTotal: 12,
    maxOpenPositionsPerMarket: 1,
    maxDeployedFractionTotal: 0.3,
    tradeFraction: 0.01,
    maxTradeUsd: 25,
    minTradeUsd: 5,
  };
}

function createValidOrderbook(midPriceCents = 50): OrderbookState {
  return {
    bestBidCents: midPriceCents - 2,
    bestAskCents: midPriceCents + 2,
    bidDepthUsd: 100,
    askDepthUsd: 100,
    spreadCents: 4,
    midPriceCents,
    source: "WS",
  };
}

function createValidActivity(): MarketActivity {
  return {
    tradesInWindow: 15,
    bookUpdatesInWindow: 25,
    lastTradeTime: Date.now() - 1000,
    lastUpdateTime: Date.now() - 500,
  };
}

function createValidEvMetrics(): EvMetrics {
  return {
    totalTrades: 50,
    wins: 30,
    losses: 20,
    winRate: 0.6,
    avgWinCents: 14,
    avgLossCents: 9,
    evCents: 2.5,
    profitFactor: 1.55,
    totalPnlUsd: 150,
    lastUpdated: Date.now(),
  };
}

function createTestPosition(
  overrides: Partial<ManagedPosition> = {},
): ManagedPosition {
  return {
    id: "test-position-1",
    tokenId: "test-token",
    side: "LONG",
    state: "OPEN",
    entryPriceCents: 50,
    entrySizeUsd: 25,
    entryTime: Date.now() - 60000, // 1 minute ago
    currentPriceCents: 50,
    unrealizedPnlCents: 0,
    unrealizedPnlUsd: 0,
    takeProfitPriceCents: 64,
    hedgeTriggerPriceCents: 34,
    hardExitPriceCents: 20,
    hedges: [],
    totalHedgeRatio: 0,
    referencePriceCents: 50,
    transitions: [],
    lastUpdateTime: Date.now(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Decision Engine Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("Decision Engine - Entry Evaluation", () => {
  let engine: DecisionEngine;
  let config: DecisionEngineConfig;

  beforeEach(() => {
    config = createTestConfig();
    engine = new DecisionEngine(config);
  });

  describe("Bias checks", () => {
    it("should allow entry with LONG bias", () => {
      const decision = engine.evaluateEntry({
        tokenId: "test-token",
        bias: "LONG",
        orderbook: createValidOrderbook(50),
        activity: createValidActivity(),
        referencePriceCents: 50,
        evMetrics: createValidEvMetrics(),
        evAllowed: { allowed: true },
        currentPositions: [],
        effectiveBankroll: 1000,
        totalDeployedUsd: 0,
      });

      assert.strictEqual(decision.checks.bias.passed, true);
    });

    it("should reject entry with SHORT bias on Polymarket", () => {
      const decision = engine.evaluateEntry({
        tokenId: "test-token",
        bias: "SHORT",
        orderbook: createValidOrderbook(50),
        activity: createValidActivity(),
        referencePriceCents: 50,
        evMetrics: createValidEvMetrics(),
        evAllowed: { allowed: true },
        currentPositions: [],
        effectiveBankroll: 1000,
        totalDeployedUsd: 0,
      });

      assert.strictEqual(decision.checks.bias.passed, false);
      assert.ok(
        decision.checks.bias.reason?.includes("SHORT entries not supported"),
      );
    });

    it("should reject entry with NONE bias", () => {
      const decision = engine.evaluateEntry({
        tokenId: "test-token",
        bias: "NONE",
        orderbook: createValidOrderbook(50),
        activity: createValidActivity(),
        referencePriceCents: 50,
        evMetrics: createValidEvMetrics(),
        evAllowed: { allowed: true },
        currentPositions: [],
        effectiveBankroll: 1000,
        totalDeployedUsd: 0,
      });

      assert.strictEqual(decision.checks.bias.passed, false);
      assert.strictEqual(decision.checks.bias.reason, "No bias signal");
    });
  });

  describe("Liquidity gates", () => {
    it("should reject entry with wide spread", () => {
      const orderbook = createValidOrderbook(50);
      orderbook.spreadCents = 10; // Too wide

      const decision = engine.evaluateEntry({
        tokenId: "test-token",
        bias: "LONG",
        orderbook,
        activity: createValidActivity(),
        referencePriceCents: 50,
        evMetrics: createValidEvMetrics(),
        evAllowed: { allowed: true },
        currentPositions: [],
        effectiveBankroll: 1000,
        totalDeployedUsd: 0,
      });

      assert.strictEqual(decision.checks.liquidity.passed, false);
      assert.ok(decision.checks.liquidity.reason?.includes("Spread"));
    });

    it("should reject entry with insufficient depth", () => {
      const orderbook = createValidOrderbook(50);
      orderbook.bidDepthUsd = 10; // Too shallow

      const decision = engine.evaluateEntry({
        tokenId: "test-token",
        bias: "LONG",
        orderbook,
        activity: createValidActivity(),
        referencePriceCents: 50,
        evMetrics: createValidEvMetrics(),
        evAllowed: { allowed: true },
        currentPositions: [],
        effectiveBankroll: 1000,
        totalDeployedUsd: 0,
      });

      assert.strictEqual(decision.checks.liquidity.passed, false);
      assert.ok(decision.checks.liquidity.reason?.includes("Depth"));
    });

    it("should accept entry with sufficient liquidity", () => {
      const decision = engine.evaluateEntry({
        tokenId: "test-token",
        bias: "LONG",
        orderbook: createValidOrderbook(50),
        activity: createValidActivity(),
        referencePriceCents: 50,
        evMetrics: createValidEvMetrics(),
        evAllowed: { allowed: true },
        currentPositions: [],
        effectiveBankroll: 1000,
        totalDeployedUsd: 0,
      });

      assert.strictEqual(decision.checks.liquidity.passed, true);
    });
  });

  describe("Price bounds", () => {
    it("should reject entry below minimum price", () => {
      const decision = engine.evaluateEntry({
        tokenId: "test-token",
        bias: "LONG",
        orderbook: createValidOrderbook(25), // Below min of 30
        activity: createValidActivity(),
        referencePriceCents: 25,
        evMetrics: createValidEvMetrics(),
        evAllowed: { allowed: true },
        currentPositions: [],
        effectiveBankroll: 1000,
        totalDeployedUsd: 0,
      });

      assert.strictEqual(decision.checks.priceBounds.passed, false);
      assert.ok(decision.checks.priceBounds.reason?.includes("outside bounds"));
    });

    it("should reject entry above maximum price", () => {
      const decision = engine.evaluateEntry({
        tokenId: "test-token",
        bias: "LONG",
        orderbook: createValidOrderbook(90), // Above max of 82
        activity: createValidActivity(),
        referencePriceCents: 90,
        evMetrics: createValidEvMetrics(),
        evAllowed: { allowed: true },
        currentPositions: [],
        effectiveBankroll: 1000,
        totalDeployedUsd: 0,
      });

      assert.strictEqual(decision.checks.priceBounds.passed, false);
      assert.ok(decision.checks.priceBounds.reason?.includes("outside bounds"));
    });

    it("should accept entry within bounds", () => {
      const decision = engine.evaluateEntry({
        tokenId: "test-token",
        bias: "LONG",
        orderbook: createValidOrderbook(50),
        activity: createValidActivity(),
        referencePriceCents: 50,
        evMetrics: createValidEvMetrics(),
        evAllowed: { allowed: true },
        currentPositions: [],
        effectiveBankroll: 1000,
        totalDeployedUsd: 0,
      });

      assert.strictEqual(decision.checks.priceBounds.passed, true);
    });
  });

  describe("Risk limits", () => {
    it("should reject when at max positions", () => {
      const positions: ManagedPosition[] = Array(12)
        .fill(null)
        .map((_, i) =>
          createTestPosition({ id: `pos-${i}`, tokenId: `token-${i}` }),
        );

      const decision = engine.evaluateEntry({
        tokenId: "new-token",
        bias: "LONG",
        orderbook: createValidOrderbook(50),
        activity: createValidActivity(),
        referencePriceCents: 50,
        evMetrics: createValidEvMetrics(),
        evAllowed: { allowed: true },
        currentPositions: positions,
        effectiveBankroll: 1000,
        totalDeployedUsd: 100,
      });

      assert.strictEqual(decision.checks.riskLimits.passed, false);
      assert.ok(decision.checks.riskLimits.reason?.includes("Max positions"));
    });

    it("should reject when already holding same token", () => {
      const positions: ManagedPosition[] = [
        createTestPosition({ tokenId: "test-token" }),
      ];

      const decision = engine.evaluateEntry({
        tokenId: "test-token", // Same token
        bias: "LONG",
        orderbook: createValidOrderbook(50),
        activity: createValidActivity(),
        referencePriceCents: 50,
        evMetrics: createValidEvMetrics(),
        evAllowed: { allowed: true },
        currentPositions: positions,
        effectiveBankroll: 1000,
        totalDeployedUsd: 25,
      });

      assert.strictEqual(decision.checks.riskLimits.passed, false);
      assert.ok(decision.checks.riskLimits.reason?.includes("Already holding"));
    });

    it("should reject when max deployment reached", () => {
      const decision = engine.evaluateEntry({
        tokenId: "test-token",
        bias: "LONG",
        orderbook: createValidOrderbook(50),
        activity: createValidActivity(),
        referencePriceCents: 50,
        evMetrics: createValidEvMetrics(),
        evAllowed: { allowed: true },
        currentPositions: [],
        effectiveBankroll: 1000,
        totalDeployedUsd: 350, // 35% > 30% max
      });

      assert.strictEqual(decision.checks.riskLimits.passed, false);
      assert.ok(decision.checks.riskLimits.reason?.includes("Max deployed"));
    });
  });

  describe("EV controls", () => {
    it("should reject when EV disallows trading", () => {
      const decision = engine.evaluateEntry({
        tokenId: "test-token",
        bias: "LONG",
        orderbook: createValidOrderbook(50),
        activity: createValidActivity(),
        referencePriceCents: 50,
        evMetrics: createValidEvMetrics(),
        evAllowed: { allowed: false, reason: "EV too low" },
        currentPositions: [],
        effectiveBankroll: 1000,
        totalDeployedUsd: 0,
      });

      assert.strictEqual(decision.checks.evAllowed.passed, false);
    });
  });

  describe("Successful entry", () => {
    it("should allow entry when all checks pass", () => {
      const decision = engine.evaluateEntry({
        tokenId: "test-token",
        bias: "LONG",
        orderbook: createValidOrderbook(50),
        activity: createValidActivity(),
        referencePriceCents: 50,
        evMetrics: createValidEvMetrics(),
        evAllowed: { allowed: true },
        currentPositions: [],
        effectiveBankroll: 1000,
        totalDeployedUsd: 0,
      });

      assert.strictEqual(decision.allowed, true);
      assert.strictEqual(decision.side, "LONG");
      assert.ok(decision.sizeUsd! > 0);
    });

    it("should calculate correct trade size", () => {
      const decision = engine.evaluateEntry({
        tokenId: "test-token",
        bias: "LONG",
        orderbook: createValidOrderbook(50),
        activity: createValidActivity(),
        referencePriceCents: 50,
        evMetrics: createValidEvMetrics(),
        evAllowed: { allowed: true },
        currentPositions: [],
        effectiveBankroll: 1000,
        totalDeployedUsd: 0,
      });

      // 1% of 1000 = 10, but max is 25
      assert.strictEqual(decision.sizeUsd, 10);
    });
  });
});

describe("Decision Engine - Exit Evaluation", () => {
  let engine: DecisionEngine;
  let config: DecisionEngineConfig;

  beforeEach(() => {
    config = createTestConfig();
    engine = new DecisionEngine(config);
  });

  it("should trigger take profit when target reached", () => {
    const position = createTestPosition({
      entryPriceCents: 50,
      currentPriceCents: 65,
    });

    const decision = engine.evaluateExit({
      position,
      currentPriceCents: 65, // +15¢ > TP of 14¢
      bias: "LONG",
      evAllowed: { allowed: true },
    });

    assert.strictEqual(decision.shouldExit, true);
    assert.strictEqual(decision.reason, "TAKE_PROFIT");
    assert.strictEqual(decision.urgency, "MEDIUM");
  });

  it("should trigger hard exit at max adverse", () => {
    const position = createTestPosition({
      entryPriceCents: 50,
      currentPriceCents: 19,
    });

    const decision = engine.evaluateExit({
      position,
      currentPriceCents: 19, // -31¢ > max adverse of 30¢
      bias: "LONG",
      evAllowed: { allowed: true },
    });

    assert.strictEqual(decision.shouldExit, true);
    assert.strictEqual(decision.reason, "HARD_EXIT");
    assert.strictEqual(decision.urgency, "CRITICAL");
  });

  it("should trigger time stop when max hold exceeded", () => {
    const position = createTestPosition({
      entryTime: Date.now() - 4000000, // Over 1 hour ago
    });

    const decision = engine.evaluateExit({
      position,
      currentPriceCents: 50,
      bias: "LONG",
      evAllowed: { allowed: true },
    });

    assert.strictEqual(decision.shouldExit, true);
    assert.strictEqual(decision.reason, "TIME_STOP");
  });

  it("should trigger exit on bias flip when profitable", () => {
    const position = createTestPosition({
      entryPriceCents: 50,
      side: "LONG",
    });

    const decision = engine.evaluateExit({
      position,
      currentPriceCents: 55, // +5¢ profit
      bias: "SHORT", // Bias flipped
      evAllowed: { allowed: true },
    });

    assert.strictEqual(decision.shouldExit, true);
    assert.strictEqual(decision.reason, "BIAS_FLIP");
  });

  it("should not trigger exit on bias flip when at significant loss", () => {
    const position = createTestPosition({
      entryPriceCents: 50,
      side: "LONG",
    });

    const decision = engine.evaluateExit({
      position,
      currentPriceCents: 30, // -20¢ loss > hedge trigger of 16¢
      bias: "SHORT",
      evAllowed: { allowed: true },
    });

    assert.strictEqual(decision.shouldExit, false);
  });

  it("should not exit when holding normally", () => {
    const position = createTestPosition({
      entryPriceCents: 50,
    });

    const decision = engine.evaluateExit({
      position,
      currentPriceCents: 52, // +2¢, not enough for TP
      bias: "LONG",
      evAllowed: { allowed: true },
    });

    assert.strictEqual(decision.shouldExit, false);
  });
});

describe("Decision Engine - Hedge Logic", () => {
  let engine: DecisionEngine;
  let config: DecisionEngineConfig;

  beforeEach(() => {
    config = createTestConfig();
    engine = new DecisionEngine(config);
  });

  it("should trigger hedge when adverse move exceeds threshold", () => {
    const position = createTestPosition({
      entryPriceCents: 50,
      side: "LONG",
      totalHedgeRatio: 0,
    });

    const needsHedge = engine.needsHedge(position, 33); // -17¢ > trigger of 16¢
    assert.strictEqual(needsHedge, true);
  });

  it("should not trigger hedge when already at max ratio", () => {
    const position = createTestPosition({
      entryPriceCents: 50,
      side: "LONG",
      totalHedgeRatio: 0.7, // Max hedge ratio
    });

    const needsHedge = engine.needsHedge(position, 30); // -20¢ adverse
    assert.strictEqual(needsHedge, false);
  });

  it("should calculate correct hedge size", () => {
    const position = createTestPosition({
      entrySizeUsd: 100,
      totalHedgeRatio: 0,
    });

    const hedgeSize = engine.calculateHedgeSize(position);
    assert.strictEqual(hedgeSize, 40); // 40% of 100
  });

  it("should limit hedge size to remaining room", () => {
    const position = createTestPosition({
      entrySizeUsd: 100,
      totalHedgeRatio: 0.5, // Already hedged 50%
    });

    const hedgeSize = engine.calculateHedgeSize(position);
    // Only 20% room left (max 70%) - use approximate equality for floating point
    assert.ok(
      Math.abs(hedgeSize - 20) < 0.01,
      `Expected ~20, got ${hedgeSize}`,
    );
  });
});

describe("Decision Engine - Preferred Zone", () => {
  let engine: DecisionEngine;
  let config: DecisionEngineConfig;

  beforeEach(() => {
    config = createTestConfig();
    engine = new DecisionEngine(config);
  });

  it("should identify prices in preferred zone", () => {
    assert.strictEqual(engine.isInPreferredZone(35), true);
    assert.strictEqual(engine.isInPreferredZone(50), true);
    assert.strictEqual(engine.isInPreferredZone(65), true);
  });

  it("should identify prices outside preferred zone", () => {
    assert.strictEqual(engine.isInPreferredZone(30), false);
    assert.strictEqual(engine.isInPreferredZone(70), false);
  });
});

describe("Decision Engine - Entry Score", () => {
  let engine: DecisionEngine;
  let config: DecisionEngineConfig;

  beforeEach(() => {
    config = createTestConfig();
    engine = new DecisionEngine(config);
  });

  it("should give higher score for preferred zone", () => {
    const centerScore = engine.calculateEntryScore({
      priceCents: 50, // Center of preferred zone
      spreadCents: 4,
      depthUsd: 50,
      activityScore: 0.5,
    });

    const outsideScore = engine.calculateEntryScore({
      priceCents: 30, // Outside preferred zone
      spreadCents: 4,
      depthUsd: 50,
      activityScore: 0.5,
    });

    assert.ok(centerScore > outsideScore);
  });

  it("should give higher score for tighter spread", () => {
    const tightScore = engine.calculateEntryScore({
      priceCents: 50,
      spreadCents: 2,
      depthUsd: 50,
      activityScore: 0.5,
    });

    const wideScore = engine.calculateEntryScore({
      priceCents: 50,
      spreadCents: 6,
      depthUsd: 50,
      activityScore: 0.5,
    });

    assert.ok(tightScore > wideScore);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EV Tracker Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("EV Tracker", () => {
  let tracker: EvTracker;

  beforeEach(() => {
    tracker = new EvTracker();
  });

  describe("Trade recording", () => {
    it("should record trades and update metrics", () => {
      const trade = createTradeResult("token-1", "LONG", 50, 64, 25);
      tracker.recordTrade(trade);

      const metrics = tracker.getMetrics();
      assert.strictEqual(metrics.totalTrades, 1);
      assert.strictEqual(metrics.wins, 1);
    });

    it("should maintain rolling window", () => {
      const config: Partial<EvTrackerConfig> = { rollingWindowTrades: 5 };
      tracker = new EvTracker(config);

      // Add 7 trades
      for (let i = 0; i < 7; i++) {
        const trade = createTradeResult("token-1", "LONG", 50, 55, 25);
        tracker.recordTrade(trade);
      }

      const metrics = tracker.getMetrics();
      assert.strictEqual(metrics.totalTrades, 5); // Window is 5
    });
  });

  describe("EV calculation", () => {
    it("should calculate positive EV for winning trades", () => {
      // Add 6 wins and 4 losses (60% win rate)
      for (let i = 0; i < 6; i++) {
        tracker.recordTrade(createTradeResult("token-1", "LONG", 50, 64, 25)); // +14¢ win
      }
      for (let i = 0; i < 4; i++) {
        tracker.recordTrade(createTradeResult("token-1", "LONG", 50, 41, 25)); // -9¢ loss
      }

      const metrics = tracker.getMetrics();
      assert.ok(
        metrics.evCents > 0,
        `Expected positive EV, got ${metrics.evCents}`,
      );
    });

    it("should calculate break-even at ~48% win rate", () => {
      // Break-even formula: p > (avgLoss + churn) / (avgWin + avgLoss)
      // With avgWin=14¢, avgLoss=9¢, churn=2¢: p > (9 + 2) / (14 + 9) = 47.8%
      // At exactly 48% wins:
      // EV = 0.48 * 14 - 0.52 * 9 - 2 = 6.72 - 4.68 - 2 = 0.04 (slightly positive)
      for (let i = 0; i < 48; i++) {
        tracker.recordTrade(createTradeResult("token-1", "LONG", 50, 64, 25));
      }
      for (let i = 0; i < 52; i++) {
        tracker.recordTrade(createTradeResult("token-1", "LONG", 50, 41, 25));
      }

      const metrics = tracker.getMetrics();
      // EV should be close to 0 (between -0.5 and +0.5)
      assert.ok(
        metrics.evCents > -0.5 && metrics.evCents < 0.5,
        `Expected EV near break-even (-0.5 to +0.5), got ${metrics.evCents}`,
      );
    });
  });

  describe("Trading permission", () => {
    it("should allow trading during warmup", () => {
      // Only 5 trades (< 10 minimum)
      for (let i = 0; i < 5; i++) {
        tracker.recordTrade(createTradeResult("token-1", "LONG", 50, 64, 25));
      }

      const { allowed } = tracker.isTradingAllowed();
      assert.strictEqual(allowed, true);
    });

    it("should allow trading with good metrics", () => {
      // Create a fresh tracker for this test
      const freshTracker = new EvTracker();

      // Add trades with positive EV - interleave to avoid early pause trigger
      // Condition: (i % 5 < 3 || i >= 18) produces wins at positions:
      // 0,1,2, 5,6,7, 10,11,12, 15,16,17, 18,19 = 14 wins
      // Losses at: 3,4, 8,9, 13,14 = 6 losses
      // Total: 70% win rate (sufficient for positive EV)
      for (let i = 0; i < 20; i++) {
        if (i % 5 < 3 || i >= 18) {
          freshTracker.recordTrade(
            createTradeResult("token-1", "LONG", 50, 64, 25),
          ); // Win
        } else {
          freshTracker.recordTrade(
            createTradeResult("token-1", "LONG", 50, 41, 25),
          ); // Loss
        }
      }

      const metrics = freshTracker.getMetrics();
      // Verify we have good metrics
      assert.ok(
        metrics.evCents > 0,
        `Expected positive EV, got ${metrics.evCents}`,
      );
      assert.ok(
        metrics.profitFactor > 1.25,
        `Expected profit factor > 1.25, got ${metrics.profitFactor}`,
      );

      const { allowed } = freshTracker.isTradingAllowed();
      assert.strictEqual(
        allowed,
        true,
        `Expected trading allowed but was paused`,
      );
    });

    it("should pause after bad performance", () => {
      const config: Partial<EvTrackerConfig> = {
        minEvCents: 0,
        minProfitFactor: 1.5,
        pauseSeconds: 60,
      };
      tracker = new EvTracker(config);

      // Add losing trades to degrade metrics
      for (let i = 0; i < 15; i++) {
        tracker.recordTrade(createTradeResult("token-1", "LONG", 50, 42, 25)); // -8¢ loss
      }

      const { allowed, reason } = tracker.isTradingAllowed();
      assert.strictEqual(allowed, false);
      assert.ok(
        reason?.includes("PAUSED") || reason?.includes("Profit factor"),
      );
    });
  });
});

describe("P&L Calculations", () => {
  describe("calculatePnlCents", () => {
    it("should calculate LONG P&L correctly", () => {
      assert.strictEqual(calculatePnlCents("LONG", 50, 64), 14); // Win
      assert.strictEqual(calculatePnlCents("LONG", 50, 41), -9); // Loss
    });

    it("should calculate SHORT P&L correctly", () => {
      assert.strictEqual(calculatePnlCents("SHORT", 50, 36), 14); // Win (price down)
      assert.strictEqual(calculatePnlCents("SHORT", 50, 59), -9); // Loss (price up)
    });
  });

  describe("calculatePnlUsd", () => {
    it("should convert cents P&L to USD", () => {
      // Entry at 50¢, size $25 = 50 shares
      // 14¢ gain per share = $7 total
      const pnlUsd = calculatePnlUsd(14, 25, 50);
      assert.ok(Math.abs(pnlUsd - 7) < 0.01);
    });

    it("should handle zero entry price", () => {
      const pnlUsd = calculatePnlUsd(14, 25, 0);
      assert.strictEqual(pnlUsd, 0);
    });
  });

  describe("createTradeResult", () => {
    it("should create complete trade result", () => {
      const result = createTradeResult("token-1", "LONG", 50, 64, 25);

      assert.strictEqual(result.tokenId, "token-1");
      assert.strictEqual(result.side, "LONG");
      assert.strictEqual(result.entryPriceCents, 50);
      assert.strictEqual(result.exitPriceCents, 64);
      assert.strictEqual(result.sizeUsd, 25);
      assert.strictEqual(result.pnlCents, 14);
      assert.strictEqual(result.isWin, true);
      assert.ok(result.timestamp > 0);
    });
  });
});
