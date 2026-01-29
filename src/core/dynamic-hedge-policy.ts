/**
 * Dynamic Hedging Policy - Adaptive Hedge Parameter Management
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * HEDGING MATH
 *
 * The hedge system caps losses to keep avg_loss manageable:
 * - hedgeTriggerCents: Price move (adverse) that triggers a hedge
 * - hedgeRatio: Fraction of position to hedge
 * - maxAdverseCents: Hard stop loss cap
 *
 * Static defaults:
 *   hedgeTriggerCents = 16¢ (adverse move before hedging)
 *   hedgeRatio = 0.4 (40% hedge on first trigger)
 *   maxHedgeRatio = 0.7 (70% max hedge)
 *   maxAdverseCents = 30¢ (hard stop)
 *
 * This module dynamically adapts these values based on:
 * - Market volatility (tighten triggers when volatile)
 * - Adverse move velocity (faster moves = tighter triggers)
 * - Drawdown risk (scale hedge ratio with risk)
 * - Tail risk (adjust loss cap based on observed distribution)
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { DynamicEvMetrics } from "./dynamic-ev-engine";
import type { HedgeRatioRecommendation } from "./historical-trade-snapshot";

// ═══════════════════════════════════════════════════════════════════════════
// STATIC DEFAULTS
// ═══════════════════════════════════════════════════════════════════════════

export const HEDGE_DEFAULTS = {
  TRIGGER_CENTS: 16,
  RATIO: 0.4,
  MAX_RATIO: 0.7,
  MAX_ADVERSE_CENTS: 30,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

export interface DynamicHedgeConfig {
  // Feature toggle
  /** Whether dynamic hedging is enabled (default: true). Set DYNAMIC_HEDGE_ENABLED=false to disable. */
  enabled: boolean;

  // Base parameters (before adaptation)
  /** Base hedge trigger (cents adverse move) - default: 16 */
  baseTriggerCents: number;
  /** Base hedge ratio (fraction) - default: 0.4 */
  baseHedgeRatio: number;
  /** Maximum hedge ratio (fraction) - default: 0.7 */
  maxHedgeRatio: number;
  /** Base max adverse cents (hard stop) - default: 30 */
  baseMaxAdverseCents: number;

  // Trigger adaptation bounds
  /** Minimum trigger cents (tightest) - default: 8 */
  minTriggerCents: number;
  /** Maximum trigger cents (loosest) - default: 24 */
  maxTriggerCents: number;

  // Hedge ratio adaptation bounds
  /** Minimum hedge ratio - default: 0.2 */
  minHedgeRatio: number;
  /** Adaptive max hedge ratio - default: 0.9 */
  adaptiveMaxHedgeRatio: number;

  // Max adverse adaptation bounds
  /** Minimum max adverse cents - default: 15 */
  minMaxAdverseCents: number;
  /** Maximum max adverse cents - default: 45 */
  maxMaxAdverseCents: number;

  // Volatility settings
  /** Window for volatility calculation (ms) - default: 300000 (5 min) */
  volatilityWindowMs: number;
  /** High volatility threshold (std dev of price changes) - default: 2.5 */
  highVolatilityThreshold: number;
  /** Low volatility threshold - default: 0.8 */
  lowVolatilityThreshold: number;

  // Velocity settings
  /** Window for velocity calculation (ms) - default: 60000 (1 min) */
  velocityWindowMs: number;
  /** High velocity threshold (cents/second) - default: 0.5 */
  highVelocityThreshold: number;

  // Adaptation guardrails
  /** Minimum observations before adapting - default: 20 */
  minObservationsForAdaptation: number;
  /** Maximum change per interval (fraction) - default: 0.15 */
  maxChangePerInterval: number;
  /** Adaptation interval (ms) - default: 60000 (1 min) */
  adaptationIntervalMs: number;

  // EWMA decay for smoothing
  /** EWMA decay for volatility - default: 0.1 */
  volatilityEwmaDecay: number;
  /** EWMA decay for velocity - default: 0.15 */
  velocityEwmaDecay: number;

  // Hedge outcome learning
  /** Max hedge outcomes to store for learning - default: 100 */
  maxHedgeOutcomesHistory: number;
  /** Low effectiveness threshold (reduce hedge ratio below this) - default: 0.3 */
  lowEffectivenessThreshold: number;
  /** High effectiveness threshold (increase hedge ratio above this) - default: 0.7 */
  highEffectivenessThreshold: number;
  /** Recent outcomes window for effectiveness calculation - default: 20 */
  effectivenessWindowSize: number;

  // Tail risk settings
  /** Percentile for tail risk calculation - default: 0.9 (90th) */
  tailRiskPercentile: number;
  /** Buffer multiplier for max adverse calculation - default: 1.5 */
  tailRiskBufferMultiplier: number;

  // Velocity tightening
  /** Max cents to tighten trigger due to velocity - default: 4 */
  maxVelocityTighteningCents: number;

  // Aggressive hedging when EV is negative
  /** Multiplier for hedge ratio when EV is negative - default: 1.5 */
  negativeEvHedgeMultiplier: number;
}

// Helper to read env var for enabled flag (defaults to true)
const envBoolDefault = (key: string, defaultValue: boolean): boolean => {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() !== "false";
};

export const DEFAULT_DYNAMIC_HEDGE_CONFIG: DynamicHedgeConfig = {
  enabled: envBoolDefault("DYNAMIC_HEDGE_ENABLED", true), // Enabled by default

  baseTriggerCents: 16,
  baseHedgeRatio: 0.4,
  maxHedgeRatio: 0.7,
  baseMaxAdverseCents: 30,

  minTriggerCents: 8,
  maxTriggerCents: 24,

  minHedgeRatio: 0.2,
  adaptiveMaxHedgeRatio: 0.9,

  minMaxAdverseCents: 15,
  maxMaxAdverseCents: 45,

  volatilityWindowMs: 300000,
  highVolatilityThreshold: 2.5,
  lowVolatilityThreshold: 0.8,

  velocityWindowMs: 60000,
  highVelocityThreshold: 0.5,

  minObservationsForAdaptation: 20,
  maxChangePerInterval: 0.15,
  adaptationIntervalMs: 60000,

  volatilityEwmaDecay: 0.1,
  velocityEwmaDecay: 0.15,

  maxHedgeOutcomesHistory: 100,
  lowEffectivenessThreshold: 0.3,
  highEffectivenessThreshold: 0.7,
  effectivenessWindowSize: 20,

  tailRiskPercentile: 0.9,
  tailRiskBufferMultiplier: 1.5,

  maxVelocityTighteningCents: 4,

  negativeEvHedgeMultiplier: 1.5,
};

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface PriceObservation {
  tokenId: string;
  timestamp: number;
  priceCents: number;
}

export interface AdverseMoveObservation {
  tokenId: string;
  timestamp: number;
  moveCents: number;
  durationMs: number;
  velocity: number; // cents per second
}

export interface HedgeOutcome {
  tokenId: string;
  timestamp: number;
  triggerPriceCents: number;
  hedgePriceCents: number;
  hedgeRatio: number;
  positionPnlCents: number;
  hedgePnlCents: number;
  netPnlCents: number;
  wasEffective: boolean; // Did the hedge reduce losses?
}

export interface DynamicHedgeParameters {
  // Adapted parameters
  triggerCents: number;
  hedgeRatio: number;
  maxHedgeRatio: number;
  maxAdverseCents: number;

  // Market state
  currentVolatility: number;
  currentVelocity: number;
  volatilityRegime: "LOW" | "NORMAL" | "HIGH";

  // Adaptation state
  observationCount: number;
  usingAdaptedValues: boolean;
  lastAdaptationTime: number;
  adaptationReason: string;
}

export interface HedgeDecision {
  shouldHedge: boolean;
  hedgeRatio: number;
  reason: string;
  parameters: DynamicHedgeParameters;
}

/**
 * Extended hedge decision that includes historical analysis
 */
export interface HedgeDecisionWithHistory extends HedgeDecision {
  /** Whether historical analysis was applied */
  usedHistoricalAnalysis: boolean;
  /** Original hedge ratio before historical adjustment */
  originalHedgeRatio: number;
  /** Historical recommendation that was applied */
  historicalRecommendation?: HedgeRatioRecommendation;
}

// ═══════════════════════════════════════════════════════════════════════════
// EWMA CALCULATOR (simplified, duplicated from dynamic-ev-engine for independence)
// ═══════════════════════════════════════════════════════════════════════════

class SimpleEwma {
  private value: number;
  private count: number;
  private readonly decay: number;

  constructor(initialValue: number, decay: number) {
    this.value = initialValue;
    this.count = 0;
    this.decay = decay;
  }

  update(observation: number): void {
    this.count++;
    this.value = this.decay * observation + (1 - this.decay) * this.value;
  }

  getValue(): number {
    return this.value;
  }

  getCount(): number {
    return this.count;
  }

  reset(initialValue: number): void {
    this.value = initialValue;
    this.count = 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DYNAMIC HEDGE POLICY
// ═══════════════════════════════════════════════════════════════════════════

export class DynamicHedgePolicy {
  private readonly config: DynamicHedgeConfig;

  // Observation storage
  private priceHistory: Map<string, PriceObservation[]> = new Map();
  private adverseMoves: AdverseMoveObservation[] = [];
  private hedgeOutcomes: HedgeOutcome[] = [];

  // EWMA estimators
  private volatilityEwma: SimpleEwma;
  private velocityEwma: SimpleEwma;

  // Current adapted parameters
  private currentTriggerCents: number;
  private currentHedgeRatio: number;
  private currentMaxHedgeRatio: number;
  private currentMaxAdverseCents: number;

  // Adaptation tracking
  private lastAdaptationTime: number = 0;
  private adaptationReason: string = "INITIAL";

  constructor(config: Partial<DynamicHedgeConfig> = {}) {
    this.config = { ...DEFAULT_DYNAMIC_HEDGE_CONFIG, ...config };

    // Initialize with base values
    this.currentTriggerCents = this.config.baseTriggerCents;
    this.currentHedgeRatio = this.config.baseHedgeRatio;
    this.currentMaxHedgeRatio = this.config.maxHedgeRatio;
    this.currentMaxAdverseCents = this.config.baseMaxAdverseCents;

    // Initialize EWMA calculators
    this.volatilityEwma = new SimpleEwma(1.0, this.config.volatilityEwmaDecay);
    this.velocityEwma = new SimpleEwma(0.1, this.config.velocityEwmaDecay);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OBSERVATION RECORDING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record a price observation for a token
   */
  recordPrice(tokenId: string, priceCents: number): void {
    const now = Date.now();
    const observation: PriceObservation = {
      tokenId,
      timestamp: now,
      priceCents,
    };

    let history = this.priceHistory.get(tokenId);
    if (!history) {
      history = [];
      this.priceHistory.set(tokenId, history);
    }

    history.push(observation);

    // Prune old observations
    const windowStart = now - this.config.volatilityWindowMs;
    this.priceHistory.set(
      tokenId,
      history.filter((o) => o.timestamp >= windowStart),
    );

    // Update volatility estimate for this token
    this.updateVolatility(tokenId);
  }

  /**
   * Record an adverse move observation
   */
  recordAdverseMove(
    tokenId: string,
    moveCents: number,
    durationMs: number,
  ): void {
    const velocity =
      durationMs <= 0 ? 0 : Math.abs((moveCents / durationMs) * 1000); // cents/second, always non-negative

    this.adverseMoves.push({
      tokenId,
      timestamp: Date.now(),
      moveCents,
      durationMs,
      velocity,
    });

    // Update velocity EWMA
    this.velocityEwma.update(velocity);

    // Prune old observations
    const windowStart = Date.now() - this.config.velocityWindowMs * 5; // Keep 5x window for history
    this.adverseMoves = this.adverseMoves.filter(
      (o) => o.timestamp >= windowStart,
    );

    // Trigger adaptation check
    this.checkAdaptation();
  }

  /**
   * Record a hedge outcome for learning
   */
  recordHedgeOutcome(outcome: HedgeOutcome): void {
    this.hedgeOutcomes.push(outcome);

    // Keep configured number of outcomes for analysis
    while (this.hedgeOutcomes.length > this.config.maxHedgeOutcomesHistory) {
      this.hedgeOutcomes.shift();
    }

    // Trigger adaptation check
    this.checkAdaptation();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VOLATILITY CALCULATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Update volatility estimate for a token
   */
  private updateVolatility(tokenId: string): void {
    const history = this.priceHistory.get(tokenId);
    if (!history || history.length < 3) return;

    // Calculate price changes
    const changes: number[] = [];
    for (let i = 1; i < history.length; i++) {
      changes.push(history[i].priceCents - history[i - 1].priceCents);
    }

    // Calculate standard deviation
    const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
    const squaredDiffs = changes.map((c) => Math.pow(c - mean, 2));
    const variance =
      squaredDiffs.reduce((a, b) => a + b, 0) / squaredDiffs.length;
    const stdDev = Math.sqrt(variance);

    // Update EWMA
    this.volatilityEwma.update(stdDev);
  }

  /**
   * Get current volatility regime
   */
  private getVolatilityRegime(): "LOW" | "NORMAL" | "HIGH" {
    const vol = this.volatilityEwma.getValue();

    if (vol >= this.config.highVolatilityThreshold) {
      return "HIGH";
    } else if (vol <= this.config.lowVolatilityThreshold) {
      return "LOW";
    }
    return "NORMAL";
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADAPTATION LOGIC
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if adaptation should occur and apply if needed
   */
  private checkAdaptation(): void {
    const now = Date.now();

    // Check interval
    if (now - this.lastAdaptationTime < this.config.adaptationIntervalMs) {
      return;
    }

    // Check minimum observations
    const totalObservations =
      this.adverseMoves.length + this.hedgeOutcomes.length;
    if (totalObservations < this.config.minObservationsForAdaptation) {
      return;
    }

    // Perform adaptation
    this.adapt();
    this.lastAdaptationTime = now;
  }

  /**
   * Adapt hedge parameters based on observed data
   */
  private adapt(): void {
    const volatility = this.volatilityEwma.getValue();
    const velocity = this.velocityEwma.getValue();
    const volatilityRegime = this.getVolatilityRegime();

    // Calculate target values based on market conditions
    let targetTrigger: number;
    let targetHedgeRatio: number;
    let targetMaxAdverse: number;
    const reasons: string[] = [];

    // ═══════════════════════════════════════════════════════════════════════
    // TRIGGER ADAPTATION
    // High volatility/velocity → tighter triggers (lower cents)
    // Low volatility/velocity → looser triggers (higher cents)
    // ═══════════════════════════════════════════════════════════════════════

    if (volatilityRegime === "HIGH") {
      // Tighten trigger when volatile
      const tighteningFactor = Math.min(
        1,
        volatility / this.config.highVolatilityThreshold,
      );
      targetTrigger =
        this.config.baseTriggerCents -
        tighteningFactor *
          (this.config.baseTriggerCents - this.config.minTriggerCents);
      reasons.push(`HIGH_VOL(${volatility.toFixed(2)})`);
    } else if (volatilityRegime === "LOW") {
      // Loosen trigger when calm
      const looseningFactor = Math.max(
        0,
        Math.min(1, 1 - volatility / this.config.lowVolatilityThreshold),
      );
      targetTrigger =
        this.config.baseTriggerCents +
        looseningFactor *
          (this.config.maxTriggerCents - this.config.baseTriggerCents);
      reasons.push(`LOW_VOL(${volatility.toFixed(2)})`);
    } else {
      targetTrigger = this.config.baseTriggerCents;
      reasons.push("NORMAL_VOL");
    }

    // Further tighten if velocity is high
    if (velocity > this.config.highVelocityThreshold) {
      const velocityFactor = Math.min(
        1,
        velocity / (this.config.highVelocityThreshold * 2),
      );
      targetTrigger =
        targetTrigger - velocityFactor * this.config.maxVelocityTighteningCents;
      reasons.push(`HIGH_VEL(${velocity.toFixed(2)})`);
    }

    // Clamp to bounds
    targetTrigger = Math.max(
      this.config.minTriggerCents,
      Math.min(this.config.maxTriggerCents, targetTrigger),
    );

    // ═══════════════════════════════════════════════════════════════════════
    // HEDGE RATIO ADAPTATION
    // Higher volatility → higher hedge ratio (protect more)
    // Also consider hedge effectiveness from outcomes
    // ═══════════════════════════════════════════════════════════════════════

    if (volatilityRegime === "HIGH") {
      // Higher hedge ratio when volatile
      targetHedgeRatio =
        this.config.baseHedgeRatio +
        0.15 * Math.min(1, volatility / this.config.highVolatilityThreshold);
      reasons.push("HEDGE_UP");
    } else if (volatilityRegime === "LOW") {
      // Lower hedge ratio when calm (save capital)
      targetHedgeRatio = this.config.baseHedgeRatio - 0.1;
      reasons.push("HEDGE_DOWN");
    } else {
      targetHedgeRatio = this.config.baseHedgeRatio;
    }

    // Learn from hedge outcomes using configured window
    const recentOutcomes = this.hedgeOutcomes.slice(
      -this.config.effectivenessWindowSize,
    );
    if (recentOutcomes.length >= 5) {
      const effectiveCount = recentOutcomes.filter(
        (o) => o.wasEffective,
      ).length;
      const effectiveRate = effectiveCount / recentOutcomes.length;

      if (effectiveRate < this.config.lowEffectivenessThreshold) {
        // Hedges not helping - reduce ratio
        targetHedgeRatio = Math.max(
          this.config.minHedgeRatio,
          targetHedgeRatio - 0.1,
        );
        reasons.push(`LOW_EFF(${(effectiveRate * 100).toFixed(0)}%)`);
      } else if (effectiveRate > this.config.highEffectivenessThreshold) {
        // Hedges very effective - can increase ratio
        targetHedgeRatio = Math.min(
          this.config.maxHedgeRatio,
          targetHedgeRatio + 0.05,
        );
        reasons.push(`HIGH_EFF(${(effectiveRate * 100).toFixed(0)}%)`);
      }
    }

    // Clamp to bounds
    targetHedgeRatio = Math.max(
      this.config.minHedgeRatio,
      Math.min(this.config.adaptiveMaxHedgeRatio, targetHedgeRatio),
    );

    // ═══════════════════════════════════════════════════════════════════════
    // MAX ADVERSE ADAPTATION
    // Base on observed tail risk from adverse moves
    // ═══════════════════════════════════════════════════════════════════════

    if (this.adverseMoves.length >= 10) {
      // Calculate percentile of adverse moves for tail risk
      const sortedMoves = [...this.adverseMoves]
        .map((m) => Math.abs(m.moveCents))
        .sort((a, b) => a - b);
      // Use inclusive percentile index: ceil(n * p) - 1, clamped to [0, n - 1]
      const percentileIndex = Math.max(
        0,
        Math.min(
          sortedMoves.length - 1,
          Math.ceil(sortedMoves.length * this.config.tailRiskPercentile) - 1,
        ),
      );
      const tailRiskMove = sortedMoves[percentileIndex];

      // Set max adverse to cover tail risk with configured buffer
      targetMaxAdverse = Math.max(
        this.config.minMaxAdverseCents,
        Math.min(
          this.config.maxMaxAdverseCents,
          tailRiskMove * this.config.tailRiskBufferMultiplier,
        ),
      );
      reasons.push(
        `TAIL_P${(this.config.tailRiskPercentile * 100).toFixed(0)}(${tailRiskMove.toFixed(0)})`,
      );
    } else {
      targetMaxAdverse = this.config.baseMaxAdverseCents;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // APPLY SMOOTHED CHANGES (prevent oscillation)
    // ═══════════════════════════════════════════════════════════════════════

    const maxChange = this.config.maxChangePerInterval;

    this.currentTriggerCents = this.smoothChange(
      this.currentTriggerCents,
      targetTrigger,
      maxChange,
    );

    this.currentHedgeRatio = this.smoothChange(
      this.currentHedgeRatio,
      targetHedgeRatio,
      maxChange,
    );

    this.currentMaxAdverseCents = this.smoothChange(
      this.currentMaxAdverseCents,
      targetMaxAdverse,
      maxChange,
    );

    // Update max hedge ratio based on current hedge ratio
    this.currentMaxHedgeRatio = Math.min(
      this.config.adaptiveMaxHedgeRatio,
      this.currentHedgeRatio + 0.3,
    );

    this.adaptationReason = reasons.join(", ");
  }

  /**
   * Apply smoothed change with max delta constraint
   */
  private smoothChange(
    current: number,
    target: number,
    maxChangeFraction: number,
  ): number {
    const delta = target - current;
    if (delta === 0) {
      return current;
    }
    const baseMaxDelta = Math.abs(current) * maxChangeFraction;
    const minDelta = 0.01;
    const maxDelta = Math.max(baseMaxDelta, minDelta);
    const clampedDelta = Math.max(-maxDelta, Math.min(maxDelta, delta));
    return current + clampedDelta;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get current dynamic hedge parameters
   * If disabled via config.enabled=false, always returns static base values.
   */
  getParameters(): DynamicHedgeParameters {
    const totalObservations =
      this.adverseMoves.length + this.hedgeOutcomes.length;

    // If disabled, always use static base values
    const usingAdaptedValues =
      this.config.enabled &&
      totalObservations >= this.config.minObservationsForAdaptation;

    return {
      triggerCents: usingAdaptedValues
        ? this.currentTriggerCents
        : this.config.baseTriggerCents,
      hedgeRatio: usingAdaptedValues
        ? this.currentHedgeRatio
        : this.config.baseHedgeRatio,
      maxHedgeRatio: usingAdaptedValues
        ? this.currentMaxHedgeRatio
        : this.config.maxHedgeRatio,
      maxAdverseCents: usingAdaptedValues
        ? this.currentMaxAdverseCents
        : this.config.baseMaxAdverseCents,
      currentVolatility: this.volatilityEwma.getValue(),
      currentVelocity: this.velocityEwma.getValue(),
      volatilityRegime: this.getVolatilityRegime(),
      observationCount: totalObservations,
      usingAdaptedValues,
      lastAdaptationTime: this.lastAdaptationTime,
      adaptationReason: this.config.enabled
        ? this.adaptationReason
        : "DYNAMIC_HEDGE_DISABLED",
    };
  }

  /**
   * Evaluate if a hedge should be placed
   */
  evaluateHedge(
    currentPnlCents: number,
    currentHedgeRatio: number,
    evMetrics?: DynamicEvMetrics,
  ): HedgeDecision {
    const params = this.getParameters();

    // Check if already at max hedge
    if (currentHedgeRatio >= params.maxHedgeRatio) {
      return {
        shouldHedge: false,
        hedgeRatio: 0,
        reason: `MAX_HEDGE_REACHED (${(currentHedgeRatio * 100).toFixed(0)}%)`,
        parameters: params,
      };
    }

    // Check if adverse move exceeds trigger
    const adverseMove = Math.abs(Math.min(0, currentPnlCents));
    if (adverseMove < params.triggerCents) {
      return {
        shouldHedge: false,
        hedgeRatio: 0,
        reason: `BELOW_TRIGGER (${adverseMove.toFixed(1)}¢ < ${params.triggerCents.toFixed(1)}¢)`,
        parameters: params,
      };
    }

    // Consider EV gating if provided
    if (evMetrics && evMetrics.evCents < 0) {
      // If EV is negative, consider more aggressive hedging
      const increasedRatio = Math.min(
        params.maxHedgeRatio - currentHedgeRatio,
        params.hedgeRatio * this.config.negativeEvHedgeMultiplier,
      );
      return {
        shouldHedge: true,
        hedgeRatio: increasedRatio,
        reason: `HEDGE_TRIGGERED (EV_NEGATIVE, aggressive)`,
        parameters: params,
      };
    }

    // Standard hedge
    const availableRatio = params.maxHedgeRatio - currentHedgeRatio;
    const hedgeAmount = Math.min(params.hedgeRatio, availableRatio);

    return {
      shouldHedge: true,
      hedgeRatio: hedgeAmount,
      reason: `HEDGE_TRIGGERED (${adverseMove.toFixed(1)}¢ adverse)`,
      parameters: params,
    };
  }

  /**
   * Evaluate if a hedge should be placed with historical trade snapshot analysis
   *
   * This method extends evaluateHedge by incorporating historical performance data
   * to avoid over-hedging or taking unnecessary risk. The historical recommendation
   * adjusts the hedge ratio based on:
   * - Recent win rate trends
   * - Volatility regime
   * - Drawdown status
   * - P&L trends
   * - Profit factor
   * - Slippage trends
   *
   * Decision Flow:
   * 1. Get base hedge decision from evaluateHedge()
   * 2. If no hedge needed, return immediately
   * 3. Apply historical recommendation adjustment factor
   * 4. Clamp final ratio to available capacity
   *
   * @param currentPnlCents - Current position P&L in cents
   * @param currentHedgeRatio - Current hedge ratio already applied
   * @param historicalRecommendation - Recommendation from HistoricalTradeSnapshot
   * @param evMetrics - Optional EV metrics for additional gating
   * @returns Extended hedge decision with historical analysis
   */
  evaluateHedgeWithHistory(
    currentPnlCents: number,
    currentHedgeRatio: number,
    historicalRecommendation: HedgeRatioRecommendation,
    evMetrics?: DynamicEvMetrics,
  ): HedgeDecisionWithHistory {
    // Get base decision first
    const baseDecision = this.evaluateHedge(
      currentPnlCents,
      currentHedgeRatio,
      evMetrics,
    );

    // If no hedge needed, return with historical context but no adjustment
    if (!baseDecision.shouldHedge) {
      return {
        ...baseDecision,
        usedHistoricalAnalysis: false,
        originalHedgeRatio: baseDecision.hedgeRatio,
        historicalRecommendation,
      };
    }

    // Apply historical adjustment factor
    const originalRatio = baseDecision.hedgeRatio;
    let adjustedRatio =
      originalRatio * historicalRecommendation.adjustmentFactor;
    const params = baseDecision.parameters;

    // Clamp to available capacity with a floor based on the ORIGINAL calculated ratio
    // (not the base config ratio) to maintain consistency with the hedge decision
    const availableRatio = params.maxHedgeRatio - currentHedgeRatio;
    const minimumRatio = originalRatio * 0.5; // Minimum 50% of original to prevent under-hedging
    adjustedRatio = Math.max(
      minimumRatio,
      Math.min(adjustedRatio, availableRatio),
    );

    // Build reason string with historical context
    const historyAction = historicalRecommendation.action;
    const historyFactor = historicalRecommendation.adjustmentFactor.toFixed(2);
    const historyConfidence = (
      historicalRecommendation.confidence * 100
    ).toFixed(0);

    let reason = baseDecision.reason;
    if (Math.abs(adjustedRatio - originalRatio) > 0.01) {
      reason += ` [HISTORY: ${historyAction} ×${historyFactor} @${historyConfidence}%]`;
    }

    return {
      shouldHedge: true,
      hedgeRatio: adjustedRatio,
      reason,
      parameters: params,
      usedHistoricalAnalysis: true,
      originalHedgeRatio: originalRatio,
      historicalRecommendation,
    };
  }

  /**
   * Check if position should be force-exited (hard stop)
   */
  shouldForceExit(currentPnlCents: number): {
    shouldExit: boolean;
    reason: string;
  } {
    const params = this.getParameters();
    const adverseMove = Math.abs(Math.min(0, currentPnlCents));

    if (adverseMove >= params.maxAdverseCents) {
      return {
        shouldExit: true,
        reason: `HARD_STOP (${adverseMove.toFixed(1)}¢ >= ${params.maxAdverseCents.toFixed(1)}¢)`,
      };
    }

    return {
      shouldExit: false,
      reason: `WITHIN_LIMITS (${adverseMove.toFixed(1)}¢ < ${params.maxAdverseCents.toFixed(1)}¢)`,
    };
  }

  /**
   * Reset all state
   */
  reset(): void {
    this.priceHistory.clear();
    this.adverseMoves = [];
    this.hedgeOutcomes = [];
    this.lastAdaptationTime = 0;
    this.adaptationReason = "RESET";

    // Reset to base values
    this.currentTriggerCents = this.config.baseTriggerCents;
    this.currentHedgeRatio = this.config.baseHedgeRatio;
    this.currentMaxHedgeRatio = this.config.maxHedgeRatio;
    this.currentMaxAdverseCents = this.config.baseMaxAdverseCents;

    this.volatilityEwma.reset(1.0);
    this.velocityEwma.reset(0.1);
  }

  /**
   * Export state for logging
   */
  toLogEntry(): object {
    const params = this.getParameters();

    return {
      type: "dynamic_hedge_policy",
      timestamp: new Date().toISOString(),
      parameters: {
        triggerCents: parseFloat(params.triggerCents.toFixed(2)),
        hedgeRatio: parseFloat(params.hedgeRatio.toFixed(3)),
        maxHedgeRatio: parseFloat(params.maxHedgeRatio.toFixed(3)),
        maxAdverseCents: parseFloat(params.maxAdverseCents.toFixed(2)),
      },
      marketState: {
        volatility: parseFloat(params.currentVolatility.toFixed(3)),
        velocity: parseFloat(params.currentVelocity.toFixed(3)),
        regime: params.volatilityRegime,
      },
      adaptation: {
        observationCount: params.observationCount,
        usingAdaptedValues: params.usingAdaptedValues,
        lastAdaptationTime: params.lastAdaptationTime,
        reason: params.adaptationReason,
      },
      hedgeOutcomes: {
        total: this.hedgeOutcomes.length,
        effective: this.hedgeOutcomes.filter((o) => o.wasEffective).length,
        avgNetPnl:
          this.hedgeOutcomes.length > 0
            ? parseFloat(
                (
                  this.hedgeOutcomes.reduce((s, o) => s + o.netPnlCents, 0) /
                  this.hedgeOutcomes.length
                ).toFixed(2),
              )
            : 0,
      },
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a new Dynamic Hedge Policy with optional configuration overrides
 */
export function createDynamicHedgePolicy(
  config: Partial<DynamicHedgeConfig> = {},
): DynamicHedgePolicy {
  return new DynamicHedgePolicy(config);
}
