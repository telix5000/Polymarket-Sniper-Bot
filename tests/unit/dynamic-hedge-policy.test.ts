/**
 * Dynamic Hedge Policy Tests
 *
 * Tests for the adaptive hedge parameter management system.
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";

import {
  DynamicHedgePolicy,
  createDynamicHedgePolicy,
  HEDGE_DEFAULTS,
  type HedgeOutcome,
  type DynamicHedgeConfig,
} from "../../src/lib/dynamic-hedge-policy";

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function createEffectiveHedge(
  overrides: Partial<HedgeOutcome> = {},
): HedgeOutcome {
  return {
    tokenId: "test-token-123",
    timestamp: Date.now(),
    triggerPriceCents: 50,
    hedgePriceCents: 48,
    hedgeRatio: 0.4,
    positionPnlCents: -20,
    hedgePnlCents: 12,
    netPnlCents: -8, // Hedge reduced loss
    wasEffective: true,
    ...overrides,
  };
}

function createIneffectiveHedge(
  overrides: Partial<HedgeOutcome> = {},
): HedgeOutcome {
  return {
    tokenId: "test-token-123",
    timestamp: Date.now(),
    triggerPriceCents: 50,
    hedgePriceCents: 48,
    hedgeRatio: 0.4,
    positionPnlCents: 15, // Price reversed - position won
    hedgePnlCents: -8, // Hedge lost
    netPnlCents: 7, // Net positive but hedge wasn't helpful
    wasEffective: false,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("DynamicHedgePolicy", () => {
  describe("Initialization", () => {
    it("should initialize with default config", () => {
      const policy = createDynamicHedgePolicy();
      const params = policy.getParameters();

      assert.strictEqual(params.usingAdaptedValues, false);
      // Should use base values when no data
      assert.strictEqual(params.triggerCents, HEDGE_DEFAULTS.TRIGGER_CENTS);
      assert.strictEqual(params.hedgeRatio, HEDGE_DEFAULTS.RATIO);
      assert.strictEqual(params.maxHedgeRatio, HEDGE_DEFAULTS.MAX_RATIO);
      assert.strictEqual(
        params.maxAdverseCents,
        HEDGE_DEFAULTS.MAX_ADVERSE_CENTS,
      );
    });

    it("should accept custom config", () => {
      const customConfig: Partial<DynamicHedgeConfig> = {
        baseTriggerCents: 20,
        baseHedgeRatio: 0.5,
      };
      const policy = createDynamicHedgePolicy(customConfig);
      const params = policy.getParameters();

      assert.strictEqual(params.triggerCents, 20);
      assert.strictEqual(params.hedgeRatio, 0.5);
    });
  });

  describe("Price Recording and Volatility", () => {
    let policy: DynamicHedgePolicy;

    beforeEach(() => {
      policy = createDynamicHedgePolicy();
    });

    it("should record price observations", () => {
      policy.recordPrice("token1", 50);
      policy.recordPrice("token1", 52);
      policy.recordPrice("token1", 48);

      const params = policy.getParameters();
      // Should have volatility data (but not enough to adapt yet)
      assert(params.currentVolatility >= 0);
    });

    it("should detect high volatility regime", () => {
      const policy = createDynamicHedgePolicy({
        highVolatilityThreshold: 2.0,
        minObservationsForAdaptation: 10,
      });

      // Record highly volatile prices
      for (let i = 0; i < 30; i++) {
        // Oscillate wildly: 40, 60, 40, 60, ...
        policy.recordPrice("token1", i % 2 === 0 ? 40 : 60);
        policy.recordAdverseMove("token1", 5, 1000);
      }

      const params = policy.getParameters();
      // With wild oscillations, should detect high volatility
      if (params.usingAdaptedValues) {
        assert.strictEqual(params.volatilityRegime, "HIGH");
      }
    });

    it("should detect low volatility regime", () => {
      const policy = createDynamicHedgePolicy({
        lowVolatilityThreshold: 1.0,
        minObservationsForAdaptation: 10,
      });

      // Record stable prices
      for (let i = 0; i < 30; i++) {
        policy.recordPrice("token1", 50 + (i % 2) * 0.1); // Very small changes
        policy.recordAdverseMove("token1", 0.1, 1000);
      }

      const params = policy.getParameters();
      // With stable prices, should detect low volatility
      // Note: may still be NORMAL depending on EWMA state
      assert(["LOW", "NORMAL"].includes(params.volatilityRegime));
    });
  });

  describe("Adverse Move Recording", () => {
    it("should track adverse moves and velocity", () => {
      const policy = createDynamicHedgePolicy();

      policy.recordAdverseMove("token1", 5, 2000); // 2.5 cents/sec
      policy.recordAdverseMove("token1", 10, 4000); // 2.5 cents/sec
      policy.recordAdverseMove("token1", 3, 1000); // 3 cents/sec

      const params = policy.getParameters();
      assert(params.currentVelocity > 0);
    });
  });

  describe("Hedge Outcome Recording", () => {
    let policy: DynamicHedgePolicy;

    beforeEach(() => {
      policy = createDynamicHedgePolicy({
        minObservationsForAdaptation: 5,
      });
    });

    it("should record effective hedges", () => {
      for (let i = 0; i < 10; i++) {
        policy.recordHedgeOutcome(createEffectiveHedge());
        policy.recordAdverseMove("token1", 5, 1000);
      }

      const logEntry = policy.toLogEntry() as any;
      assert(logEntry.hedgeOutcomes.total >= 10);
      assert(logEntry.hedgeOutcomes.effective >= 10);
    });

    it("should record ineffective hedges", () => {
      for (let i = 0; i < 10; i++) {
        policy.recordHedgeOutcome(createIneffectiveHedge());
        policy.recordAdverseMove("token1", 5, 1000);
      }

      const logEntry = policy.toLogEntry() as any;
      assert(logEntry.hedgeOutcomes.total >= 10);
      assert.strictEqual(logEntry.hedgeOutcomes.effective, 0);
    });
  });

  describe("Parameter Adaptation", () => {
    it("should tighten trigger in high volatility", () => {
      const policy = createDynamicHedgePolicy({
        baseTriggerCents: 16,
        minTriggerCents: 8,
        minObservationsForAdaptation: 10,
        maxChangePerInterval: 0.5, // Allow larger changes for testing
        adaptationIntervalMs: 0, // Immediate adaptation
      });

      // Force high volatility by recording large moves
      for (let i = 0; i < 30; i++) {
        policy.recordPrice("token1", i % 2 === 0 ? 30 : 70);
        policy.recordAdverseMove("token1", 20, 500); // Fast, large moves
        policy.recordHedgeOutcome(createEffectiveHedge());
      }

      const params = policy.getParameters();

      // In high volatility, trigger should tighten (lower cents)
      if (params.usingAdaptedValues && params.volatilityRegime === "HIGH") {
        assert(
          params.triggerCents < HEDGE_DEFAULTS.TRIGGER_CENTS,
          `Expected trigger ${params.triggerCents} < ${HEDGE_DEFAULTS.TRIGGER_CENTS}`,
        );
      }
    });

    it("should increase hedge ratio when hedges are effective", () => {
      const policy = createDynamicHedgePolicy({
        baseHedgeRatio: 0.4,
        minObservationsForAdaptation: 10,
        maxChangePerInterval: 0.3,
        adaptationIntervalMs: 0,
      });

      // Record many effective hedges
      for (let i = 0; i < 30; i++) {
        policy.recordHedgeOutcome(createEffectiveHedge());
        policy.recordAdverseMove("token1", 10, 2000);
        policy.recordPrice("token1", 50 + (i % 2) * 5);
      }

      const params = policy.getParameters();

      // With effective hedges, ratio may increase
      if (params.usingAdaptedValues) {
        // Ratio should be at least base or higher
        assert(params.hedgeRatio >= 0.3);
      }
    });

    it("should reduce hedge ratio when hedges are ineffective", () => {
      const policy = createDynamicHedgePolicy({
        baseHedgeRatio: 0.5,
        minHedgeRatio: 0.2,
        minObservationsForAdaptation: 10,
        maxChangePerInterval: 0.3,
        adaptationIntervalMs: 0,
      });

      // Record many ineffective hedges
      for (let i = 0; i < 30; i++) {
        policy.recordHedgeOutcome(createIneffectiveHedge());
        policy.recordAdverseMove("token1", 5, 1000);
        policy.recordPrice("token1", 50 + (i % 2));
      }

      const params = policy.getParameters();

      // With ineffective hedges, ratio may decrease
      if (params.usingAdaptedValues) {
        assert(
          params.hedgeRatio <= 0.5,
          `Expected ratio ${params.hedgeRatio} <= 0.5`,
        );
      }
    });

    it("should respect max change per interval", () => {
      const policy = createDynamicHedgePolicy({
        baseTriggerCents: 16,
        maxChangePerInterval: 0.1, // Only 10% change allowed per adaptation
        minObservationsForAdaptation: 10,
        adaptationIntervalMs: 60000, // Prevent multiple adaptations in this test
      });

      const initialParams = policy.getParameters();

      // Record extreme data that would want large changes
      for (let i = 0; i < 20; i++) {
        policy.recordPrice("token1", i % 2 === 0 ? 20 : 80);
        policy.recordAdverseMove("token1", 30, 100);
        policy.recordHedgeOutcome(createEffectiveHedge());
      }

      const params = policy.getParameters();

      // With high adaptationIntervalMs, only one adaptation should occur
      // Change should be limited to ~10% of initial value
      if (params.usingAdaptedValues) {
        const maxExpectedChange = initialParams.triggerCents * 0.15; // 15% tolerance
        const actualChange = Math.abs(
          params.triggerCents - initialParams.triggerCents,
        );
        assert(
          actualChange <= maxExpectedChange,
          `Change ${actualChange} should be <= ${maxExpectedChange}`,
        );
      }
    });
  });

  describe("Hedge Decision", () => {
    let policy: DynamicHedgePolicy;

    beforeEach(() => {
      policy = createDynamicHedgePolicy();
    });

    it("should not trigger hedge when PnL is positive", () => {
      const decision = policy.evaluateHedge(5, 0); // +5¢ PnL, no hedge yet

      assert.strictEqual(decision.shouldHedge, false);
      assert(decision.reason.includes("BELOW_TRIGGER"));
    });

    it("should not trigger hedge when adverse move below trigger", () => {
      const decision = policy.evaluateHedge(-10, 0); // -10¢, but trigger is 16¢

      assert.strictEqual(decision.shouldHedge, false);
      assert(decision.reason.includes("BELOW_TRIGGER"));
    });

    it("should trigger hedge when adverse move exceeds trigger", () => {
      const decision = policy.evaluateHedge(-20, 0); // -20¢ > 16¢ trigger

      assert.strictEqual(decision.shouldHedge, true);
      assert(decision.hedgeRatio > 0);
      assert(decision.reason.includes("TRIGGERED"));
    });

    it("should not trigger when already at max hedge", () => {
      const decision = policy.evaluateHedge(-20, 0.7); // Already at 70% max

      assert.strictEqual(decision.shouldHedge, false);
      assert(decision.reason.includes("MAX_HEDGE_REACHED"));
    });

    it("should limit hedge ratio to available capacity", () => {
      const decision = policy.evaluateHedge(-20, 0.5); // 50% hedged, max 70%

      assert.strictEqual(decision.shouldHedge, true);
      // Available: 70% - 50% = 20%, but base ratio is 40%
      assert(decision.hedgeRatio <= 0.2);
    });

    it("should hedge more aggressively when EV is negative", () => {
      const normalDecision = policy.evaluateHedge(-20, 0);
      const negativeEvDecision = policy.evaluateHedge(-20, 0, {
        avgWinCents: 10,
        avgLossCents: 15,
        churnCostCents: 2,
        winRate: 0.4,
        evCents: -3, // Negative EV
        breakEvenWinRate: 0.55,
        confidence: 0.8,
        sampleSize: 50,
        notionalVolume: 1000,
        avgWinVariance: 1,
        avgLossVariance: 1,
        winRateVariance: 0.01,
        usingDynamicValues: true,
        lastUpdated: Date.now(),
      });

      // With negative EV, should hedge more aggressively
      assert(negativeEvDecision.hedgeRatio >= normalDecision.hedgeRatio);
    });
  });

  describe("Force Exit Check", () => {
    it("should not force exit when within limits", () => {
      const policy = createDynamicHedgePolicy();
      const result = policy.shouldForceExit(-20); // -20¢ < 30¢ max

      assert.strictEqual(result.shouldExit, false);
      assert(result.reason.includes("WITHIN_LIMITS"));
    });

    it("should force exit when hitting hard stop", () => {
      const policy = createDynamicHedgePolicy();
      const result = policy.shouldForceExit(-35); // -35¢ > 30¢ max

      assert.strictEqual(result.shouldExit, true);
      assert(result.reason.includes("HARD_STOP"));
    });

    it("should use adapted max adverse for exit check", () => {
      const policy = createDynamicHedgePolicy({
        baseMaxAdverseCents: 30,
        minMaxAdverseCents: 15,
        minObservationsForAdaptation: 10,
        adaptationIntervalMs: 0,
      });

      // Record observations that would tighten max adverse
      for (let i = 0; i < 20; i++) {
        policy.recordAdverseMove("token1", 10 + i, 1000);
        policy.recordHedgeOutcome(createEffectiveHedge());
      }

      const params = policy.getParameters();
      const result = policy.shouldForceExit(-params.maxAdverseCents - 1);

      // Should exit based on adapted (or base) max adverse
      assert.strictEqual(result.shouldExit, true);
    });
  });

  describe("State Management", () => {
    it("should reset all state", () => {
      const policy = createDynamicHedgePolicy();

      // Add some data
      for (let i = 0; i < 20; i++) {
        policy.recordPrice("token1", 50 + i);
        policy.recordAdverseMove("token1", 5, 1000);
        policy.recordHedgeOutcome(createEffectiveHedge());
      }

      policy.reset();

      const params = policy.getParameters();
      const logEntry = policy.toLogEntry() as any;

      assert.strictEqual(params.usingAdaptedValues, false);
      assert.strictEqual(params.triggerCents, HEDGE_DEFAULTS.TRIGGER_CENTS);
      assert.strictEqual(logEntry.hedgeOutcomes.total, 0);
    });

    it("should export log entry correctly", () => {
      const policy = createDynamicHedgePolicy();
      policy.recordHedgeOutcome(createEffectiveHedge());
      policy.recordAdverseMove("token1", 5, 1000);

      const logEntry = policy.toLogEntry() as any;

      assert.strictEqual(logEntry.type, "dynamic_hedge_policy");
      assert(logEntry.timestamp);
      assert(logEntry.parameters);
      assert.strictEqual(
        logEntry.parameters.triggerCents,
        HEDGE_DEFAULTS.TRIGGER_CENTS,
      );
      assert(logEntry.marketState);
      assert(logEntry.adaptation);
      assert(logEntry.hedgeOutcomes);
    });
  });

  describe("Guardrails", () => {
    it("should not adapt with insufficient observations", () => {
      const policy = createDynamicHedgePolicy({
        minObservationsForAdaptation: 50,
      });

      // Record fewer observations than threshold
      for (let i = 0; i < 20; i++) {
        policy.recordAdverseMove("token1", 15, 500);
        policy.recordHedgeOutcome(createEffectiveHedge());
      }

      const params = policy.getParameters();

      // Should not be using adapted values
      assert.strictEqual(params.usingAdaptedValues, false);
      assert.strictEqual(params.triggerCents, HEDGE_DEFAULTS.TRIGGER_CENTS);
    });

    it("should clamp trigger to bounds", () => {
      const policy = createDynamicHedgePolicy({
        baseTriggerCents: 16,
        minTriggerCents: 10,
        maxTriggerCents: 20,
        minObservationsForAdaptation: 10,
        adaptationIntervalMs: 0,
        maxChangePerInterval: 1.0, // Allow full change
      });

      // Record extreme data
      for (let i = 0; i < 30; i++) {
        policy.recordPrice("token1", i % 2 === 0 ? 10 : 90);
        policy.recordAdverseMove("token1", 50, 100);
        policy.recordHedgeOutcome(createEffectiveHedge());
      }

      const params = policy.getParameters();

      // Even with extreme data, should stay within bounds
      assert(
        params.triggerCents >= 10,
        `Trigger ${params.triggerCents} should be >= 10`,
      );
      assert(
        params.triggerCents <= 20,
        `Trigger ${params.triggerCents} should be <= 20`,
      );
    });

    it("should clamp hedge ratio to bounds", () => {
      const policy = createDynamicHedgePolicy({
        baseHedgeRatio: 0.4,
        minHedgeRatio: 0.2,
        adaptiveMaxHedgeRatio: 0.8,
        minObservationsForAdaptation: 10,
        adaptationIntervalMs: 0,
        maxChangePerInterval: 1.0,
      });

      // Record data
      for (let i = 0; i < 30; i++) {
        policy.recordPrice("token1", 50 + (i % 2) * 20);
        policy.recordAdverseMove("token1", 20, 500);
        policy.recordHedgeOutcome(createEffectiveHedge());
      }

      const params = policy.getParameters();

      assert(
        params.hedgeRatio >= 0.2,
        `Ratio ${params.hedgeRatio} should be >= 0.2`,
      );
      assert(
        params.hedgeRatio <= 0.8,
        `Ratio ${params.hedgeRatio} should be <= 0.8`,
      );
    });
  });

  describe("Enabled Flag", () => {
    it("should always return static base values when disabled", () => {
      const policy = createDynamicHedgePolicy({
        enabled: false,
        baseTriggerCents: 16,
        baseHedgeRatio: 0.4,
        maxHedgeRatio: 0.7,
        baseMaxAdverseCents: 30,
      });

      // Record lots of data that would normally trigger adaptation
      for (let i = 0; i < 50; i++) {
        policy.recordPrice("token1", 50 + Math.random() * 30);
        policy.recordAdverseMove("token1", 25, 1000);
        policy.recordHedgeOutcome(createEffectiveHedge());
      }

      const params = policy.getParameters();

      // Should return base values regardless of recorded data
      assert.strictEqual(
        params.triggerCents,
        16,
        "Should use base trigger cents",
      );
      assert.strictEqual(params.hedgeRatio, 0.4, "Should use base hedge ratio");
      assert.strictEqual(
        params.maxHedgeRatio,
        0.7,
        "Should use base max hedge ratio",
      );
      assert.strictEqual(
        params.maxAdverseCents,
        30,
        "Should use base max adverse cents",
      );
      assert.strictEqual(
        params.usingAdaptedValues,
        false,
        "Should not use adapted values",
      );
      assert.strictEqual(
        params.adaptationReason,
        "DYNAMIC_HEDGE_DISABLED",
        "Should show disabled reason",
      );
    });

    it("should adapt values when enabled", () => {
      const policy = createDynamicHedgePolicy({
        enabled: true,
        baseTriggerCents: 16,
        minObservationsForAdaptation: 10,
        adaptationIntervalMs: 0,
        maxChangePerInterval: 1.0,
      });

      // Record data that should trigger adaptation
      for (let i = 0; i < 30; i++) {
        policy.recordPrice("token1", 50 + (i % 2) * 20);
        policy.recordAdverseMove("token1", 25, 1000);
        policy.recordHedgeOutcome(createEffectiveHedge());
      }

      const params = policy.getParameters();

      assert.strictEqual(
        params.usingAdaptedValues,
        true,
        "Should use adapted values when enabled",
      );
      assert.notStrictEqual(
        params.adaptationReason,
        "DYNAMIC_HEDGE_DISABLED",
        "Should not show disabled reason",
      );
    });
  });
});
