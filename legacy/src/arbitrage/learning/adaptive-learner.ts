/**
 * Adaptive Trade Learning System
 *
 * Smart trading system that learns from past trades to prevent bad trades:
 * - Tracks trade outcomes (wins, losses, breakeven)
 * - Learns which market conditions lead to profitable trades
 * - Adjusts confidence scores based on historical performance
 * - Implements pattern recognition for avoiding repeated mistakes
 *
 * Key strategies implemented:
 * 1. Intra-market arbitrage (YES + NO < $1.00)
 * 2. Market-specific learning (some markets behave differently)
 * 3. Time-of-day patterns (volatility varies)
 * 4. Spread and liquidity correlation with success
 */

import type { Logger } from "../../utils/logger.util";

/**
 * Record of a completed trade
 */
export interface TradeRecord {
  id: string;
  marketId: string;
  timestamp: number;
  entryPrice: number;
  exitPrice?: number;
  sizeUsd: number;
  edgeBps: number;
  spreadBps: number;
  liquidityUsd?: number;
  outcome: "win" | "loss" | "breakeven" | "pending";
  profitUsd?: number;
  profitBps?: number;
  holdTimeMs?: number;
  /** Hour of day (0-23) when trade was made */
  hourOfDay: number;
  /** Day of week (0-6, Sunday=0) */
  dayOfWeek: number;
  /** Volatility bucket at time of trade */
  volatilityBucket: "low" | "medium" | "high";
}

/**
 * Market-specific performance statistics
 */
export interface MarketStats {
  marketId: string;
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number;
  avgProfitBps: number;
  avgLossBps: number;
  avgEdgeBps: number;
  avgSpreadBps: number;
  /** Confidence score 0-100, based on historical performance */
  confidenceScore: number;
  lastTradeAt?: number;
  /** Consecutive losses - triggers caution */
  consecutiveLosses: number;
  /** Is this market currently on the "avoid" list */
  isAvoided: boolean;
  avoidUntil?: number;
}

/**
 * Global trading statistics
 */
export interface GlobalStats {
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number;
  totalProfitUsd: number;
  avgProfitPerTrade: number;
  bestHourOfDay: number;
  worstHourOfDay: number;
  avgHoldTimeMs: number;
  /** Edge threshold that historically works */
  effectiveMinEdgeBps: number;
  /** Spread threshold that historically works */
  effectiveMaxSpreadBps: number;
}

/**
 * Trade evaluation result
 */
export interface TradeEvaluation {
  /** Should we take this trade? */
  shouldTrade: boolean;
  /** Confidence level 0-100 */
  confidence: number;
  /** Reasons for decision */
  reasons: string[];
  /** Suggested adjustments */
  adjustments: {
    /** Suggested size multiplier (0.5 = half size, 1.5 = 1.5x size) */
    sizeMultiplier: number;
    /** Should we set tighter stop loss? */
    tighterStopLoss: boolean;
    /** Suggested max hold time */
    maxHoldTimeMs?: number;
  };
}

/**
 * Configuration for the learning system
 */
export interface LearningConfig {
  /** Minimum trades before we trust market-specific stats */
  minTradesForConfidence: number;
  /** Number of consecutive losses before avoiding a market */
  maxConsecutiveLosses: number;
  /** How long to avoid a market after consecutive losses (ms) */
  avoidDurationMs: number;
  /** Minimum win rate to maintain confidence */
  minWinRate: number;
  /** Weight of recent trades vs old trades (0-1) */
  recencyWeight: number;
  /** Maximum number of trade records to keep in memory */
  maxTradeHistory: number;
}

const DEFAULT_CONFIG: LearningConfig = {
  minTradesForConfidence: 5,
  maxConsecutiveLosses: 3,
  avoidDurationMs: 30 * 60 * 1000, // 30 minutes
  minWinRate: 0.5,
  recencyWeight: 0.7,
  maxTradeHistory: 1000,
};

/**
 * Adaptive Trade Learning System
 */
export class AdaptiveTradeLearner {
  private trades: TradeRecord[] = [];
  private marketStats: Map<string, MarketStats> = new Map();
  private globalStats: GlobalStats;
  private config: LearningConfig;
  private logger?: Logger;

  constructor(config: Partial<LearningConfig> = {}, logger?: Logger) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;
    this.globalStats = this.initGlobalStats();
  }

  private initGlobalStats(): GlobalStats {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      breakevens: 0,
      winRate: 0,
      totalProfitUsd: 0,
      avgProfitPerTrade: 0,
      bestHourOfDay: 12,
      worstHourOfDay: 3,
      avgHoldTimeMs: 0,
      effectiveMinEdgeBps: 50, // Default starting point
      effectiveMaxSpreadBps: 200, // Default starting point
    };
  }

  /**
   * Record a new trade
   */
  recordTrade(
    trade: Omit<
      TradeRecord,
      "id" | "hourOfDay" | "dayOfWeek" | "volatilityBucket"
    >,
  ): string {
    const id = `trade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const date = new Date(trade.timestamp);

    const fullTrade: TradeRecord = {
      ...trade,
      id,
      hourOfDay: date.getUTCHours(),
      dayOfWeek: date.getUTCDay(),
      volatilityBucket: this.classifyVolatility(trade.spreadBps),
    };

    this.trades.push(fullTrade);

    // Trim old trades if needed
    if (this.trades.length > this.config.maxTradeHistory) {
      this.trades = this.trades.slice(-this.config.maxTradeHistory);
    }

    this.log(
      "debug",
      `[Learn] 📝 Recorded trade ${id} for market ${trade.marketId.slice(0, 12)}...`,
    );
    return id;
  }

  /**
   * Update trade outcome when it completes
   */
  updateTradeOutcome(
    tradeId: string,
    outcome: "win" | "loss" | "breakeven",
    exitPrice: number,
    profitUsd: number,
    holdTimeMs: number,
  ): void {
    const trade = this.trades.find((t) => t.id === tradeId);
    if (!trade) {
      this.log("warn", `[Learn] ⚠️  Trade ${tradeId} not found`);
      return;
    }

    trade.outcome = outcome;
    trade.exitPrice = exitPrice;
    trade.profitUsd = profitUsd;
    trade.profitBps = (profitUsd / trade.sizeUsd) * 10000;
    trade.holdTimeMs = holdTimeMs;

    // Update statistics
    this.updateMarketStats(trade);
    this.updateGlobalStats();

    const icon = outcome === "win" ? "✅" : outcome === "loss" ? "❌" : "➖";
    this.log(
      "info",
      `[Learn] ${icon} Trade completed: ${outcome} ($${profitUsd.toFixed(2)})`,
    );
  }

  /**
   * Evaluate whether to take a trade
   */
  evaluateTrade(params: {
    marketId: string;
    edgeBps: number;
    spreadBps: number;
    sizeUsd: number;
    liquidityUsd?: number;
  }): TradeEvaluation {
    const reasons: string[] = [];
    let confidence = 70; // Start with moderate confidence
    const adjustments = {
      sizeMultiplier: 1.0,
      tighterStopLoss: false,
      maxHoldTimeMs: undefined as number | undefined,
    };

    const now = Date.now();
    const hourOfDay = new Date(now).getUTCHours();

    // Check market-specific stats
    const marketStats = this.marketStats.get(params.marketId);
    if (marketStats) {
      // Check if market is on avoid list
      if (
        marketStats.isAvoided &&
        marketStats.avoidUntil &&
        marketStats.avoidUntil > now
      ) {
        const remainingMs = marketStats.avoidUntil - now;
        const remainingMin = Math.ceil(remainingMs / 60000);
        return {
          shouldTrade: false,
          confidence: 0,
          reasons: [
            `❌ Market avoided (${marketStats.consecutiveLosses} losses, ${remainingMin}m remaining)`,
          ],
          adjustments,
        };
      }

      // Clear avoid status if expired
      if (
        marketStats.isAvoided &&
        marketStats.avoidUntil &&
        marketStats.avoidUntil <= now
      ) {
        marketStats.isAvoided = false;
        marketStats.avoidUntil = undefined;
        this.log(
          "info",
          `[Learn] ✅ Market ${params.marketId.slice(0, 12)}... removed from avoid list`,
        );
      }

      // Adjust confidence based on market performance
      if (marketStats.totalTrades >= this.config.minTradesForConfidence) {
        confidence = marketStats.confidenceScore;

        if (marketStats.winRate < this.config.minWinRate) {
          reasons.push(
            `⚠️  Low win rate (${(marketStats.winRate * 100).toFixed(0)}%)`,
          );
          adjustments.sizeMultiplier *= 0.5;
          adjustments.tighterStopLoss = true;
        }

        if (marketStats.winRate > 0.7) {
          reasons.push(
            `✅ High win rate (${(marketStats.winRate * 100).toFixed(0)}%)`,
          );
          adjustments.sizeMultiplier *= 1.2;
        }
      }
    }

    // Check edge threshold
    if (params.edgeBps < this.globalStats.effectiveMinEdgeBps) {
      confidence -= 20;
      reasons.push(
        `⚠️  Edge below threshold (${params.edgeBps} < ${this.globalStats.effectiveMinEdgeBps}bps)`,
      );
      adjustments.sizeMultiplier *= 0.7;
    }

    // Check spread threshold
    if (params.spreadBps > this.globalStats.effectiveMaxSpreadBps) {
      confidence -= 15;
      reasons.push(
        `⚠️  Spread above threshold (${params.spreadBps} > ${this.globalStats.effectiveMaxSpreadBps}bps)`,
      );
      adjustments.sizeMultiplier *= 0.8;
    }

    // Time-of-day analysis
    if (hourOfDay === this.globalStats.worstHourOfDay) {
      confidence -= 10;
      reasons.push(`⚠️  Worst trading hour (${hourOfDay}:00 UTC)`);
      adjustments.sizeMultiplier *= 0.8;
    } else if (hourOfDay === this.globalStats.bestHourOfDay) {
      confidence += 5;
      reasons.push(`✅ Best trading hour (${hourOfDay}:00 UTC)`);
    }

    // Liquidity check
    if (params.liquidityUsd !== undefined && params.liquidityUsd < 1000) {
      confidence -= 15;
      reasons.push(`⚠️  Low liquidity ($${params.liquidityUsd.toFixed(0)})`);
      adjustments.sizeMultiplier *= 0.5;
      adjustments.tighterStopLoss = true;
    }

    // Final decision
    const shouldTrade = confidence >= 50;

    if (!shouldTrade && reasons.length === 0) {
      reasons.push("❌ Confidence too low");
    }

    // Ensure size multiplier is reasonable
    adjustments.sizeMultiplier = Math.max(
      0.25,
      Math.min(2.0, adjustments.sizeMultiplier),
    );

    return {
      shouldTrade,
      confidence: Math.max(0, Math.min(100, confidence)),
      reasons,
      adjustments,
    };
  }

  /**
   * Get suggested parameters based on learning
   */
  getSuggestedParameters(): {
    minEdgeBps: number;
    maxSpreadBps: number;
    optimalHours: number[];
    avoidHours: number[];
  } {
    // Analyze winning trades to find optimal parameters
    const winningTrades = this.trades.filter((t) => t.outcome === "win");

    let minEdgeBps = this.globalStats.effectiveMinEdgeBps;
    let maxSpreadBps = this.globalStats.effectiveMaxSpreadBps;

    if (winningTrades.length >= 10) {
      // Calculate 25th percentile of winning trade edges
      const sortedEdges = winningTrades
        .map((t) => t.edgeBps)
        .sort((a, b) => a - b);
      minEdgeBps =
        sortedEdges[Math.floor(sortedEdges.length * 0.25)] || minEdgeBps;

      // Calculate 75th percentile of winning trade spreads
      const sortedSpreads = winningTrades
        .map((t) => t.spreadBps)
        .sort((a, b) => a - b);
      maxSpreadBps =
        sortedSpreads[Math.floor(sortedSpreads.length * 0.75)] || maxSpreadBps;
    }

    // Analyze hours
    const hourWinRates = new Map<number, { wins: number; total: number }>();
    for (const trade of this.trades) {
      if (trade.outcome === "pending") continue;
      const hour = trade.hourOfDay;
      const stats = hourWinRates.get(hour) || { wins: 0, total: 0 };
      stats.total++;
      if (trade.outcome === "win") stats.wins++;
      hourWinRates.set(hour, stats);
    }

    const optimalHours: number[] = [];
    const avoidHours: number[] = [];

    for (const [hour, stats] of hourWinRates) {
      if (stats.total >= 5) {
        const winRate = stats.wins / stats.total;
        if (winRate >= 0.6) optimalHours.push(hour);
        if (winRate < 0.4) avoidHours.push(hour);
      }
    }

    return {
      minEdgeBps,
      maxSpreadBps,
      optimalHours: optimalHours.sort((a, b) => a - b),
      avoidHours: avoidHours.sort((a, b) => a - b),
    };
  }

  /**
   * Get current statistics
   */
  getStats(): { global: GlobalStats; markets: MarketStats[] } {
    return {
      global: { ...this.globalStats },
      markets: Array.from(this.marketStats.values()),
    };
  }

  /**
   * Print a summary report
   */
  printSummary(): void {
    this.log("info", "");
    this.log("info", "═".repeat(50));
    this.log("info", "📊 ADAPTIVE LEARNING SUMMARY");
    this.log("info", "═".repeat(50));

    const g = this.globalStats;
    if (g.totalTrades === 0) {
      this.log("info", "   No trades recorded yet");
      this.log("info", "═".repeat(50));
      return;
    }

    const winIcon = g.winRate >= 0.5 ? "✅" : "⚠️";
    this.log("info", `   Total Trades: ${g.totalTrades}`);
    this.log(
      "info",
      `   ${winIcon} Win Rate: ${(g.winRate * 100).toFixed(1)}% (${g.wins}W/${g.losses}L/${g.breakevens}BE)`,
    );
    this.log(
      "info",
      `   💰 Total P/L: $${g.totalProfitUsd >= 0 ? "+" : ""}${g.totalProfitUsd.toFixed(2)}`,
    );
    this.log(
      "info",
      `   📈 Avg/Trade: $${g.avgProfitPerTrade >= 0 ? "+" : ""}${g.avgProfitPerTrade.toFixed(2)}`,
    );
    this.log("info", `   ⏰ Best Hour: ${g.bestHourOfDay}:00 UTC`);
    this.log(
      "info",
      `   📊 Min Edge: ${g.effectiveMinEdgeBps}bps | Max Spread: ${g.effectiveMaxSpreadBps}bps`,
    );

    const avoidedMarkets = Array.from(this.marketStats.values()).filter(
      (m) => m.isAvoided,
    );
    if (avoidedMarkets.length > 0) {
      this.log("info", "");
      this.log("warn", `   ⛔ Avoided Markets: ${avoidedMarkets.length}`);
    }

    this.log("info", "═".repeat(50));
  }

  /**
   * Export state for persistence
   */
  exportState(): {
    trades: TradeRecord[];
    marketStats: [string, MarketStats][];
    globalStats: GlobalStats;
  } {
    return {
      trades: this.trades,
      marketStats: Array.from(this.marketStats.entries()),
      globalStats: this.globalStats,
    };
  }

  /**
   * Import state from persistence
   */
  importState(state: {
    trades: TradeRecord[];
    marketStats: [string, MarketStats][];
    globalStats: GlobalStats;
  }): void {
    this.trades = state.trades;
    this.marketStats = new Map(state.marketStats);
    this.globalStats = state.globalStats;
    this.log(
      "info",
      `[Learn] ✅ Loaded ${this.trades.length} trades, ${this.marketStats.size} markets`,
    );
  }

  /**
   * Reset all learning data
   */
  reset(): void {
    this.trades = [];
    this.marketStats.clear();
    this.globalStats = this.initGlobalStats();
    this.log("info", "[Learn] 🔄 Learning data reset");
  }

  // Private methods

  private classifyVolatility(spreadBps: number): "low" | "medium" | "high" {
    if (spreadBps < 50) return "low";
    if (spreadBps < 150) return "medium";
    return "high";
  }

  private updateMarketStats(trade: TradeRecord): void {
    let stats = this.marketStats.get(trade.marketId);

    if (!stats) {
      stats = {
        marketId: trade.marketId,
        totalTrades: 0,
        wins: 0,
        losses: 0,
        breakevens: 0,
        winRate: 0,
        avgProfitBps: 0,
        avgLossBps: 0,
        avgEdgeBps: 0,
        avgSpreadBps: 0,
        confidenceScore: 70,
        consecutiveLosses: 0,
        isAvoided: false,
      };
    }

    stats.totalTrades++;
    stats.lastTradeAt = trade.timestamp;

    // Update outcome counts
    if (trade.outcome === "win") {
      stats.wins++;
      stats.consecutiveLosses = 0;
    } else if (trade.outcome === "loss") {
      stats.losses++;
      stats.consecutiveLosses++;

      // Check if we should avoid this market
      if (stats.consecutiveLosses >= this.config.maxConsecutiveLosses) {
        stats.isAvoided = true;
        stats.avoidUntil = Date.now() + this.config.avoidDurationMs;
        this.log(
          "warn",
          `[Learn] ⛔ Market ${trade.marketId.slice(0, 12)}... added to avoid list (${stats.consecutiveLosses} losses)`,
        );
      }
    } else {
      stats.breakevens++;
    }

    // Recalculate rates
    stats.winRate = stats.totalTrades > 0 ? stats.wins / stats.totalTrades : 0;

    // Update averages (exponential moving average with recency weight)
    const alpha = this.config.recencyWeight;
    stats.avgEdgeBps = alpha * trade.edgeBps + (1 - alpha) * stats.avgEdgeBps;
    stats.avgSpreadBps =
      alpha * trade.spreadBps + (1 - alpha) * stats.avgSpreadBps;

    if (trade.profitBps !== undefined) {
      if (trade.outcome === "win") {
        stats.avgProfitBps =
          alpha * trade.profitBps +
          (1 - alpha) * (stats.avgProfitBps || trade.profitBps);
      } else if (trade.outcome === "loss") {
        stats.avgLossBps =
          alpha * Math.abs(trade.profitBps) +
          (1 - alpha) * (stats.avgLossBps || Math.abs(trade.profitBps));
      }
    }

    // Update confidence score
    stats.confidenceScore = this.calculateConfidenceScore(stats);

    this.marketStats.set(trade.marketId, stats);
  }

  private calculateConfidenceScore(stats: MarketStats): number {
    let score = 50; // Base score

    // Win rate contribution (0-30 points)
    score += (stats.winRate - 0.5) * 60;

    // Trade count contribution (0-10 points for reliability)
    const reliability = Math.min(stats.totalTrades / 20, 1);
    score += reliability * 10;

    // Consecutive losses penalty
    score -= stats.consecutiveLosses * 5;

    // Profit ratio contribution
    if (stats.avgProfitBps > 0 && stats.avgLossBps > 0) {
      const profitRatio = stats.avgProfitBps / stats.avgLossBps;
      score += Math.min(profitRatio - 1, 2) * 10;
    }

    return Math.max(0, Math.min(100, score));
  }

  private updateGlobalStats(): void {
    const completedTrades = this.trades.filter((t) => t.outcome !== "pending");

    this.globalStats.totalTrades = completedTrades.length;
    this.globalStats.wins = completedTrades.filter(
      (t) => t.outcome === "win",
    ).length;
    this.globalStats.losses = completedTrades.filter(
      (t) => t.outcome === "loss",
    ).length;
    this.globalStats.breakevens = completedTrades.filter(
      (t) => t.outcome === "breakeven",
    ).length;
    this.globalStats.winRate =
      this.globalStats.totalTrades > 0
        ? this.globalStats.wins / this.globalStats.totalTrades
        : 0;

    this.globalStats.totalProfitUsd = completedTrades.reduce(
      (sum, t) => sum + (t.profitUsd || 0),
      0,
    );
    this.globalStats.avgProfitPerTrade =
      this.globalStats.totalTrades > 0
        ? this.globalStats.totalProfitUsd / this.globalStats.totalTrades
        : 0;

    // Calculate average hold time
    const tradesWithHoldTime = completedTrades.filter(
      (t) => t.holdTimeMs !== undefined,
    );
    this.globalStats.avgHoldTimeMs =
      tradesWithHoldTime.length > 0
        ? tradesWithHoldTime.reduce((sum, t) => sum + (t.holdTimeMs || 0), 0) /
          tradesWithHoldTime.length
        : 0;

    // Find best and worst hours
    const hourStats = new Map<number, { wins: number; total: number }>();
    for (const trade of completedTrades) {
      const stats = hourStats.get(trade.hourOfDay) || { wins: 0, total: 0 };
      stats.total++;
      if (trade.outcome === "win") stats.wins++;
      hourStats.set(trade.hourOfDay, stats);
    }

    let bestRate = 0;
    let worstRate = 1;
    for (const [hour, stats] of hourStats) {
      if (stats.total >= 3) {
        const rate = stats.wins / stats.total;
        if (rate > bestRate) {
          bestRate = rate;
          this.globalStats.bestHourOfDay = hour;
        }
        if (rate < worstRate) {
          worstRate = rate;
          this.globalStats.worstHourOfDay = hour;
        }
      }
    }

    // Update effective thresholds based on winning trades
    const winningTrades = completedTrades.filter((t) => t.outcome === "win");
    if (winningTrades.length >= 10) {
      const edges = winningTrades.map((t) => t.edgeBps).sort((a, b) => a - b);
      this.globalStats.effectiveMinEdgeBps =
        edges[Math.floor(edges.length * 0.2)] || 50;

      const spreads = winningTrades
        .map((t) => t.spreadBps)
        .sort((a, b) => a - b);
      this.globalStats.effectiveMaxSpreadBps =
        spreads[Math.floor(spreads.length * 0.8)] || 200;
    }
  }

  private log(
    level: "info" | "warn" | "error" | "debug",
    message: string,
  ): void {
    if (this.logger) {
      this.logger[level](message);
    }
  }
}

// Global singleton
let globalLearner: AdaptiveTradeLearner | null = null;

/**
 * Get or create the global adaptive learner
 */
export function getAdaptiveLearner(logger?: Logger): AdaptiveTradeLearner {
  if (!globalLearner) {
    globalLearner = new AdaptiveTradeLearner({}, logger);
  }
  return globalLearner;
}

/**
 * Reset the global learner (for testing)
 */
export function resetAdaptiveLearner(): void {
  globalLearner?.reset();
  globalLearner = null;
}
