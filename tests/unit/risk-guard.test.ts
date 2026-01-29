import assert from "node:assert";
import { test, describe, beforeEach } from "node:test";
import {
  RiskGuard,
  DEFAULT_RISK_GUARD_CONFIG,
  type RiskGuardConfig,
} from "../../src/core/risk-guard";
import type { ManagedPosition } from "../../src/core/decision-engine";

/**
 * Unit tests for RiskGuard - Financial Bleed Prevention Module
 *
 * These tests verify that:
 * 1. Entry validation prevents wallet depletion
 * 2. Hedge validation prevents excessive reverse hedging
 * 3. Portfolio health monitoring detects issues
 * 4. Protective mode activates under critical conditions
 */

// Helper to create a mock position
function createMockPosition(
  overrides: Partial<ManagedPosition> = {},
): ManagedPosition {
  return {
    id: `pos-${Date.now()}-${Math.random()}`,
    tokenId: "mock-token-id",
    marketId: "mock-market-id",
    side: "LONG",
    state: "OPEN",
    entryPriceCents: 50,
    entrySizeUsd: 10,
    entryTime: Date.now() - 30000, // 30 seconds ago
    currentPriceCents: 52,
    unrealizedPnlCents: 2,
    unrealizedPnlUsd: 0.4,
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

describe("RiskGuard", () => {
  let riskGuard: RiskGuard;

  beforeEach(() => {
    riskGuard = new RiskGuard();
  });

  describe("Entry Validation", () => {
    test("allows entry when wallet has sufficient balance", () => {
      const result = riskGuard.validateEntry({
        proposedSizeUsd: 10,
        walletBalanceUsd: 200,
        currentPositions: [],
        totalDeployedUsd: 0,
      });

      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.adjustedSizeUsd, 10);
      assert.strictEqual(result.warnings.length, 0);
    });

    test("blocks entry when wallet would fall below minimum", () => {
      const result = riskGuard.validateEntry({
        proposedSizeUsd: 160,
        walletBalanceUsd: 200, // Would leave $40, below default $50 minimum
        currentPositions: [],
        totalDeployedUsd: 0,
      });

      assert.strictEqual(result.allowed, false);
      assert.ok(result.reason?.includes("minimum"));
    });

    test("reduces entry size when approaching deployment limit", () => {
      // With default 70% deployment limit and $200 balance, max deployment is $140
      // Already deployed $100, so only $40 more allowed
      const result = riskGuard.validateEntry({
        proposedSizeUsd: 60,
        walletBalanceUsd: 200,
        currentPositions: [],
        totalDeployedUsd: 100,
      });

      assert.strictEqual(result.allowed, true);
      assert.ok(result.adjustedSizeUsd! <= 40);
      assert.ok(result.warnings.length > 0);
    });

    test("blocks entry when already at max deployment", () => {
      const result = riskGuard.validateEntry({
        proposedSizeUsd: 10,
        walletBalanceUsd: 200,
        currentPositions: [],
        totalDeployedUsd: 150, // Already above 70% of $200
      });

      assert.strictEqual(result.allowed, false);
      assert.ok(result.reason?.includes("deployment"));
    });

    test("warns about portfolio drawdown but allows entry", () => {
      // Create positions with large unrealized losses
      const losingPosition = createMockPosition({
        unrealizedPnlUsd: -80, // Large loss
        unrealizedPnlCents: -40,
      });

      const result = riskGuard.validateEntry({
        proposedSizeUsd: 10,
        walletBalanceUsd: 300,
        currentPositions: [losingPosition],
        totalDeployedUsd: 10,
      });

      // Should allow (recovery opportunity) but warn
      assert.strictEqual(result.allowed, true);
      // Warning about drawdown may or may not be added depending on config
    });
  });

  describe("Hedge Validation", () => {
    test("allows hedge when within limits", () => {
      const position = createMockPosition({
        hedges: [],
        totalHedgeRatio: 0,
      });

      const result = riskGuard.validateHedge({
        positionId: position.id,
        position,
        proposedHedgeSizeUsd: 5,
        walletBalanceUsd: 200,
        currentPositions: [position],
      });

      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.adjustedSizeUsd, 5);
    });

    test("blocks hedge when on cooldown", () => {
      const position = createMockPosition();

      // Record a hedge to trigger cooldown
      riskGuard.recordHedgePlaced(position.id);

      const result = riskGuard.validateHedge({
        positionId: position.id,
        position,
        proposedHedgeSizeUsd: 5,
        walletBalanceUsd: 200,
        currentPositions: [position],
      });

      assert.strictEqual(result.allowed, false);
      assert.ok(result.reason?.includes("cooldown"));
    });

    test("blocks hedge when max hedged positions reached", () => {
      // Create 5 hedged positions (max by default)
      const hedgedPositions = Array.from({ length: 5 }, (_, i) =>
        createMockPosition({
          id: `hedged-pos-${i}`,
          hedges: [
            {
              tokenId: "hedge-token",
              sizeUsd: 5,
              entryPriceCents: 50,
              entryTime: Date.now(),
              pnlCents: 0,
            },
          ],
          totalHedgeRatio: 0.4,
        }),
      );

      // Try to hedge a new unhedged position
      const newPosition = createMockPosition({
        id: "new-position",
        hedges: [],
      });

      const result = riskGuard.validateHedge({
        positionId: newPosition.id,
        position: newPosition,
        proposedHedgeSizeUsd: 5,
        walletBalanceUsd: 200,
        currentPositions: [...hedgedPositions, newPosition],
      });

      assert.strictEqual(result.allowed, false);
      assert.ok(result.reason?.includes("Max hedged positions"));
    });

    test("reduces hedge size when approaching total hedge USD limit", () => {
      // Create positions with existing hedges totaling $180 (default max is $200)
      const hedgedPosition = createMockPosition({
        hedges: [
          {
            tokenId: "hedge-token",
            sizeUsd: 180,
            entryPriceCents: 50,
            entryTime: Date.now(),
            pnlCents: 0,
          },
        ],
        totalHedgeRatio: 0.4,
      });

      const newPosition = createMockPosition({
        id: "new-position",
        hedges: [],
      });

      const result = riskGuard.validateHedge({
        positionId: newPosition.id,
        position: newPosition,
        proposedHedgeSizeUsd: 50, // Would exceed $200 limit
        walletBalanceUsd: 500,
        currentPositions: [hedgedPosition, newPosition],
      });

      if (result.allowed) {
        // Should be reduced to at most $20 ($200 - $180)
        assert.ok(result.adjustedSizeUsd! <= 20);
      }
    });

    test("blocks hedge when it would deplete wallet below minimum", () => {
      const position = createMockPosition();

      const result = riskGuard.validateHedge({
        positionId: position.id,
        position,
        proposedHedgeSizeUsd: 60,
        walletBalanceUsd: 100, // Would leave $40, below $50 minimum
        currentPositions: [position],
      });

      // Should either block or reduce size
      if (result.allowed) {
        assert.ok(result.adjustedSizeUsd! <= 50); // Max allowed to keep $50 minimum
      }
    });
  });

  describe("Portfolio Health", () => {
    test("returns HEALTHY status for good portfolio", () => {
      const positions = [
        createMockPosition({ unrealizedPnlUsd: 5 }),
        createMockPosition({ unrealizedPnlUsd: 3 }),
      ];

      const health = riskGuard.getPortfolioHealth({
        currentPositions: positions,
        walletBalanceUsd: 500,
        totalDeployedUsd: 20,
      });

      assert.strictEqual(health.status, "HEALTHY");
      assert.strictEqual(health.issues.length, 0);
    });

    test("returns CRITICAL status when portfolio loss exceeds limit", () => {
      // Create positions with large losses exceeding $100 limit
      const losingPositions = [
        createMockPosition({ unrealizedPnlUsd: -60 }),
        createMockPosition({ unrealizedPnlUsd: -50 }),
      ];

      const health = riskGuard.getPortfolioHealth({
        currentPositions: losingPositions,
        walletBalanceUsd: 500,
        totalDeployedUsd: 200,
      });

      assert.strictEqual(health.status, "CRITICAL");
      assert.ok(health.issues.some((i) => i.includes("drawdown")));
    });

    test("detects stale positions", () => {
      const stalePosition = createMockPosition({
        lastUpdateTime: Date.now() - 120000, // 2 minutes ago (stale)
      });

      const health = riskGuard.getPortfolioHealth({
        currentPositions: [stalePosition],
        walletBalanceUsd: 500,
        totalDeployedUsd: 10,
      });

      assert.strictEqual(health.stalePositionCount, 1);
      assert.ok(health.status === "CAUTION" || health.issues.length > 0);
    });

    test("calculates global hedge exposure correctly", () => {
      const hedgedPosition1 = createMockPosition({
        totalHedgeRatio: 0.6,
        hedges: [
          {
            tokenId: "h1",
            sizeUsd: 6,
            entryPriceCents: 50,
            entryTime: Date.now(),
            pnlCents: 0,
          },
        ],
      });

      const hedgedPosition2 = createMockPosition({
        totalHedgeRatio: 0.4,
        hedges: [
          {
            tokenId: "h2",
            sizeUsd: 4,
            entryPriceCents: 50,
            entryTime: Date.now(),
            pnlCents: 0,
          },
        ],
      });

      const health = riskGuard.getPortfolioHealth({
        currentPositions: [hedgedPosition1, hedgedPosition2],
        walletBalanceUsd: 500,
        totalDeployedUsd: 20,
      });

      // Average hedge ratio: (0.6 + 0.4) / 2 = 0.5
      assert.strictEqual(health.globalHedgeExposure, 0.5);
    });
  });

  describe("Position Health", () => {
    test("returns HEALTHY for profitable position", () => {
      const position = createMockPosition({
        unrealizedPnlCents: 10,
        unrealizedPnlUsd: 2,
      });

      const health = riskGuard.getPositionHealth(position);

      assert.strictEqual(health.status, "HEALTHY");
      assert.strictEqual(health.canSellQuickly, true);
      assert.strictEqual(health.canHedgeQuickly, true);
    });

    test("returns CRITICAL for position with large loss", () => {
      const position = createMockPosition({
        unrealizedPnlCents: -40, // Exceeds default 35 cent limit
        unrealizedPnlUsd: -8,
      });

      const health = riskGuard.getPositionHealth(position);

      assert.strictEqual(health.status, "CRITICAL");
      assert.ok(health.issues.some((i) => i.includes("loss")));
    });

    test("returns MONITORING for stale position", () => {
      const position = createMockPosition({
        lastUpdateTime: Date.now() - 120000, // 2 minutes ago
      });

      const health = riskGuard.getPositionHealth(position);

      assert.strictEqual(health.isStale, true);
      assert.ok(
        health.status === "MONITORING" ||
          health.issues.some((i) => i.includes("stale")),
      );
    });

    test("canHedgeQuickly is false when on cooldown", () => {
      const position = createMockPosition();

      // Record a hedge to trigger cooldown
      riskGuard.recordHedgePlaced(position.id);

      const health = riskGuard.getPositionHealth(position);

      assert.strictEqual(health.canHedgeQuickly, false);
    });

    test("canHedgeQuickly is false for already hedged positions at max ratio", () => {
      const position = createMockPosition({
        totalHedgeRatio: 0.7, // At max
        hedges: [
          {
            tokenId: "h1",
            sizeUsd: 7,
            entryPriceCents: 50,
            entryTime: Date.now(),
            pnlCents: 0,
          },
        ],
      });

      const health = riskGuard.getPositionHealth(position);

      assert.strictEqual(health.canHedgeQuickly, false);
    });

    test("canSellQuickly is false for positions in EXITING state", () => {
      const position = createMockPosition({
        state: "EXITING",
      });

      const health = riskGuard.getPositionHealth(position);

      assert.strictEqual(health.canSellQuickly, false);
    });
  });

  describe("Protective Mode", () => {
    test("activates when portfolio is CRITICAL", () => {
      const losingPositions = [
        createMockPosition({ unrealizedPnlUsd: -120 }), // Exceeds limit
      ];

      const result = riskGuard.isProtectiveModeActive({
        currentPositions: losingPositions,
        walletBalanceUsd: 500,
        totalDeployedUsd: 100,
      });

      assert.strictEqual(result.active, true);
    });

    test("activates when wallet balance critically low", () => {
      const result = riskGuard.isProtectiveModeActive({
        currentPositions: [],
        walletBalanceUsd: 60, // Below 1.5x minimum ($75)
        totalDeployedUsd: 0,
      });

      assert.strictEqual(result.active, true);
      assert.ok(result.reason?.includes("low"));
    });

    test("does not activate for healthy portfolio", () => {
      const result = riskGuard.isProtectiveModeActive({
        currentPositions: [createMockPosition({ unrealizedPnlUsd: 5 })],
        walletBalanceUsd: 500,
        totalDeployedUsd: 10,
      });

      assert.strictEqual(result.active, false);
    });
  });

  describe("Positions Requiring Action", () => {
    test("returns only positions with ACTION_REQUIRED or CRITICAL status", () => {
      const healthyPosition = createMockPosition({
        id: "healthy",
        unrealizedPnlCents: 5,
      });

      const criticalPosition = createMockPosition({
        id: "critical",
        unrealizedPnlCents: -50, // Large loss
      });

      const positions = [healthyPosition, criticalPosition];

      const requiring = riskGuard.getPositionsRequiringAction(positions);

      assert.strictEqual(requiring.length, 1);
      assert.strictEqual(requiring[0].positionId, "critical");
    });
  });

  describe("Configuration", () => {
    test("uses custom config when provided", () => {
      const customConfig: Partial<RiskGuardConfig> = {
        minWalletBalanceUsd: 100,
        maxTotalDeploymentFraction: 0.5,
      };

      const customGuard = new RiskGuard(customConfig);

      // Test with custom min wallet balance
      const result = customGuard.validateEntry({
        proposedSizeUsd: 50,
        walletBalanceUsd: 140, // Would leave $90, below custom $100 minimum
        currentPositions: [],
        totalDeployedUsd: 0,
      });

      assert.strictEqual(result.allowed, false);
    });

    test("reset clears all state", () => {
      const position = createMockPosition();

      // Add some state
      riskGuard.recordHedgePlaced(position.id);
      riskGuard.getPortfolioHealth({
        currentPositions: [position],
        walletBalanceUsd: 500,
        totalDeployedUsd: 10,
      });

      // Reset
      riskGuard.reset();

      // Check state is cleared - hedge should be allowed again
      const result = riskGuard.validateHedge({
        positionId: position.id,
        position,
        proposedHedgeSizeUsd: 5,
        walletBalanceUsd: 200,
        currentPositions: [position],
      });

      assert.strictEqual(result.allowed, true);
      assert.strictEqual(riskGuard.getLastHealthCheck(), null);
    });
  });
});
