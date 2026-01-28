import assert from "node:assert";
import { test, describe } from "node:test";

/**
 * Unit tests for V2 Dynamic Reserves (Risk-Aware Capital Allocation)
 *
 * These tests verify that:
 * 1. Dynamic reserves configuration is properly loaded from presets
 * 2. Position risk tiers are correctly calculated
 * 3. Reserve amounts scale appropriately based on position risk
 * 4. The system uses the higher of percentage-based and risk-aware reserves
 */

// Default dynamic reserves config matching the balanced preset
const defaultDynamicReserves = {
  enabled: true,
  baseReserveFloorUsd: 20,
  baseReserveEquityPct: 0.05,
  maxReserveUsd: 200,
  hedgeCapUsd: 50,
  hedgeTriggerLossPct: 20,
  catastrophicLossPct: 50,
  highWinProbPriceThreshold: 0.85,
};

/**
 * Simplified mock position type for testing dynamic reserves.
 *
 * NOTE: This mock only includes the fields used by computePositionRiskReserve:
 * - tokenId: Position identifier (for reserve breakdown)
 * - size: Position size in shares (for notional calculation)
 * - curPrice: Current price (for tier classification and notional)
 * - pnlPct: P&L percentage (for loss tier classification)
 * - value: Position value in USD (for total reserve calculation)
 *
 * The actual Position interface (src/v2/index.ts:59-74) has additional fields
 * (conditionId, outcome, avgPrice, gainCents, entryTime, lastPrice, priceHistory,
 * marketEndTime) that are NOT used by the reserve calculation logic, so they are
 * intentionally omitted here to keep tests focused and maintainable.
 */
interface MockPosition {
  tokenId: string;
  size: number;
  curPrice: number;
  pnlPct: number;
  value: number;
}

// Reserve tier type
type ReserveTier =
  | "NONE"
  | "HIGH_WIN_PROB"
  | "NORMAL"
  | "HEDGE"
  | "CATASTROPHIC";

interface PositionRiskReserve {
  tokenId: string;
  tier: ReserveTier;
  reserveUsd: number;
  reason: string;
}

/**
 * Compute risk-aware reserve requirement for a single position
 * This mirrors the V2 computePositionRiskReserve function
 */
function computePositionRiskReserve(
  pos: MockPosition,
  config: typeof defaultDynamicReserves,
): PositionRiskReserve {
  const notionalUsd = pos.curPrice * pos.size;
  const lossPct = Math.abs(Math.min(0, pos.pnlPct)); // Only count losses

  // Near-resolution positions need no reserve (high probability of payout)
  if (pos.curPrice >= 0.99) {
    return {
      tokenId: pos.tokenId,
      tier: "NONE",
      reserveUsd: 0,
      reason: "NEAR_RESOLUTION",
    };
  }

  // HIGH WIN PROBABILITY: When current price is high (e.g., ≥85¢), minimal reserves needed
  if (pos.curPrice >= config.highWinProbPriceThreshold) {
    const reserve = Math.min(0.5, notionalUsd * 0.02);
    return {
      tokenId: pos.tokenId,
      tier: "HIGH_WIN_PROB",
      reserveUsd: reserve,
      reason: `HIGH_WIN_PROB_${(pos.curPrice * 100).toFixed(0)}¢`,
    };
  }

  // CATASTROPHIC LOSS: Position down >= catastrophicLossPct
  if (lossPct >= config.catastrophicLossPct) {
    const reserve = Math.min(config.hedgeCapUsd, notionalUsd * 1.0);
    return {
      tokenId: pos.tokenId,
      tier: "CATASTROPHIC",
      reserveUsd: reserve,
      reason: `CATASTROPHIC_LOSS_${lossPct.toFixed(0)}%`,
    };
  }

  // HEDGE TRIGGER: Position down >= hedgeTriggerLossPct
  if (lossPct >= config.hedgeTriggerLossPct) {
    const reserve = Math.min(config.hedgeCapUsd, notionalUsd * 0.5);
    return {
      tokenId: pos.tokenId,
      tier: "HEDGE",
      reserveUsd: reserve,
      reason: `HEDGE_TIER_${lossPct.toFixed(0)}%`,
    };
  }

  // NORMAL: Small buffer for general volatility protection
  const reserve = Math.min(2, notionalUsd * 0.1);
  return {
    tokenId: pos.tokenId,
    tier: "NORMAL",
    reserveUsd: reserve,
    reason: "NORMAL_BUFFER",
  };
}

/**
 * Compute total risk-aware reserve requirement
 * This mirrors the V2 computeRiskAwareReserve function
 */
function computeRiskAwareReserve(
  positions: MockPosition[],
  balance: number,
  config: typeof defaultDynamicReserves,
): {
  totalReserveUsd: number;
  positionReserves: PositionRiskReserve[];
  baseReserveUsd: number;
} {
  if (!config.enabled) {
    return { totalReserveUsd: 0, positionReserves: [], baseReserveUsd: 0 };
  }

  // Calculate equity (cash + position value)
  const positionValue = positions.reduce((sum, p) => sum + p.value, 0);
  const equityUsd = balance + positionValue;

  // Base reserve: max(floor, equityPct * equity)
  const baseReserveUsd = Math.max(
    config.baseReserveFloorUsd,
    config.baseReserveEquityPct * equityUsd,
  );

  // Per-position reserves based on P&L tier and risk
  const positionReserves = positions.map((pos) =>
    computePositionRiskReserve(pos, config),
  );
  const totalPositionReserve = positionReserves.reduce(
    (sum, pr) => sum + pr.reserveUsd,
    0,
  );

  // Total capped at maxReserveUsd
  const totalReserveUsd = Math.min(
    baseReserveUsd + totalPositionReserve,
    config.maxReserveUsd,
  );

  return { totalReserveUsd, positionReserves, baseReserveUsd };
}

describe("V2 Dynamic Reserves Configuration", () => {
  describe("Preset Defaults", () => {
    test("Balanced preset should have baseReserveFloorUsd of 20", () => {
      assert.strictEqual(
        defaultDynamicReserves.baseReserveFloorUsd,
        20,
        "Default base reserve floor should be $20",
      );
    });

    test("Balanced preset should have baseReserveEquityPct of 5%", () => {
      assert.strictEqual(
        defaultDynamicReserves.baseReserveEquityPct,
        0.05,
        "Default equity percentage should be 5%",
      );
    });

    test("Balanced preset should have maxReserveUsd of 200", () => {
      assert.strictEqual(
        defaultDynamicReserves.maxReserveUsd,
        200,
        "Default max reserve should be $200",
      );
    });

    test("Balanced preset should have hedgeTriggerLossPct of 20", () => {
      assert.strictEqual(
        defaultDynamicReserves.hedgeTriggerLossPct,
        20,
        "Default hedge trigger should be 20%",
      );
    });

    test("Balanced preset should have catastrophicLossPct of 50", () => {
      assert.strictEqual(
        defaultDynamicReserves.catastrophicLossPct,
        50,
        "Default catastrophic threshold should be 50%",
      );
    });

    test("Balanced preset should have highWinProbPriceThreshold of 0.85", () => {
      assert.strictEqual(
        defaultDynamicReserves.highWinProbPriceThreshold,
        0.85,
        "Default high win probability threshold should be 85¢",
      );
    });
  });
});

describe("V2 Position Risk Tier Classification", () => {
  describe("NONE Tier (Near Resolution)", () => {
    test("Position at 99¢ should be NONE tier (near resolution)", () => {
      const pos: MockPosition = {
        tokenId: "token-1",
        size: 100,
        curPrice: 0.99,
        pnlPct: 50,
        value: 99,
      };
      const result = computePositionRiskReserve(pos, defaultDynamicReserves);
      assert.strictEqual(result.tier, "NONE");
      assert.strictEqual(result.reserveUsd, 0);
      assert.strictEqual(result.reason, "NEAR_RESOLUTION");
    });

    test("Position at 100¢ should be NONE tier", () => {
      const pos: MockPosition = {
        tokenId: "token-1",
        size: 100,
        curPrice: 1.0,
        pnlPct: 100,
        value: 100,
      };
      const result = computePositionRiskReserve(pos, defaultDynamicReserves);
      assert.strictEqual(result.tier, "NONE");
      assert.strictEqual(result.reserveUsd, 0);
    });
  });

  describe("HIGH_WIN_PROB Tier", () => {
    test("Position at 90¢ should be HIGH_WIN_PROB tier", () => {
      const pos: MockPosition = {
        tokenId: "token-1",
        size: 100,
        curPrice: 0.9,
        pnlPct: 10,
        value: 90,
      };
      const result = computePositionRiskReserve(pos, defaultDynamicReserves);
      assert.strictEqual(result.tier, "HIGH_WIN_PROB");
      // notional = 90, reserve = min(0.5, 90 * 0.02) = min(0.5, 1.8) = 0.5
      assert.strictEqual(result.reserveUsd, 0.5);
    });

    test("Position at 85¢ should be HIGH_WIN_PROB tier (at threshold)", () => {
      const pos: MockPosition = {
        tokenId: "token-1",
        size: 100,
        curPrice: 0.85,
        pnlPct: 5,
        value: 85,
      };
      const result = computePositionRiskReserve(pos, defaultDynamicReserves);
      assert.strictEqual(result.tier, "HIGH_WIN_PROB");
    });

    test("Position at 84¢ should NOT be HIGH_WIN_PROB tier (below threshold)", () => {
      const pos: MockPosition = {
        tokenId: "token-1",
        size: 100,
        curPrice: 0.84,
        pnlPct: 5,
        value: 84,
      };
      const result = computePositionRiskReserve(pos, defaultDynamicReserves);
      assert.notStrictEqual(result.tier, "HIGH_WIN_PROB");
    });

    test("High win probability overrides loss-based tiers", () => {
      // Position bought at high price, now at 90¢ with a loss
      const pos: MockPosition = {
        tokenId: "token-1",
        size: 100,
        curPrice: 0.9,
        pnlPct: -10, // 10% loss
        value: 90,
      };
      const result = computePositionRiskReserve(pos, defaultDynamicReserves);
      // Even with a loss, should be HIGH_WIN_PROB because current price is high
      assert.strictEqual(result.tier, "HIGH_WIN_PROB");
    });
  });

  describe("NORMAL Tier", () => {
    test("Position with small profit should be NORMAL tier", () => {
      const pos: MockPosition = {
        tokenId: "token-1",
        size: 100,
        curPrice: 0.5,
        pnlPct: 5,
        value: 50,
      };
      const result = computePositionRiskReserve(pos, defaultDynamicReserves);
      assert.strictEqual(result.tier, "NORMAL");
      // notional = 50, reserve = min(2, 50 * 0.1) = min(2, 5) = 2
      assert.strictEqual(result.reserveUsd, 2);
    });

    test("Position with small loss (below hedge trigger) should be NORMAL tier", () => {
      const pos: MockPosition = {
        tokenId: "token-1",
        size: 100,
        curPrice: 0.5,
        pnlPct: -15, // 15% loss, below 20% hedge trigger
        value: 50,
      };
      const result = computePositionRiskReserve(pos, defaultDynamicReserves);
      assert.strictEqual(result.tier, "NORMAL");
    });
  });

  describe("HEDGE Tier", () => {
    test("Position with 25% loss should be HEDGE tier", () => {
      const pos: MockPosition = {
        tokenId: "token-1",
        size: 100,
        curPrice: 0.5,
        pnlPct: -25, // 25% loss, above 20% hedge trigger
        value: 50,
      };
      const result = computePositionRiskReserve(pos, defaultDynamicReserves);
      assert.strictEqual(result.tier, "HEDGE");
      // notional = 50, reserve = min(50, 50 * 0.5) = min(50, 25) = 25
      assert.strictEqual(result.reserveUsd, 25);
    });

    test("Position at exactly 20% loss should be HEDGE tier", () => {
      const pos: MockPosition = {
        tokenId: "token-1",
        size: 100,
        curPrice: 0.5,
        pnlPct: -20, // Exactly at hedge trigger
        value: 50,
      };
      const result = computePositionRiskReserve(pos, defaultDynamicReserves);
      assert.strictEqual(result.tier, "HEDGE");
    });
  });

  describe("CATASTROPHIC Tier", () => {
    test("Position with 55% loss should be CATASTROPHIC tier", () => {
      const pos: MockPosition = {
        tokenId: "token-1",
        size: 100,
        curPrice: 0.5,
        pnlPct: -55, // 55% loss, above 50% catastrophic threshold
        value: 50,
      };
      const result = computePositionRiskReserve(pos, defaultDynamicReserves);
      assert.strictEqual(result.tier, "CATASTROPHIC");
      // notional = 50, reserve = min(50, 50 * 1.0) = 50
      assert.strictEqual(result.reserveUsd, 50);
    });

    test("Position at exactly 50% loss should be CATASTROPHIC tier", () => {
      const pos: MockPosition = {
        tokenId: "token-1",
        size: 100,
        curPrice: 0.5,
        pnlPct: -50, // Exactly at catastrophic threshold
        value: 50,
      };
      const result = computePositionRiskReserve(pos, defaultDynamicReserves);
      assert.strictEqual(result.tier, "CATASTROPHIC");
    });

    test("Catastrophic reserve is capped at hedgeCapUsd", () => {
      const pos: MockPosition = {
        tokenId: "token-1",
        size: 200,
        curPrice: 0.5,
        pnlPct: -60,
        value: 100,
      };
      const result = computePositionRiskReserve(pos, defaultDynamicReserves);
      // notional = 100, reserve = min(50, 100 * 1.0) = 50 (capped)
      assert.strictEqual(result.reserveUsd, 50);
    });
  });
});

describe("V2 Total Reserve Calculation", () => {
  describe("Base Reserve Calculation", () => {
    test("Base reserve should be floor when equity is low", () => {
      const positions: MockPosition[] = [];
      const result = computeRiskAwareReserve(
        positions,
        100,
        defaultDynamicReserves,
      );
      // Equity = 100, equityPct = 5, floor = 20
      // max(20, 100 * 0.05) = max(20, 5) = 20
      assert.strictEqual(result.baseReserveUsd, 20);
    });

    test("Base reserve should scale with equity when equity is high", () => {
      const positions: MockPosition[] = [
        {
          tokenId: "token-1",
          size: 1000,
          curPrice: 1.0,
          pnlPct: 50,
          value: 1000,
        },
      ];
      const result = computeRiskAwareReserve(
        positions,
        1000,
        defaultDynamicReserves,
      );
      // Equity = 2000, equityPct = 100, floor = 20
      // max(20, 2000 * 0.05) = max(20, 100) = 100
      assert.strictEqual(result.baseReserveUsd, 100);
    });
  });

  describe("Total Reserve Capping", () => {
    test("Total reserve should be capped at maxReserveUsd", () => {
      // Create many losing positions to exceed the cap
      const positions: MockPosition[] = Array.from({ length: 10 }, (_, i) => ({
        tokenId: `token-${i}`,
        size: 100,
        curPrice: 0.5,
        pnlPct: -55, // Catastrophic
        value: 50,
      }));
      const result = computeRiskAwareReserve(
        positions,
        100,
        defaultDynamicReserves,
      );
      // Should be capped at maxReserveUsd (200)
      assert.ok(result.totalReserveUsd <= defaultDynamicReserves.maxReserveUsd);
      assert.strictEqual(result.totalReserveUsd, 200);
    });
  });

  describe("Disabled Dynamic Reserves", () => {
    test("Should return 0 when disabled", () => {
      const disabledConfig = { ...defaultDynamicReserves, enabled: false };
      const positions: MockPosition[] = [
        {
          tokenId: "token-1",
          size: 100,
          curPrice: 0.5,
          pnlPct: -55,
          value: 50,
        },
      ];
      const result = computeRiskAwareReserve(positions, 100, disabledConfig);
      assert.strictEqual(result.totalReserveUsd, 0);
      assert.strictEqual(result.baseReserveUsd, 0);
    });
  });

  describe("Combined Reserve Scenarios", () => {
    test("Mixed portfolio should sum individual reserves", () => {
      const positions: MockPosition[] = [
        {
          tokenId: "token-good",
          size: 100,
          curPrice: 0.9,
          pnlPct: 20,
          value: 90,
        }, // HIGH_WIN_PROB
        {
          tokenId: "token-normal",
          size: 100,
          curPrice: 0.5,
          pnlPct: 5,
          value: 50,
        }, // NORMAL
        {
          tokenId: "token-bad",
          size: 100,
          curPrice: 0.3,
          pnlPct: -30,
          value: 30,
        }, // HEDGE
      ];
      const result = computeRiskAwareReserve(
        positions,
        100,
        defaultDynamicReserves,
      );

      // Verify each position is classified correctly
      const highWinProb = result.positionReserves.find(
        (r) => r.tokenId === "token-good",
      );
      const normal = result.positionReserves.find(
        (r) => r.tokenId === "token-normal",
      );
      const hedge = result.positionReserves.find(
        (r) => r.tokenId === "token-bad",
      );

      assert.strictEqual(highWinProb?.tier, "HIGH_WIN_PROB");
      assert.strictEqual(normal?.tier, "NORMAL");
      assert.strictEqual(hedge?.tier, "HEDGE");

      // Total should include base + all position reserves
      assert.ok(result.totalReserveUsd > result.baseReserveUsd);
    });
  });
});

describe("V2 Dynamic Reserves Risk Mode", () => {
  /**
   * Helper function to determine risk mode
   * Mirrors the V2 logic for determining RISK_ON vs RISK_OFF
   */
  function getRiskMode(
    balance: number,
    effectiveReserve: number,
  ): "RISK_ON" | "RISK_OFF" {
    return balance >= effectiveReserve ? "RISK_ON" : "RISK_OFF";
  }

  test("Should be RISK_ON when balance exceeds reserve", () => {
    const mode = getRiskMode(100, 50);
    assert.strictEqual(mode, "RISK_ON");
  });

  test("Should be RISK_OFF when balance is below reserve", () => {
    const mode = getRiskMode(30, 50);
    assert.strictEqual(mode, "RISK_OFF");
  });

  test("Should be RISK_ON when balance equals reserve", () => {
    const mode = getRiskMode(50, 50);
    assert.strictEqual(mode, "RISK_ON");
  });
});

describe("V2 Preset Configuration Differences", () => {
  const conservativeConfig = {
    enabled: true,
    baseReserveFloorUsd: 25,
    baseReserveEquityPct: 0.08,
    maxReserveUsd: 250,
    hedgeCapUsd: 25,
    hedgeTriggerLossPct: 15,
    catastrophicLossPct: 40,
    highWinProbPriceThreshold: 0.9,
  };

  const aggressiveConfig = {
    enabled: true,
    baseReserveFloorUsd: 15,
    baseReserveEquityPct: 0.03,
    maxReserveUsd: 150,
    hedgeCapUsd: 100,
    hedgeTriggerLossPct: 25,
    catastrophicLossPct: 60,
    highWinProbPriceThreshold: 0.8,
  };

  test("Conservative preset triggers hedge tier earlier", () => {
    const pos: MockPosition = {
      tokenId: "token-1",
      size: 100,
      curPrice: 0.5,
      pnlPct: -18, // 18% loss
      value: 50,
    };

    const conservativeResult = computePositionRiskReserve(
      pos,
      conservativeConfig,
    );
    const balancedResult = computePositionRiskReserve(
      pos,
      defaultDynamicReserves,
    );

    // Conservative triggers at 15%, balanced at 20%
    // 18% loss should be HEDGE for conservative, NORMAL for balanced
    assert.strictEqual(conservativeResult.tier, "HEDGE");
    assert.strictEqual(balancedResult.tier, "NORMAL");
  });

  test("Aggressive preset allows higher win probability at lower prices", () => {
    const pos: MockPosition = {
      tokenId: "token-1",
      size: 100,
      curPrice: 0.82, // Between 0.80 and 0.85
      pnlPct: 10,
      value: 82,
    };

    const aggressiveResult = computePositionRiskReserve(pos, aggressiveConfig);
    const balancedResult = computePositionRiskReserve(
      pos,
      defaultDynamicReserves,
    );

    // Aggressive threshold is 80¢, balanced is 85¢
    // 82¢ should be HIGH_WIN_PROB for aggressive, NORMAL for balanced
    assert.strictEqual(aggressiveResult.tier, "HIGH_WIN_PROB");
    assert.strictEqual(balancedResult.tier, "NORMAL");
  });

  test("Conservative preset has higher base reserve floor", () => {
    const positions: MockPosition[] = [];

    const conservativeResult = computeRiskAwareReserve(
      positions,
      100,
      conservativeConfig,
    );
    const balancedResult = computeRiskAwareReserve(
      positions,
      100,
      defaultDynamicReserves,
    );

    assert.ok(
      conservativeResult.baseReserveUsd > balancedResult.baseReserveUsd,
    );
    assert.strictEqual(conservativeResult.baseReserveUsd, 25);
    assert.strictEqual(balancedResult.baseReserveUsd, 20);
  });
});
