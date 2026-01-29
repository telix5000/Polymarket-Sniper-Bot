/**
 * Dynamic EV Engine - Adaptive Expected Value Calculation
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MATH IS LAW - Dynamic Version
 *
 *   EV = p(win) × avg_win - p(loss) × avg_loss - churn_cost
 *
 * Static defaults:
 *   avg_win  = 14¢
 *   avg_loss = 9¢ (after hedge caps losses)
 *   churn    = 2¢ (spread + slippage + fees)
 *
 * Break-even: p > (9 + 2) / (14 + 9) = 47.8%
 *
 * This module dynamically updates these values based on live execution data
 * and market conditions, then uses them to gate entries, scale positions,
 * or pause trading when edge disappears.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════
// STATIC DEFAULTS (fallback when sample size too small)
// ═══════════════════════════════════════════════════════════════════════════

export const EV_DEFAULTS = {
  AVG_WIN_CENTS: 14,
  AVG_LOSS_CENTS: 9,
  CHURN_COST_CENTS: 2,
  BREAK_EVEN_WIN_RATE: 0.478, // (9 + 2) / (14 + 9)
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

export interface DynamicEvConfig {
  // Feature toggle
  /** Whether dynamic EV is enabled (default: true). Set DYNAMIC_EV_ENABLED=false to disable. */
  enabled: boolean;

  // Window sizes for rolling calculations
  /** Number of trades for rolling window (default: 200) */
  rollingWindowTrades: number;
  /** Minimum trades before using dynamic values (default: 30) */
  minTradesForDynamic: number;
  /** Minimum notional volume (USD) before using dynamic values (default: 500) */
  minNotionalForDynamic: number;

  // EWMA decay constants (higher = more weight on recent data)
  /** Decay factor for win/loss averages (default: 0.1 = 10% weight on new) */
  ewmaDecayAvg: number;
  /** Decay factor for win rate (default: 0.05 = 5% weight on new) */
  ewmaDecayWinRate: number;
  /** Decay factor for churn cost (default: 0.15 = 15% weight on new) */
  ewmaDecayChurn: number;

  // Confidence and guardrails
  /** Minimum confidence level before adapting (default: 0.7) */
  minConfidenceLevel: number;
  /** Max variance multiplier before falling back to static (default: 2.0) */
  maxVarianceMultiplier: number;

  // EV thresholds for decision policy
  /** EV threshold for full size entries (default: 0.5 cents) */
  evFullSizeThreshold: number;
  /** EV threshold for reduced size entries (default: 0 cents) */
  evReducedSizeThreshold: number;
  /** Size reduction factor when EV is marginal (default: 0.5 = 50% size) */
  reducedSizeFactor: number;

  // Operational guardrails
  /** Max spread (cents) to allow entry (default: 6) */
  maxSpreadCents: number;
  /** Max latency (ms) before throttling (default: 500) */
  maxLatencyMs: number;
  /** Min depth (USD) at exit price (default: 25) */
  minDepthUsdAtExit: number;

  // Pause settings
  /** Pause duration (seconds) when EV is negative (default: 300) */
  pauseSeconds: number;
  /** Min profit factor required (default: 1.25) */
  minProfitFactor: number;

  // Churn tracking
  /** Churn observation window in milliseconds (default: 3600000 = 1 hour) */
  churnWindowMs: number;

  // Initial assumptions (used before sufficient data collected)
  /** Initial win rate assumption above break-even (default: 0.02 = 2%) */
  initialWinRateBonusPct: number;
  /** Minimum trades before using win rate for pause decision (default: 10) */
  minTradesForPauseDecision: number;
}

// Helper to read env var for enabled flag (defaults to true)
const envBoolDefault = (key: string, defaultValue: boolean): boolean => {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() !== "false";
};

export const DEFAULT_DYNAMIC_EV_CONFIG: DynamicEvConfig = {
  enabled: envBoolDefault("DYNAMIC_EV_ENABLED", true), // Enabled by default
  rollingWindowTrades: 200,
  minTradesForDynamic: 30,
  minNotionalForDynamic: 500,
  ewmaDecayAvg: 0.1,
  ewmaDecayWinRate: 0.05,
  ewmaDecayChurn: 0.15,
  minConfidenceLevel: 0.7,
  maxVarianceMultiplier: 2.0,
  evFullSizeThreshold: 0.5,
  evReducedSizeThreshold: 0,
  reducedSizeFactor: 0.5,
  maxSpreadCents: 6,
  maxLatencyMs: 500,
  minDepthUsdAtExit: 25,
  pauseSeconds: 300,
  minProfitFactor: 1.25,
  churnWindowMs: 3600000, // 1 hour
  initialWinRateBonusPct: 0.02, // Start 2% above break-even
  minTradesForPauseDecision: 10,
};

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface TradeOutcome {
  tokenId: string;
  side: "LONG" | "SHORT";
  entryPriceCents: number;
  exitPriceCents: number;
  sizeUsd: number;
  timestamp: number;
  pnlCents: number;
  pnlUsd: number;
  isWin: boolean;
  // Execution costs
  spreadCents: number;
  slippageCents: number;
  feesCents: number;
  // Hedge info
  wasHedged: boolean;
  hedgePnlCents: number;
}

export interface ChurnObservation {
  timestamp: number;
  spreadCents: number;
  slippageCents: number;
  feesCents: number;
  totalChurnCents: number;
}

export interface DynamicEvMetrics {
  // Core EV components
  avgWinCents: number;
  avgLossCents: number;
  churnCostCents: number;
  winRate: number;

  // Computed EV
  evCents: number;
  breakEvenWinRate: number;

  // Confidence metrics
  confidence: number;
  sampleSize: number;
  notionalVolume: number;

  // Variance metrics
  avgWinVariance: number;
  avgLossVariance: number;
  winRateVariance: number;

  // Status
  usingDynamicValues: boolean;
  lastUpdated: number;
}

export interface EntryDecisionResult {
  allowed: boolean;
  sizeFactor: number; // 1.0 = full, 0.5 = reduced, 0 = blocked
  reason: string;
  evCents: number;
  metrics: DynamicEvMetrics;
}

export interface OperationalCheck {
  passed: boolean;
  reason: string;
  value: number;
  threshold: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// EWMA CALCULATOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Exponentially Weighted Moving Average calculator
 * Provides smoothed estimates that give more weight to recent observations
 */
class EwmaCalculator {
  private value: number;
  private variance: number;
  private count: number;
  private readonly decay: number;
  private readonly initialValue: number;

  constructor(initialValue: number, decay: number) {
    this.initialValue = initialValue;
    this.value = initialValue;
    this.variance = 0;
    this.count = 0;
    this.decay = decay;
  }

  /**
   * Update the EWMA with a new observation
   */
  update(observation: number): void {
    this.count++;
    const alpha = this.decay;

    // Update EWMA mean
    const prevValue = this.value;
    const delta = observation - prevValue;
    this.value = alpha * observation + (1 - alpha) * prevValue;

    // Update variance using standard EWMA variance formula with prediction error
    // Variance = (1 - alpha) * variance + alpha * (observation - prevValue)^2
    this.variance = (1 - alpha) * this.variance + alpha * delta * delta;
  }

  /**
   * Get the current smoothed value
   */
  getValue(): number {
    return this.value;
  }

  /**
   * Get the estimated variance
   */
  getVariance(): number {
    return this.variance;
  }

  /**
   * Get standard deviation
   */
  getStdDev(): number {
    return Math.sqrt(this.variance);
  }

  /**
   * Get observation count
   */
  getCount(): number {
    return this.count;
  }

  /**
   * Check if value is within acceptable variance bounds
   */
  isStable(maxVarianceMultiplier: number): boolean {
    if (this.count < 5) return false;
    // Guard against division by zero when initialValue is 0
    const denominator = this.initialValue * this.initialValue;
    if (denominator === 0) return false;
    const normalizedVariance = this.variance / denominator;
    return normalizedVariance < maxVarianceMultiplier;
  }

  /**
   * Reset to initial state
   */
  reset(): void {
    this.value = this.initialValue;
    this.variance = 0;
    this.count = 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DYNAMIC EV ENGINE
// ═══════════════════════════════════════════════════════════════════════════

export class DynamicEvEngine {
  private readonly config: DynamicEvConfig;

  // Rolling trade outcomes
  private trades: TradeOutcome[] = [];
  private churnObservations: ChurnObservation[] = [];

  // EWMA estimators
  private avgWinEwma: EwmaCalculator;
  private avgLossEwma: EwmaCalculator;
  private winRateEwma: EwmaCalculator;
  private churnCostEwma: EwmaCalculator;

  // Tracking
  private totalNotional = 0;
  private pausedUntil = 0;
  private lastMetrics: DynamicEvMetrics | null = null;

  constructor(config: Partial<DynamicEvConfig> = {}) {
    this.config = { ...DEFAULT_DYNAMIC_EV_CONFIG, ...config };

    // Initialize EWMA calculators with static defaults
    this.avgWinEwma = new EwmaCalculator(
      EV_DEFAULTS.AVG_WIN_CENTS,
      this.config.ewmaDecayAvg,
    );
    this.avgLossEwma = new EwmaCalculator(
      EV_DEFAULTS.AVG_LOSS_CENTS,
      this.config.ewmaDecayAvg,
    );
    this.winRateEwma = new EwmaCalculator(
      // Start above break-even (optimistic assumption during warmup)
      // Uses only the configurable initialWinRateBonusPct bonus
      EV_DEFAULTS.BREAK_EVEN_WIN_RATE + this.config.initialWinRateBonusPct,
      this.config.ewmaDecayWinRate,
    );
    this.churnCostEwma = new EwmaCalculator(
      EV_DEFAULTS.CHURN_COST_CENTS,
      this.config.ewmaDecayChurn,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TRADE RECORDING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record a completed trade outcome
   */
  recordTrade(trade: TradeOutcome): void {
    this.trades.push(trade);
    this.totalNotional += trade.sizeUsd;

    // Trim to rolling window
    while (this.trades.length > this.config.rollingWindowTrades) {
      const removed = this.trades.shift();
      if (removed) {
        this.totalNotional -= removed.sizeUsd;
      }
    }

    // Update EWMA estimators
    if (trade.isWin) {
      this.avgWinEwma.update(trade.pnlCents);
    } else {
      // Record absolute loss (positive number)
      this.avgLossEwma.update(Math.abs(trade.pnlCents));
    }

    // Update win rate (binary: 1 for win, 0 for loss)
    this.winRateEwma.update(trade.isWin ? 1 : 0);

    // Check if we should pause
    this.checkPauseCondition();

    // Invalidate cached metrics
    this.lastMetrics = null;
  }

  /**
   * Record a churn cost observation (spread + slippage + fees)
   */
  recordChurn(observation: ChurnObservation): void {
    this.churnObservations.push(observation);

    // Trim to configured window
    const windowStart = Date.now() - this.config.churnWindowMs;
    this.churnObservations = this.churnObservations.filter(
      (o) => o.timestamp >= windowStart,
    );

    // Update EWMA
    this.churnCostEwma.update(observation.totalChurnCents);

    // Invalidate cached metrics
    this.lastMetrics = null;
  }

  /**
   * Convenience method to record churn from spread and slippage observations
   */
  recordSpreadAndSlippage(
    spreadCents: number,
    slippageCents: number,
    feesCents: number = 0,
  ): void {
    this.recordChurn({
      timestamp: Date.now(),
      spreadCents,
      slippageCents,
      feesCents,
      totalChurnCents: spreadCents + slippageCents + feesCents,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // METRICS CALCULATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get current dynamic EV metrics
   */
  getMetrics(): DynamicEvMetrics {
    // Return cached if available
    if (this.lastMetrics) {
      return this.lastMetrics;
    }

    const sampleSize = this.trades.length;
    const notionalVolume = this.totalNotional;

    // Estimate win and loss counts from win rate EWMA for stability guardrails.
    // We require at least a small number of both wins and losses for variance stability.
    const estimatedWinCount = sampleSize * this.winRateEwma.getValue();
    const estimatedLossCount = sampleSize - estimatedWinCount;
    const hasMinWinLossSamples =
      estimatedWinCount >= 5 && estimatedLossCount >= 5;

    // Determine if we should use dynamic values
    const usingDynamicValues =
      sampleSize >= this.config.minTradesForDynamic &&
      notionalVolume >= this.config.minNotionalForDynamic &&
      hasMinWinLossSamples &&
      this.avgWinEwma.isStable(this.config.maxVarianceMultiplier) &&
      this.avgLossEwma.isStable(this.config.maxVarianceMultiplier);

    // Get values (dynamic or static fallback)
    let avgWinCents: number;
    let avgLossCents: number;
    let churnCostCents: number;
    let winRate: number;

    if (usingDynamicValues) {
      avgWinCents = this.avgWinEwma.getValue();
      avgLossCents = this.avgLossEwma.getValue();
      churnCostCents = this.churnCostEwma.getValue();
      winRate = this.winRateEwma.getValue();
    } else {
      // Use static defaults
      avgWinCents = EV_DEFAULTS.AVG_WIN_CENTS;
      avgLossCents = EV_DEFAULTS.AVG_LOSS_CENTS;
      churnCostCents = EV_DEFAULTS.CHURN_COST_CENTS;
      // For win rate, use EWMA if we have some data, else assume slightly above break-even
      winRate =
        sampleSize >= this.config.minTradesForPauseDecision
          ? this.winRateEwma.getValue()
          : EV_DEFAULTS.BREAK_EVEN_WIN_RATE +
            this.config.initialWinRateBonusPct;
    }

    // Calculate EV: p(win) × avg_win - p(loss) × avg_loss - churn_cost
    const pWin = Math.max(0, Math.min(1, winRate));
    const pLoss = 1 - pWin;
    const evCents = pWin * avgWinCents - pLoss * avgLossCents - churnCostCents;

    // Calculate break-even win rate: (avg_loss + churn) / (avg_win + avg_loss)
    // This represents the minimum win rate needed to achieve EV = 0
    const denom = avgWinCents + avgLossCents;
    let breakEvenWinRate: number = EV_DEFAULTS.BREAK_EVEN_WIN_RATE;
    if (denom > 0 && Number.isFinite(denom)) {
      const candidate = (avgLossCents + churnCostCents) / denom;
      // Validate that break-even rate is a valid probability [0, 1]
      if (Number.isFinite(candidate) && candidate >= 0 && candidate <= 1) {
        breakEvenWinRate = candidate;
      }
    }

    // Calculate confidence based on sample size and variance stability
    const sizeConfidence = Math.min(
      1,
      sampleSize / this.config.minTradesForDynamic,
    );
    const volumeConfidence = Math.min(
      1,
      notionalVolume / this.config.minNotionalForDynamic,
    );
    const varianceConfidence =
      this.avgWinEwma.isStable(this.config.maxVarianceMultiplier) &&
      this.avgLossEwma.isStable(this.config.maxVarianceMultiplier)
        ? 1
        : 0.5;

    const confidence =
      (sizeConfidence + volumeConfidence + varianceConfidence) / 3;

    const metrics: DynamicEvMetrics = {
      avgWinCents,
      avgLossCents,
      churnCostCents,
      winRate: pWin,
      evCents,
      breakEvenWinRate,
      confidence,
      sampleSize,
      notionalVolume,
      avgWinVariance: this.avgWinEwma.getVariance(),
      avgLossVariance: this.avgLossEwma.getVariance(),
      winRateVariance: this.winRateEwma.getVariance(),
      usingDynamicValues,
      lastUpdated: Date.now(),
    };

    // Cache metrics
    this.lastMetrics = metrics;

    return metrics;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DECISION POLICY
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Evaluate whether to allow entry and at what size
   *
   * Decision Policy:
   *   EV ≤ 0 → pause
   *   0 < EV < threshold → reduce size
   *   EV ≥ threshold → full size
   *
   * If disabled via config.enabled=false, always allows full size.
   */
  evaluateEntry(operationalChecks?: {
    spreadCents?: number;
    latencyMs?: number;
    exitDepthUsd?: number;
  }): EntryDecisionResult {
    const metrics = this.getMetrics();

    // If disabled, always allow full size with static EV
    if (!this.config.enabled) {
      return {
        allowed: true,
        sizeFactor: 1.0,
        reason: "DYNAMIC_EV_DISABLED",
        evCents: metrics.evCents,
        metrics,
      };
    }

    // Check if paused
    if (this.isPaused()) {
      return {
        allowed: false,
        sizeFactor: 0,
        reason: `PAUSED (${this.getPauseRemainingSeconds()}s remaining)`,
        evCents: metrics.evCents,
        metrics,
      };
    }

    // Check operational conditions first
    if (operationalChecks) {
      const opCheck = this.checkOperationalConditions(operationalChecks);
      if (!opCheck.passed) {
        return {
          allowed: false,
          sizeFactor: 0,
          reason: opCheck.reason,
          evCents: metrics.evCents,
          metrics,
        };
      }
    }

    // Check confidence level
    if (
      metrics.usingDynamicValues &&
      metrics.confidence < this.config.minConfidenceLevel
    ) {
      // Low confidence - use static values and reduced size
      return {
        allowed: true,
        sizeFactor: this.config.reducedSizeFactor,
        reason: `LOW_CONFIDENCE (${(metrics.confidence * 100).toFixed(0)}%)`,
        evCents: metrics.evCents,
        metrics,
      };
    }

    // Check EV threshold
    if (metrics.evCents <= this.config.evReducedSizeThreshold) {
      // EV ≤ 0 → pause
      return {
        allowed: false,
        sizeFactor: 0,
        reason: `EV_NEGATIVE (${metrics.evCents.toFixed(2)}¢)`,
        evCents: metrics.evCents,
        metrics,
      };
    }

    if (metrics.evCents < this.config.evFullSizeThreshold) {
      // 0 < EV < threshold → reduce size
      return {
        allowed: true,
        sizeFactor: this.config.reducedSizeFactor,
        reason: `EV_MARGINAL (${metrics.evCents.toFixed(2)}¢)`,
        evCents: metrics.evCents,
        metrics,
      };
    }

    // Check profit factor
    // If avgLossCents is zero and avgWinCents is positive, this indicates no losses yet
    // which should allow full size trading (better than blocking trades)
    const profitFactor =
      metrics.avgLossCents > 0
        ? metrics.avgWinCents / metrics.avgLossCents
        : metrics.avgWinCents > 0
          ? Infinity
          : 0;
    if (
      Number.isFinite(profitFactor) &&
      profitFactor < this.config.minProfitFactor
    ) {
      return {
        allowed: true,
        sizeFactor: this.config.reducedSizeFactor,
        reason: `LOW_PROFIT_FACTOR (${profitFactor.toFixed(2)})`,
        evCents: metrics.evCents,
        metrics,
      };
    }

    // EV ≥ threshold → full size
    return {
      allowed: true,
      sizeFactor: 1.0,
      reason: `EV_POSITIVE (${metrics.evCents.toFixed(2)}¢)`,
      evCents: metrics.evCents,
      metrics,
    };
  }

  /**
   * Check operational conditions (spread, latency, liquidity)
   */
  checkOperationalConditions(params: {
    spreadCents?: number;
    latencyMs?: number;
    exitDepthUsd?: number;
  }): OperationalCheck {
    // Check spread
    if (
      params.spreadCents !== undefined &&
      params.spreadCents > this.config.maxSpreadCents
    ) {
      return {
        passed: false,
        reason: `SPREAD_TOO_WIDE (${params.spreadCents.toFixed(1)}¢ > ${this.config.maxSpreadCents}¢)`,
        value: params.spreadCents,
        threshold: this.config.maxSpreadCents,
      };
    }

    // Check latency
    if (
      params.latencyMs !== undefined &&
      params.latencyMs > this.config.maxLatencyMs
    ) {
      return {
        passed: false,
        reason: `LATENCY_HIGH (${params.latencyMs}ms > ${this.config.maxLatencyMs}ms)`,
        value: params.latencyMs,
        threshold: this.config.maxLatencyMs,
      };
    }

    // Check exit depth
    if (
      params.exitDepthUsd !== undefined &&
      params.exitDepthUsd < this.config.minDepthUsdAtExit
    ) {
      return {
        passed: false,
        reason: `DEPTH_LOW ($${params.exitDepthUsd.toFixed(0)} < $${this.config.minDepthUsdAtExit})`,
        value: params.exitDepthUsd,
        threshold: this.config.minDepthUsdAtExit,
      };
    }

    return {
      passed: true,
      reason: "OPERATIONAL_OK",
      value: 0,
      threshold: 0,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAUSE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if trading should be paused based on current metrics
   */
  private checkPauseCondition(): void {
    const metrics = this.getMetrics();

    // Only pause if we have enough data and EV is negative
    // Use separate condition for avgLossCents > 0 to avoid division by zero
    if (
      metrics.sampleSize >= this.config.minTradesForPauseDecision &&
      (metrics.evCents < 0 ||
        (metrics.avgLossCents > 0 &&
          metrics.avgWinCents / metrics.avgLossCents <
            this.config.minProfitFactor))
    ) {
      this.pause();
    }
  }

  /**
   * Pause trading
   */
  pause(): void {
    this.pausedUntil = Date.now() + this.config.pauseSeconds * 1000;
  }

  /**
   * Check if currently paused
   */
  isPaused(): boolean {
    return Date.now() < this.pausedUntil;
  }

  /**
   * Get remaining pause time in seconds
   */
  getPauseRemainingSeconds(): number {
    if (!this.isPaused()) return 0;
    return Math.ceil((this.pausedUntil - Date.now()) / 1000);
  }

  /**
   * Force unpause (for testing or manual override)
   */
  unpause(): void {
    this.pausedUntil = 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UTILITY METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get recent trades
   */
  getRecentTrades(count: number = 10): TradeOutcome[] {
    return this.trades.slice(-count);
  }

  /**
   * Get trade statistics
   */
  getTradeStats(): {
    totalTrades: number;
    wins: number;
    losses: number;
    totalPnlCents: number;
    totalPnlUsd: number;
  } {
    const wins = this.trades.filter((t) => t.isWin);
    const losses = this.trades.filter((t) => !t.isWin);

    return {
      totalTrades: this.trades.length,
      wins: wins.length,
      losses: losses.length,
      totalPnlCents: this.trades.reduce((sum, t) => sum + t.pnlCents, 0),
      totalPnlUsd: this.trades.reduce((sum, t) => sum + t.pnlUsd, 0),
    };
  }

  /**
   * Reset all state
   */
  reset(): void {
    this.trades = [];
    this.churnObservations = [];
    this.totalNotional = 0;
    this.pausedUntil = 0;
    this.lastMetrics = null;

    // Reset EWMA calculators
    this.avgWinEwma.reset();
    this.avgLossEwma.reset();
    this.winRateEwma.reset();
    this.churnCostEwma.reset();
  }

  /**
   * Export state for logging
   */
  toLogEntry(): object {
    const metrics = this.getMetrics();
    const stats = this.getTradeStats();
    const entryDecision = this.evaluateEntry();

    return {
      type: "dynamic_ev_metrics",
      timestamp: new Date().toISOString(),
      metrics: {
        avgWinCents: parseFloat(metrics.avgWinCents.toFixed(2)),
        avgLossCents: parseFloat(metrics.avgLossCents.toFixed(2)),
        churnCostCents: parseFloat(metrics.churnCostCents.toFixed(2)),
        winRate: parseFloat(metrics.winRate.toFixed(4)),
        evCents: parseFloat(metrics.evCents.toFixed(2)),
        breakEvenWinRate: parseFloat(metrics.breakEvenWinRate.toFixed(4)),
        confidence: parseFloat(metrics.confidence.toFixed(2)),
        usingDynamicValues: metrics.usingDynamicValues,
      },
      stats: {
        totalTrades: stats.totalTrades,
        wins: stats.wins,
        losses: stats.losses,
        totalPnlCents: parseFloat(stats.totalPnlCents.toFixed(2)),
        totalPnlUsd: parseFloat(stats.totalPnlUsd.toFixed(2)),
      },
      entryAllowed: entryDecision.allowed,
      entrySizeFactor: entryDecision.sizeFactor,
      entryReason: entryDecision.reason,
      paused: this.isPaused(),
      pauseRemainingSeconds: this.getPauseRemainingSeconds(),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a new Dynamic EV Engine with optional configuration overrides
 */
export function createDynamicEvEngine(
  config: Partial<DynamicEvConfig> = {},
): DynamicEvEngine {
  return new DynamicEvEngine(config);
}
