/**
 * Historical Trade Snapshot - Rolling Window Trade Analysis
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PURPOSE
 *
 * This module provides a comprehensive historical trade snapshot that captures
 * key metrics for dynamic hedge ratio adjustments. It helps avoid over-hedging
 * or taking unnecessary risk by comparing current positions against recent
 * historical behavior.
 *
 * Key Metrics Captured:
 * - Realized P&L (per trade and cumulative)
 * - Exposure by asset (position sizes and direction)
 * - Trade frequency (trades per time window)
 * - Slippage (expected vs executed price)
 * - Volatility (rolling standard deviation of returns)
 * - Drawdown (peak-to-trough decline)
 *
 * Data Weighting:
 * - Exponential decay for time-weighted importance
 * - Configurable half-life for decay rate
 * - Fixed rolling window with optional size limit
 *
 * Decision Rules for Hedge Ratio:
 * - REDUCE: High win rate + low volatility + positive P&L trend
 * - MAINTAIN: Normal market conditions, balanced metrics
 * - INCREASE: Rising drawdown + high volatility + negative P&L trend
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A single executed trade record for snapshot analysis
 */
export interface ExecutedTradeRecord {
  /** Unique trade identifier */
  tradeId: string;
  /** Token ID traded */
  tokenId: string;
  /** Asset/market identifier for exposure grouping */
  marketId?: string;
  /** Trade side */
  side: "LONG" | "SHORT";
  /** Size in USD */
  sizeUsd: number;
  /** Entry price in cents */
  entryPriceCents: number;
  /** Exit price in cents */
  exitPriceCents: number;
  /** Expected execution price (for slippage calc) */
  expectedPriceCents: number;
  /** Actual realized P&L in cents */
  realizedPnlCents: number;
  /** Realized P&L in USD */
  realizedPnlUsd: number;
  /** Unix timestamp of trade execution */
  timestamp: number;
  /** Whether the trade was a win */
  isWin: boolean;
  /** Whether position was hedged */
  wasHedged: boolean;
  /** Hedge ratio applied (if hedged) */
  hedgeRatio: number;
}

/**
 * Exposure metrics for a single asset/market
 */
export interface AssetExposure {
  /** Asset/market identifier */
  marketId: string;
  /** Net exposure in USD (positive = long, negative = short) */
  netExposureUsd: number;
  /** Total long exposure in USD */
  longExposureUsd: number;
  /** Total short exposure in USD */
  shortExposureUsd: number;
  /** Number of active positions */
  positionCount: number;
  /** Win rate for this asset */
  assetWinRate: number;
  /** Average P&L per trade for this asset */
  avgPnlUsd: number;
}

/**
 * Drawdown tracking state
 */
export interface DrawdownMetrics {
  /** Current portfolio value (starting from 0, cumulative P&L) */
  currentValue: number;
  /** Peak value observed */
  peakValue: number;
  /** Current drawdown (peak - current) as percentage */
  currentDrawdownPct: number;
  /** Maximum drawdown observed */
  maxDrawdownPct: number;
  /** Timestamp of peak */
  peakTimestamp: number;
  /** Is currently in drawdown */
  isInDrawdown: boolean;
}

/**
 * Volatility metrics
 */
export interface VolatilityMetrics {
  /** Rolling standard deviation of returns */
  rollingStdDev: number;
  /** Average absolute return */
  avgAbsoluteReturn: number;
  /** Return variance */
  returnVariance: number;
  /** Volatility regime: LOW, NORMAL, HIGH */
  volatilityRegime: "LOW" | "NORMAL" | "HIGH";
  /** Number of observations */
  observationCount: number;
}

/**
 * Trade frequency metrics
 */
export interface TradeFrequencyMetrics {
  /** Trades in last hour */
  tradesLastHour: number;
  /** Trades in last 24 hours */
  tradesLast24h: number;
  /** Average trades per hour (rolling) */
  avgTradesPerHour: number;
  /** Time since last trade (ms) */
  timeSinceLastTradeMs: number;
  /** Trading velocity trend (increasing, decreasing, stable) */
  frequencyTrend: "INCREASING" | "DECREASING" | "STABLE";
}

/**
 * Slippage metrics
 */
export interface SlippageMetrics {
  /** Average slippage in cents */
  avgSlippageCents: number;
  /** Average slippage as percentage of price */
  avgSlippagePct: number;
  /** Maximum observed slippage */
  maxSlippageCents: number;
  /** Slippage standard deviation */
  slippageStdDev: number;
  /** Recent slippage trend */
  slippageTrend: "IMPROVING" | "WORSENING" | "STABLE";
}

/**
 * Complete historical snapshot
 */
export interface HistoricalSnapshot {
  /** Timestamp of snapshot */
  timestamp: number;

  // P&L metrics
  realizedPnlUsd: number;
  realizedPnlCents: number;
  avgPnlPerTradeUsd: number;
  winRate: number;
  profitFactor: number;

  // Exposure
  totalExposureUsd: number;
  exposureByAsset: Map<string, AssetExposure>;

  // Drawdown
  drawdown: DrawdownMetrics;

  // Volatility
  volatility: VolatilityMetrics;

  // Frequency
  frequency: TradeFrequencyMetrics;

  // Slippage
  slippage: SlippageMetrics;

  // Meta
  tradeCount: number;
  windowSizeMs: number;
  oldestTradeTimestamp: number;
}

/**
 * Hedge ratio recommendation from historical analysis
 */
export interface HedgeRatioRecommendation {
  /** Recommended action */
  action: "REDUCE" | "MAINTAIN" | "INCREASE";
  /** Suggested hedge ratio adjustment factor (1.0 = no change) */
  adjustmentFactor: number;
  /** Confidence in recommendation (0-1) */
  confidence: number;
  /** Reasons for the recommendation */
  reasons: string[];
  /** Current snapshot used for decision */
  snapshot: HistoricalSnapshot;
}

/**
 * Configuration for historical trade snapshot
 */
export interface HistoricalSnapshotConfig {
  /** Maximum trades to keep in window (default: 500) */
  maxTrades: number;
  /** Rolling window duration in ms (default: 24 hours) */
  windowDurationMs: number;
  /** Exponential decay half-life in ms (default: 4 hours) */
  decayHalfLifeMs: number;
  /** Minimum trades required for valid metrics (default: 10) */
  minTradesForMetrics: number;

  // Volatility thresholds
  /** High volatility threshold (std dev) */
  highVolatilityThreshold: number;
  /** Low volatility threshold (std dev) */
  lowVolatilityThreshold: number;

  // Drawdown thresholds
  /** Drawdown warning threshold (percentage) */
  drawdownWarningPct: number;
  /** Drawdown critical threshold (percentage) */
  drawdownCriticalPct: number;

  // Hedge ratio adjustment factors
  /** Factor to reduce hedge ratio when conditions favorable */
  hedgeReduceFactor: number;
  /** Factor to increase hedge ratio when conditions adverse */
  hedgeIncreaseFactor: number;

  // Win rate thresholds for decisions
  /** High win rate threshold (considered favorable) */
  highWinRateThreshold: number;
  /** Low win rate threshold (considered adverse) */
  lowWinRateThreshold: number;

  // Slippage thresholds
  /** Acceptable slippage threshold in cents */
  acceptableSlippageCents: number;
  /** High slippage warning threshold */
  highSlippageCents: number;
}

export const DEFAULT_HISTORICAL_SNAPSHOT_CONFIG: HistoricalSnapshotConfig = {
  maxTrades: 500,
  windowDurationMs: 24 * 60 * 60 * 1000, // 24 hours
  decayHalfLifeMs: 4 * 60 * 60 * 1000, // 4 hours
  minTradesForMetrics: 10,

  highVolatilityThreshold: 3.0,
  lowVolatilityThreshold: 1.0,

  drawdownWarningPct: 5.0,
  drawdownCriticalPct: 10.0,

  hedgeReduceFactor: 0.8,
  hedgeIncreaseFactor: 1.3,

  highWinRateThreshold: 0.6,
  lowWinRateThreshold: 0.4,

  acceptableSlippageCents: 1.0,
  highSlippageCents: 3.0,
};

// ═══════════════════════════════════════════════════════════════════════════
// HISTORICAL TRADE SNAPSHOT CLASS
// ═══════════════════════════════════════════════════════════════════════════

export class HistoricalTradeSnapshot {
  private readonly config: HistoricalSnapshotConfig;
  private trades: ExecutedTradeRecord[] = [];
  private drawdownState: DrawdownMetrics;

  constructor(config: Partial<HistoricalSnapshotConfig> = {}) {
    this.config = { ...DEFAULT_HISTORICAL_SNAPSHOT_CONFIG, ...config };
    this.drawdownState = {
      currentValue: 0,
      peakValue: 0,
      currentDrawdownPct: 0,
      maxDrawdownPct: 0,
      peakTimestamp: Date.now(),
      isInDrawdown: false,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TRADE RECORDING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record a completed trade
   */
  recordTrade(trade: ExecutedTradeRecord): void {
    this.trades.push(trade);

    // Update drawdown state
    this.updateDrawdown(trade.realizedPnlUsd);

    // Prune old trades
    this.pruneOldTrades();
  }

  /**
   * Convenience method to record trade from basic parameters
   */
  recordTradeFromParams(params: {
    tradeId: string;
    tokenId: string;
    marketId?: string;
    side: "LONG" | "SHORT";
    sizeUsd: number;
    entryPriceCents: number;
    exitPriceCents: number;
    expectedPriceCents?: number;
    wasHedged?: boolean;
    hedgeRatio?: number;
  }): void {
    const pnlCents =
      params.side === "LONG"
        ? params.exitPriceCents - params.entryPriceCents
        : params.entryPriceCents - params.exitPriceCents;

    const shares = params.sizeUsd / (params.entryPriceCents / 100);
    const pnlUsd = (pnlCents / 100) * shares;

    const trade: ExecutedTradeRecord = {
      tradeId: params.tradeId,
      tokenId: params.tokenId,
      marketId: params.marketId,
      side: params.side,
      sizeUsd: params.sizeUsd,
      entryPriceCents: params.entryPriceCents,
      exitPriceCents: params.exitPriceCents,
      expectedPriceCents: params.expectedPriceCents ?? params.entryPriceCents,
      realizedPnlCents: pnlCents,
      realizedPnlUsd: pnlUsd,
      timestamp: Date.now(),
      isWin: pnlCents > 0,
      wasHedged: params.wasHedged ?? false,
      hedgeRatio: params.hedgeRatio ?? 0,
    };

    this.recordTrade(trade);
  }

  /**
   * Update drawdown metrics after a trade
   */
  private updateDrawdown(pnlUsd: number): void {
    this.drawdownState.currentValue += pnlUsd;

    // Update peak if we have a new high
    if (this.drawdownState.currentValue > this.drawdownState.peakValue) {
      this.drawdownState.peakValue = this.drawdownState.currentValue;
      this.drawdownState.peakTimestamp = Date.now();
      this.drawdownState.isInDrawdown = false;
      this.drawdownState.currentDrawdownPct = 0;
    } else if (this.drawdownState.peakValue > 0) {
      // Calculate current drawdown
      const drawdown =
        this.drawdownState.peakValue - this.drawdownState.currentValue;
      this.drawdownState.currentDrawdownPct =
        (drawdown / this.drawdownState.peakValue) * 100;
      this.drawdownState.isInDrawdown =
        this.drawdownState.currentDrawdownPct > 0;

      // Track max drawdown
      if (
        this.drawdownState.currentDrawdownPct >
        this.drawdownState.maxDrawdownPct
      ) {
        this.drawdownState.maxDrawdownPct =
          this.drawdownState.currentDrawdownPct;
      }
    }
  }

  /**
   * Prune trades outside the rolling window
   */
  private pruneOldTrades(): void {
    const windowStart = Date.now() - this.config.windowDurationMs;
    this.trades = this.trades.filter((t) => t.timestamp >= windowStart);

    // Also enforce max trades limit
    while (this.trades.length > this.config.maxTrades) {
      this.trades.shift();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPONENTIAL DECAY WEIGHTING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Calculate exponential decay weight for a trade based on age
   * Weight = 0.5^(age / halfLife)
   */
  private calculateDecayWeight(timestamp: number): number {
    const age = Date.now() - timestamp;
    return Math.pow(0.5, age / this.config.decayHalfLifeMs);
  }

  /**
   * Calculate weighted average of values with exponential decay
   */
  private weightedAverage(
    values: { value: number; timestamp: number }[],
  ): number {
    if (values.length === 0) return 0;

    let weightedSum = 0;
    let totalWeight = 0;

    for (const { value, timestamp } of values) {
      const weight = this.calculateDecayWeight(timestamp);
      weightedSum += value * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // METRICS CALCULATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get current historical snapshot with all metrics
   */
  getSnapshot(): HistoricalSnapshot {
    const now = Date.now();

    return {
      timestamp: now,
      realizedPnlUsd: this.calculateRealizedPnlUsd(),
      realizedPnlCents: this.calculateRealizedPnlCents(),
      avgPnlPerTradeUsd: this.calculateAvgPnlPerTrade(),
      winRate: this.calculateWinRate(),
      profitFactor: this.calculateProfitFactor(),
      totalExposureUsd: this.calculateTotalExposure(),
      exposureByAsset: this.calculateExposureByAsset(),
      drawdown: { ...this.drawdownState },
      volatility: this.calculateVolatility(),
      frequency: this.calculateFrequency(),
      slippage: this.calculateSlippage(),
      tradeCount: this.trades.length,
      windowSizeMs: this.config.windowDurationMs,
      oldestTradeTimestamp:
        this.trades.length > 0 ? this.trades[0].timestamp : now,
    };
  }

  /**
   * Calculate time-weighted realized P&L in USD
   */
  private calculateRealizedPnlUsd(): number {
    return this.weightedAverage(
      this.trades.map((t) => ({
        value: t.realizedPnlUsd,
        timestamp: t.timestamp,
      })),
    );
  }

  /**
   * Calculate time-weighted realized P&L in cents
   */
  private calculateRealizedPnlCents(): number {
    return this.weightedAverage(
      this.trades.map((t) => ({
        value: t.realizedPnlCents,
        timestamp: t.timestamp,
      })),
    );
  }

  /**
   * Calculate average P&L per trade with decay weighting
   */
  private calculateAvgPnlPerTrade(): number {
    if (this.trades.length === 0) return 0;
    return this.calculateRealizedPnlUsd();
  }

  /**
   * Calculate win rate with decay weighting
   */
  private calculateWinRate(): number {
    if (this.trades.length === 0) return 0;

    // Weight wins by recency
    let weightedWins = 0;
    let totalWeight = 0;

    for (const trade of this.trades) {
      const weight = this.calculateDecayWeight(trade.timestamp);
      if (trade.isWin) {
        weightedWins += weight;
      }
      totalWeight += weight;
    }

    return totalWeight > 0 ? weightedWins / totalWeight : 0;
  }

  /**
   * Calculate profit factor (gross profit / gross loss)
   */
  private calculateProfitFactor(): number {
    let grossProfit = 0;
    let grossLoss = 0;

    for (const trade of this.trades) {
      const weight = this.calculateDecayWeight(trade.timestamp);
      if (trade.realizedPnlUsd > 0) {
        grossProfit += trade.realizedPnlUsd * weight;
      } else {
        grossLoss += Math.abs(trade.realizedPnlUsd) * weight;
      }
    }

    return grossLoss > 0
      ? grossProfit / grossLoss
      : grossProfit > 0
        ? Infinity
        : 0;
  }

  /**
   * Calculate total exposure from recent trades
   */
  private calculateTotalExposure(): number {
    // Sum absolute exposure from all trades
    return this.trades.reduce((sum, t) => sum + t.sizeUsd, 0);
  }

  /**
   * Calculate exposure breakdown by asset/market
   */
  private calculateExposureByAsset(): Map<string, AssetExposure> {
    const exposureMap = new Map<string, AssetExposure>();

    for (const trade of this.trades) {
      const marketId = trade.marketId || trade.tokenId;
      let exposure = exposureMap.get(marketId);

      if (!exposure) {
        exposure = {
          marketId,
          netExposureUsd: 0,
          longExposureUsd: 0,
          shortExposureUsd: 0,
          positionCount: 0,
          assetWinRate: 0,
          avgPnlUsd: 0,
        };
        exposureMap.set(marketId, exposure);
      }

      // Update exposure based on trade side
      if (trade.side === "LONG") {
        exposure.longExposureUsd += trade.sizeUsd;
        exposure.netExposureUsd += trade.sizeUsd;
      } else {
        exposure.shortExposureUsd += trade.sizeUsd;
        exposure.netExposureUsd -= trade.sizeUsd;
      }
      exposure.positionCount++;
    }

    // Calculate win rate and avg P&L per asset
    for (const [marketId, exposure] of exposureMap) {
      const assetTrades = this.trades.filter(
        (t) => (t.marketId || t.tokenId) === marketId,
      );
      const wins = assetTrades.filter((t) => t.isWin).length;
      const totalPnl = assetTrades.reduce(
        (sum, t) => sum + t.realizedPnlUsd,
        0,
      );

      exposure.assetWinRate =
        assetTrades.length > 0 ? wins / assetTrades.length : 0;
      exposure.avgPnlUsd =
        assetTrades.length > 0 ? totalPnl / assetTrades.length : 0;
    }

    return exposureMap;
  }

  /**
   * Calculate volatility metrics
   */
  private calculateVolatility(): VolatilityMetrics {
    if (this.trades.length < 2) {
      return {
        rollingStdDev: 0,
        avgAbsoluteReturn: 0,
        returnVariance: 0,
        volatilityRegime: "NORMAL",
        observationCount: this.trades.length,
      };
    }

    // Calculate returns (P&L per trade normalized by size)
    const returns = this.trades.map((t) =>
      t.sizeUsd > 0 ? t.realizedPnlUsd / t.sizeUsd : 0,
    );

    // Calculate mean with decay weighting
    const weightedMean = this.weightedAverage(
      this.trades.map((t, i) => ({
        value: returns[i],
        timestamp: t.timestamp,
      })),
    );

    // Calculate variance with decay weighting
    let weightedVariance = 0;
    let totalWeight = 0;

    for (let i = 0; i < this.trades.length; i++) {
      const weight = this.calculateDecayWeight(this.trades[i].timestamp);
      const diff = returns[i] - weightedMean;
      weightedVariance += weight * diff * diff;
      totalWeight += weight;
    }

    const variance = totalWeight > 0 ? weightedVariance / totalWeight : 0;
    const stdDev = Math.sqrt(variance);

    // Calculate average absolute return
    const avgAbsoluteReturn =
      returns.reduce((sum, r) => sum + Math.abs(r), 0) / returns.length;

    // Determine volatility regime
    let volatilityRegime: "LOW" | "NORMAL" | "HIGH" = "NORMAL";
    if (stdDev >= this.config.highVolatilityThreshold) {
      volatilityRegime = "HIGH";
    } else if (stdDev <= this.config.lowVolatilityThreshold) {
      volatilityRegime = "LOW";
    }

    return {
      rollingStdDev: stdDev,
      avgAbsoluteReturn,
      returnVariance: variance,
      volatilityRegime,
      observationCount: this.trades.length,
    };
  }

  /**
   * Calculate trade frequency metrics
   */
  private calculateFrequency(): TradeFrequencyMetrics {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    const tradesLastHour = this.trades.filter(
      (t) => t.timestamp >= oneHourAgo,
    ).length;
    const tradesLast24h = this.trades.filter(
      (t) => t.timestamp >= oneDayAgo,
    ).length;

    // Calculate average trades per hour
    const windowHours = this.config.windowDurationMs / (60 * 60 * 1000);
    const avgTradesPerHour =
      windowHours > 0 ? this.trades.length / windowHours : 0;

    // Time since last trade
    const lastTradeTime =
      this.trades.length > 0
        ? this.trades[this.trades.length - 1].timestamp
        : 0;
    const timeSinceLastTradeMs =
      lastTradeTime > 0 ? now - lastTradeTime : Infinity;

    // Determine frequency trend (compare last hour to average)
    let frequencyTrend: "INCREASING" | "DECREASING" | "STABLE" = "STABLE";
    if (tradesLastHour > avgTradesPerHour * 1.5) {
      frequencyTrend = "INCREASING";
    } else if (tradesLastHour < avgTradesPerHour * 0.5) {
      frequencyTrend = "DECREASING";
    }

    return {
      tradesLastHour,
      tradesLast24h,
      avgTradesPerHour,
      timeSinceLastTradeMs,
      frequencyTrend,
    };
  }

  /**
   * Calculate slippage metrics
   */
  private calculateSlippage(): SlippageMetrics {
    if (this.trades.length === 0) {
      return {
        avgSlippageCents: 0,
        avgSlippagePct: 0,
        maxSlippageCents: 0,
        slippageStdDev: 0,
        slippageTrend: "STABLE",
      };
    }

    // Calculate slippage for each trade (difference between expected and actual)
    const slippages = this.trades.map((t) =>
      Math.abs(t.entryPriceCents - t.expectedPriceCents),
    );

    // Weighted average slippage
    const avgSlippageCents = this.weightedAverage(
      this.trades.map((t, i) => ({
        value: slippages[i],
        timestamp: t.timestamp,
      })),
    );

    // Average slippage as percentage
    const avgSlippagePct =
      this.trades.length > 0
        ? this.weightedAverage(
            this.trades.map((t, i) => ({
              value:
                t.entryPriceCents > 0
                  ? (slippages[i] / t.entryPriceCents) * 100
                  : 0,
              timestamp: t.timestamp,
            })),
          )
        : 0;

    // Max slippage
    const maxSlippageCents = Math.max(...slippages, 0);

    // Slippage standard deviation
    const mean = slippages.reduce((a, b) => a + b, 0) / slippages.length;
    const variance =
      slippages.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) /
      slippages.length;
    const slippageStdDev = Math.sqrt(variance);

    // Determine slippage trend (compare recent to overall)
    const recentTrades = this.trades.slice(-Math.min(10, this.trades.length));
    const recentSlippages = recentTrades.map((t) =>
      Math.abs(t.entryPriceCents - t.expectedPriceCents),
    );
    const recentAvg =
      recentSlippages.length > 0
        ? recentSlippages.reduce((a, b) => a + b, 0) / recentSlippages.length
        : 0;

    let slippageTrend: "IMPROVING" | "WORSENING" | "STABLE" = "STABLE";
    if (recentAvg < avgSlippageCents * 0.8) {
      slippageTrend = "IMPROVING";
    } else if (recentAvg > avgSlippageCents * 1.2) {
      slippageTrend = "WORSENING";
    }

    return {
      avgSlippageCents,
      avgSlippagePct,
      maxSlippageCents,
      slippageStdDev,
      slippageTrend,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HEDGE RATIO RECOMMENDATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get hedge ratio recommendation based on historical analysis
   *
   * Decision Rules:
   * - REDUCE hedge when: high win rate + low volatility + positive P&L + no drawdown
   * - INCREASE hedge when: low win rate + high volatility + negative P&L + in drawdown
   * - MAINTAIN otherwise
   */
  getHedgeRatioRecommendation(): HedgeRatioRecommendation {
    const snapshot = this.getSnapshot();
    const reasons: string[] = [];

    // Check if we have enough data
    if (snapshot.tradeCount < this.config.minTradesForMetrics) {
      return {
        action: "MAINTAIN",
        adjustmentFactor: 1.0,
        confidence: 0.3,
        reasons: [
          `Insufficient data: ${snapshot.tradeCount} trades < ${this.config.minTradesForMetrics} minimum`,
        ],
        snapshot,
      };
    }

    // Score factors for reduce/increase decision
    let reduceScore = 0;
    let increaseScore = 0;

    // Factor 1: Win Rate
    if (snapshot.winRate >= this.config.highWinRateThreshold) {
      reduceScore += 2;
      reasons.push(
        `High win rate: ${(snapshot.winRate * 100).toFixed(1)}% >= ${(this.config.highWinRateThreshold * 100).toFixed(0)}%`,
      );
    } else if (snapshot.winRate <= this.config.lowWinRateThreshold) {
      increaseScore += 2;
      reasons.push(
        `Low win rate: ${(snapshot.winRate * 100).toFixed(1)}% <= ${(this.config.lowWinRateThreshold * 100).toFixed(0)}%`,
      );
    }

    // Factor 2: Volatility Regime
    if (snapshot.volatility.volatilityRegime === "LOW") {
      reduceScore += 1;
      reasons.push(
        `Low volatility regime (σ=${snapshot.volatility.rollingStdDev.toFixed(3)})`,
      );
    } else if (snapshot.volatility.volatilityRegime === "HIGH") {
      increaseScore += 2;
      reasons.push(
        `High volatility regime (σ=${snapshot.volatility.rollingStdDev.toFixed(3)})`,
      );
    }

    // Factor 3: Drawdown Status
    if (!snapshot.drawdown.isInDrawdown) {
      reduceScore += 1;
      reasons.push("Not in drawdown");
    } else if (
      snapshot.drawdown.currentDrawdownPct >= this.config.drawdownCriticalPct
    ) {
      increaseScore += 3;
      reasons.push(
        `Critical drawdown: ${snapshot.drawdown.currentDrawdownPct.toFixed(1)}% >= ${this.config.drawdownCriticalPct}%`,
      );
    } else if (
      snapshot.drawdown.currentDrawdownPct >= this.config.drawdownWarningPct
    ) {
      increaseScore += 1;
      reasons.push(
        `Warning drawdown: ${snapshot.drawdown.currentDrawdownPct.toFixed(1)}% >= ${this.config.drawdownWarningPct}%`,
      );
    }

    // Factor 4: P&L Trend
    if (snapshot.avgPnlPerTradeUsd > 0) {
      reduceScore += 1;
      reasons.push(
        `Positive avg P&L: $${snapshot.avgPnlPerTradeUsd.toFixed(2)}/trade`,
      );
    } else if (snapshot.avgPnlPerTradeUsd < 0) {
      increaseScore += 1;
      reasons.push(
        `Negative avg P&L: $${snapshot.avgPnlPerTradeUsd.toFixed(2)}/trade`,
      );
    }

    // Factor 5: Profit Factor
    if (
      Number.isFinite(snapshot.profitFactor) &&
      snapshot.profitFactor >= 1.5
    ) {
      reduceScore += 1;
      reasons.push(`Strong profit factor: ${snapshot.profitFactor.toFixed(2)}`);
    } else if (snapshot.profitFactor < 1.0) {
      increaseScore += 1;
      reasons.push(`Weak profit factor: ${snapshot.profitFactor.toFixed(2)}`);
    }

    // Factor 6: Slippage Trend
    if (snapshot.slippage.slippageTrend === "WORSENING") {
      increaseScore += 1;
      reasons.push("Worsening slippage trend");
    } else if (snapshot.slippage.slippageTrend === "IMPROVING") {
      reduceScore += 1;
      reasons.push("Improving slippage trend");
    }

    // Determine action and adjustment factor
    let action: "REDUCE" | "MAINTAIN" | "INCREASE";
    let adjustmentFactor: number;
    let confidence: number;

    const scoreDiff = reduceScore - increaseScore;

    if (scoreDiff >= 3) {
      // Strong signal to reduce
      action = "REDUCE";
      adjustmentFactor = this.config.hedgeReduceFactor;
      confidence = Math.min(1, 0.5 + scoreDiff * 0.1);
    } else if (scoreDiff <= -3) {
      // Strong signal to increase
      action = "INCREASE";
      adjustmentFactor = this.config.hedgeIncreaseFactor;
      confidence = Math.min(1, 0.5 + Math.abs(scoreDiff) * 0.1);
    } else {
      // Mixed signals - maintain current
      action = "MAINTAIN";
      adjustmentFactor = 1.0;
      confidence = 0.6;
      if (reasons.length === 0) {
        reasons.push("Balanced conditions - no adjustment needed");
      }
    }

    return {
      action,
      adjustmentFactor,
      confidence,
      reasons,
      snapshot,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UTILITY METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Reset all state
   */
  reset(): void {
    this.trades = [];
    this.drawdownState = {
      currentValue: 0,
      peakValue: 0,
      currentDrawdownPct: 0,
      maxDrawdownPct: 0,
      peakTimestamp: Date.now(),
      isInDrawdown: false,
    };
  }

  /**
   * Get trade count
   */
  getTradeCount(): number {
    return this.trades.length;
  }

  /**
   * Get recent trades
   */
  getRecentTrades(count: number = 10): ExecutedTradeRecord[] {
    return this.trades.slice(-count);
  }

  /**
   * Check if there is sufficient data for reliable metrics
   */
  hasMinimumData(): boolean {
    return this.trades.length >= this.config.minTradesForMetrics;
  }

  /**
   * Export state for logging
   */
  toLogEntry(): object {
    const snapshot = this.getSnapshot();
    const recommendation = this.getHedgeRatioRecommendation();

    return {
      type: "historical_trade_snapshot",
      timestamp: new Date().toISOString(),
      tradeCount: snapshot.tradeCount,
      windowSizeMs: snapshot.windowSizeMs,
      metrics: {
        realizedPnlUsd: parseFloat(snapshot.realizedPnlUsd.toFixed(2)),
        avgPnlPerTradeUsd: parseFloat(snapshot.avgPnlPerTradeUsd.toFixed(2)),
        winRate: parseFloat(snapshot.winRate.toFixed(4)),
        profitFactor: Number.isFinite(snapshot.profitFactor)
          ? parseFloat(snapshot.profitFactor.toFixed(2))
          : "∞",
      },
      drawdown: {
        currentPct: parseFloat(snapshot.drawdown.currentDrawdownPct.toFixed(2)),
        maxPct: parseFloat(snapshot.drawdown.maxDrawdownPct.toFixed(2)),
        isInDrawdown: snapshot.drawdown.isInDrawdown,
      },
      volatility: {
        stdDev: parseFloat(snapshot.volatility.rollingStdDev.toFixed(4)),
        regime: snapshot.volatility.volatilityRegime,
      },
      frequency: {
        tradesLastHour: snapshot.frequency.tradesLastHour,
        avgTradesPerHour: parseFloat(
          snapshot.frequency.avgTradesPerHour.toFixed(2),
        ),
        trend: snapshot.frequency.frequencyTrend,
      },
      slippage: {
        avgCents: parseFloat(snapshot.slippage.avgSlippageCents.toFixed(2)),
        trend: snapshot.slippage.slippageTrend,
      },
      hedgeRecommendation: {
        action: recommendation.action,
        adjustmentFactor: parseFloat(
          recommendation.adjustmentFactor.toFixed(2),
        ),
        confidence: parseFloat(recommendation.confidence.toFixed(2)),
        reasons: recommendation.reasons,
      },
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a new Historical Trade Snapshot with optional configuration overrides
 */
export function createHistoricalTradeSnapshot(
  config: Partial<HistoricalSnapshotConfig> = {},
): HistoricalTradeSnapshot {
  return new HistoricalTradeSnapshot(config);
}
