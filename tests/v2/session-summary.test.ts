import assert from "node:assert";
import { test, describe } from "node:test";

/**
 * Unit tests for V2 Session Summary with Unrealized P&L
 *
 * These tests verify that:
 * 1. Position stats are correctly calculated (winners, losers, breakeven)
 * 2. Unrealized P&L is computed from cost basis vs current value
 * 3. Edge cases are handled (no positions, all winners, all losers)
 */

// Mock position type matching the V2 Position interface
interface MockPosition {
  tokenId: string;
  conditionId: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  pnlPct: number;
  gainCents: number;
  value: number;
}

// Helper function that mirrors the V2 getLedgerSummary position stats logic
function computePositionStats(positions: MockPosition[]): {
  totalCost: number;
  unrealizedPnl: number;
  winners: number;
  losers: number;
  breakeven: number;
  winnerValue: number;
  loserValue: number;
} {
  return positions.reduce(
    (acc, p) => {
      const cost = p.size * p.avgPrice;
      const unrealizedPnl = p.value - cost;
      acc.totalCost += cost;
      acc.unrealizedPnl += unrealizedPnl;
      if (p.pnlPct > 0) {
        acc.winners++;
        acc.winnerValue += unrealizedPnl;
      } else if (p.pnlPct < 0) {
        acc.losers++;
        acc.loserValue += unrealizedPnl;
      } else {
        acc.breakeven++;
      }
      return acc;
    },
    {
      totalCost: 0,
      unrealizedPnl: 0,
      winners: 0,
      losers: 0,
      breakeven: 0,
      winnerValue: 0,
      loserValue: 0,
    },
  );
}

// Helper to create a mock position
function createMockPosition(
  overrides: Partial<MockPosition> = {},
): MockPosition {
  const size = overrides.size ?? 100;
  const avgPrice = overrides.avgPrice ?? 0.5;
  const curPrice = overrides.curPrice ?? 0.6;
  const cost = size * avgPrice;
  const value = size * curPrice;
  const pnlPct = cost > 0 ? ((value - cost) / cost) * 100 : 0;

  return {
    tokenId: `token-${Math.random().toString(36).slice(2, 8)}`,
    conditionId: `condition-${Math.random().toString(36).slice(2, 8)}`,
    outcome: "YES",
    size,
    avgPrice,
    curPrice,
    pnlPct: overrides.pnlPct ?? pnlPct,
    gainCents: (curPrice - avgPrice) * 100,
    value: overrides.value ?? value,
    ...overrides,
  };
}

describe("V2 Session Summary Position Stats", () => {
  describe("Basic Position Stats Calculation", () => {
    test("single winning position should be counted as winner", () => {
      const positions = [
        createMockPosition({
          size: 100,
          avgPrice: 0.5, // Cost: $50
          curPrice: 0.7, // Value: $70
          pnlPct: 40, // 40% gain
        }),
      ];

      const stats = computePositionStats(positions);

      assert.strictEqual(stats.winners, 1, "Should have 1 winner");
      assert.strictEqual(stats.losers, 0, "Should have 0 losers");
      assert.strictEqual(stats.breakeven, 0, "Should have 0 breakeven");
      assert.strictEqual(stats.totalCost, 50, "Cost should be $50");
      assert.strictEqual(
        stats.unrealizedPnl,
        20,
        "Unrealized P&L should be $20",
      );
      assert.strictEqual(
        stats.winnerValue,
        20,
        "Winner value should be $20 gain",
      );
    });

    test("single losing position should be counted as loser", () => {
      const positions = [
        createMockPosition({
          size: 100,
          avgPrice: 0.6, // Cost: $60
          curPrice: 0.4, // Value: $40
          pnlPct: -33.33, // ~33% loss
          value: 40,
        }),
      ];

      const stats = computePositionStats(positions);

      assert.strictEqual(stats.winners, 0, "Should have 0 winners");
      assert.strictEqual(stats.losers, 1, "Should have 1 loser");
      assert.strictEqual(stats.breakeven, 0, "Should have 0 breakeven");
      assert.strictEqual(stats.totalCost, 60, "Cost should be $60");
      assert.strictEqual(
        stats.unrealizedPnl,
        -20,
        "Unrealized P&L should be -$20",
      );
      assert.strictEqual(
        stats.loserValue,
        -20,
        "Loser value should be -$20 loss",
      );
    });

    test("breakeven position should be counted separately", () => {
      const positions = [
        createMockPosition({
          size: 100,
          avgPrice: 0.5, // Cost: $50
          curPrice: 0.5, // Value: $50
          pnlPct: 0, // 0% gain/loss
          value: 50,
        }),
      ];

      const stats = computePositionStats(positions);

      assert.strictEqual(stats.winners, 0, "Should have 0 winners");
      assert.strictEqual(stats.losers, 0, "Should have 0 losers");
      assert.strictEqual(stats.breakeven, 1, "Should have 1 breakeven");
      assert.strictEqual(
        stats.unrealizedPnl,
        0,
        "Unrealized P&L should be $0",
      );
    });
  });

  describe("Multiple Position Stats", () => {
    test("mixed positions should sum correctly", () => {
      // Example from the issue: 20 positions with various P&L
      // Simulate a profitable portfolio with mix of winners and losers
      const positions = [
        // 12 winners
        ...Array(12)
          .fill(null)
          .map((_, i) =>
            createMockPosition({
              tokenId: `winner-${i}`,
              size: 100,
              avgPrice: 0.4,
              curPrice: 0.55,
              pnlPct: 37.5, // 37.5% gain
              value: 55,
            }),
          ),
        // 6 losers
        ...Array(6)
          .fill(null)
          .map((_, i) =>
            createMockPosition({
              tokenId: `loser-${i}`,
              size: 50,
              avgPrice: 0.6,
              curPrice: 0.4,
              pnlPct: -33.33, // ~33% loss
              value: 20,
            }),
          ),
        // 2 breakeven
        ...Array(2)
          .fill(null)
          .map((_, i) =>
            createMockPosition({
              tokenId: `breakeven-${i}`,
              size: 100,
              avgPrice: 0.5,
              curPrice: 0.5,
              pnlPct: 0,
              value: 50,
            }),
          ),
      ];

      const stats = computePositionStats(positions);

      assert.strictEqual(stats.winners, 12, "Should have 12 winners");
      assert.strictEqual(stats.losers, 6, "Should have 6 losers");
      assert.strictEqual(stats.breakeven, 2, "Should have 2 breakeven");

      // Winners: 12 * (55 - 40) = 12 * 15 = $180 gain
      // Losers: 6 * (20 - 30) = 6 * -10 = -$60 loss
      // Net unrealized: $180 - $60 = $120
      const expectedWinnerValue = 12 * (55 - 40);
      const expectedLoserValue = 6 * (20 - 30);
      const expectedUnrealizedPnl = expectedWinnerValue + expectedLoserValue;

      assert.strictEqual(
        stats.winnerValue,
        expectedWinnerValue,
        `Winner value should be $${expectedWinnerValue}`,
      );
      assert.strictEqual(
        stats.loserValue,
        expectedLoserValue,
        `Loser value should be $${expectedLoserValue}`,
      );
      assert.strictEqual(
        stats.unrealizedPnl,
        expectedUnrealizedPnl,
        `Total unrealized P&L should be $${expectedUnrealizedPnl}`,
      );
    });

    test("all winners should have positive unrealized P&L", () => {
      const positions = Array(5)
        .fill(null)
        .map((_, i) =>
          createMockPosition({
            tokenId: `winner-${i}`,
            size: 100,
            avgPrice: 0.3,
            curPrice: 0.8,
            pnlPct: 166.67, // Big winner
            value: 80,
          }),
        );

      const stats = computePositionStats(positions);

      assert.strictEqual(stats.winners, 5, "Should have 5 winners");
      assert.strictEqual(stats.losers, 0, "Should have 0 losers");
      // Each position: cost = 30, value = 80, gain = 50
      assert.strictEqual(stats.unrealizedPnl, 250, "Unrealized P&L = 5 * 50");
      assert.strictEqual(
        stats.winnerValue,
        stats.unrealizedPnl,
        "All gains should be from winners",
      );
    });

    test("all losers should have negative unrealized P&L", () => {
      const positions = Array(5)
        .fill(null)
        .map((_, i) =>
          createMockPosition({
            tokenId: `loser-${i}`,
            size: 100,
            avgPrice: 0.7,
            curPrice: 0.2,
            pnlPct: -71.43, // Big loser
            value: 20,
          }),
        );

      const stats = computePositionStats(positions);

      assert.strictEqual(stats.winners, 0, "Should have 0 winners");
      assert.strictEqual(stats.losers, 5, "Should have 5 losers");
      // Each position: cost = 70, value = 20, loss = -50
      assert.strictEqual(stats.unrealizedPnl, -250, "Unrealized P&L = 5 * -50");
      assert.strictEqual(
        stats.loserValue,
        stats.unrealizedPnl,
        "All losses should be from losers",
      );
    });
  });

  describe("Edge Cases", () => {
    test("empty positions array returns zeros", () => {
      const stats = computePositionStats([]);

      assert.strictEqual(stats.winners, 0);
      assert.strictEqual(stats.losers, 0);
      assert.strictEqual(stats.breakeven, 0);
      assert.strictEqual(stats.totalCost, 0);
      assert.strictEqual(stats.unrealizedPnl, 0);
      assert.strictEqual(stats.winnerValue, 0);
      assert.strictEqual(stats.loserValue, 0);
    });

    test("position with zero size has zero impact", () => {
      const positions = [
        createMockPosition({
          size: 0,
          avgPrice: 0.5,
          curPrice: 0.7,
          pnlPct: 40,
          value: 0,
        }),
      ];

      const stats = computePositionStats(positions);

      assert.strictEqual(stats.totalCost, 0, "Zero size = zero cost");
      assert.strictEqual(
        stats.unrealizedPnl,
        0,
        "Zero size = zero unrealized P&L",
      );
      // Note: pnlPct > 0 still counts it as a "winner" even with zero impact
      assert.strictEqual(stats.winners, 1, "Counted as winner by pnlPct");
    });

    test("very small pnlPct close to zero is treated as win/loss correctly", () => {
      const positions = [
        createMockPosition({
          pnlPct: 0.001, // Tiny positive
        }),
        createMockPosition({
          pnlPct: -0.001, // Tiny negative
        }),
      ];

      const stats = computePositionStats(positions);

      assert.strictEqual(
        stats.winners,
        1,
        "Tiny positive pnlPct should be winner",
      );
      assert.strictEqual(
        stats.losers,
        1,
        "Tiny negative pnlPct should be loser",
      );
    });
  });

  describe("Unrealized P&L Percentage Calculation", () => {
    test("unrealized P&L percentage should be calculated from total cost", () => {
      const positions = [
        createMockPosition({
          size: 200,
          avgPrice: 0.5, // Cost: $100
          curPrice: 0.6, // Value: $120
          pnlPct: 20,
          value: 120,
        }),
      ];

      const stats = computePositionStats(positions);
      const unrealizedPct =
        stats.totalCost > 0 ? (stats.unrealizedPnl / stats.totalCost) * 100 : 0;

      assert.strictEqual(stats.totalCost, 100, "Total cost should be $100");
      assert.strictEqual(
        stats.unrealizedPnl,
        20,
        "Unrealized P&L should be $20",
      );
      assert.strictEqual(
        unrealizedPct,
        20,
        "Unrealized P&L pct should be 20%",
      );
    });

    test("handles case where total cost is zero (avoid division by zero)", () => {
      const positions = [
        createMockPosition({
          size: 0,
          avgPrice: 0.5,
          curPrice: 0.7,
          pnlPct: 0,
          value: 0,
        }),
      ];

      const stats = computePositionStats(positions);
      const unrealizedPct =
        stats.totalCost > 0 ? (stats.unrealizedPnl / stats.totalCost) * 100 : 0;

      assert.strictEqual(
        unrealizedPct,
        0,
        "Should handle zero cost gracefully",
      );
    });
  });
});

describe("V2 Session Summary Display Format", () => {
  // Mock the $ (dollar format) function from V2
  function $(amount: number): string {
    return `$${amount.toFixed(2)}`;
  }

  test("unrealized P&L line format for positive gains", () => {
    const stats = { unrealizedPnl: 40.47, totalCost: 200 };
    const unrealizedPct = (stats.unrealizedPnl / stats.totalCost) * 100;
    const sign = stats.unrealizedPnl >= 0 ? "+" : "";

    const line = `💰 Unrealized P&L: ${sign}${$(stats.unrealizedPnl)} (${sign}${unrealizedPct.toFixed(1)}%)`;

    assert.ok(line.includes("+$40.47"), "Should show positive amount with +");
    assert.ok(line.includes("+20.2%"), "Should show positive percentage with +");
  });

  test("unrealized P&L line format for negative losses", () => {
    const stats = { unrealizedPnl: -25.5, totalCost: 100 };
    const unrealizedPct = (stats.unrealizedPnl / stats.totalCost) * 100;
    const sign = stats.unrealizedPnl >= 0 ? "+" : "";

    const line = `💰 Unrealized P&L: ${sign}${$(stats.unrealizedPnl)} (${sign}${unrealizedPct.toFixed(1)}%)`;

    assert.ok(line.includes("$-25.50"), "Should show negative amount");
    assert.ok(line.includes("-25.5%"), "Should show negative percentage");
  });

  test("winners/losers line format", () => {
    const stats = { winners: 12, losers: 6, winnerValue: 180, loserValue: -60 };

    const line = `📈 Winners: ${stats.winners} (+${$(stats.winnerValue)}) | 📉 Losers: ${stats.losers} (${$(stats.loserValue)})`;

    assert.ok(line.includes("Winners: 12"), "Should show winner count");
    assert.ok(line.includes("+$180.00"), "Should show winner value with +");
    assert.ok(line.includes("Losers: 6"), "Should show loser count");
    assert.ok(line.includes("$-60.00"), "Should show loser value as negative");
  });
});
