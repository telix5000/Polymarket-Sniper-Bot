/**
 * APEX v3.0 - Oracle Performance Tracker
 * 
 * Daily performance review that reallocates capital to winners
 * Tracks last 24 hours in memory (stateless)
 */

import type { StrategyType } from "./scaling";

// Time windows (configurable)
const ORACLE_REVIEW_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RECENT_TRADES_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const MARKET_ANALYSIS_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours

export interface StrategyPerformance {
  strategy: StrategyType;
  wins: number;
  losses: number;
  totalTrades: number;
  totalPnL: number;
  avgProfit: number;
  winRate: number;
  score: number;
  rank: OracleRank;
  allocation: number; // Capital allocation percentage
}

export enum OracleRank {
  CHAMPION = "CHAMPION",       // 75+ score
  PERFORMING = "PERFORMING",   // 55-75 score
  TESTING = "TESTING",         // 40-55 score
  STRUGGLING = "STRUGGLING",   // 30-40 score
  DISABLED = "DISABLED",       // <30 score
}

export interface TradeRecord {
  strategy: StrategyType;
  timestamp: number;
  pnl: number;
  success: boolean;
  tokenId: string;
  reason: string;
}

export interface OracleState {
  trades: TradeRecord[];
  lastReviewTime: number;
  reviewCount: number;
  marketCondition: MarketCondition;
}

export enum MarketCondition {
  BULL = "BULL",       // High volume, good opportunities
  NEUTRAL = "NEUTRAL", // Normal conditions
  BEAR = "BEAR",       // Low volume, few opportunities
  VOLATILE = "VOLATILE", // High volatility, risky
}

/**
 * Create initial Oracle state
 */
export function createOracleState(): OracleState {
  return {
    trades: [],
    lastReviewTime: Date.now(),
    reviewCount: 0,
    marketCondition: MarketCondition.NEUTRAL,
  };
}

/**
 * Record a trade for tracking
 */
export function recordTrade(
  state: OracleState,
  strategy: StrategyType,
  pnl: number,
  success: boolean,
  tokenId: string,
  reason: string,
): void {
  state.trades.push({
    strategy,
    timestamp: Date.now(),
    pnl,
    success,
    tokenId,
    reason,
  });

  // Keep only last 24 hours
  const cutoff = Date.now() - RECENT_TRADES_WINDOW_MS;
  state.trades = state.trades.filter((t) => t.timestamp > cutoff);
}

/**
 * Calculate priority score: (winRate × 0.6) + (avgProfit × 10 × 0.4)
 */
function calculateScore(winRate: number, avgProfit: number): number {
  return winRate * 0.6 + avgProfit * 10 * 0.4;
}

/**
 * Determine rank from score
 */
function getRank(score: number): OracleRank {
  if (score >= 75) return OracleRank.CHAMPION;
  if (score >= 55) return OracleRank.PERFORMING;
  if (score >= 40) return OracleRank.TESTING;
  if (score >= 30) return OracleRank.STRUGGLING;
  return OracleRank.DISABLED;
}

/**
 * Analyze strategy performance
 */
export function analyzePerformance(
  state: OracleState,
  strategies: StrategyType[],
): StrategyPerformance[] {
  const performances: StrategyPerformance[] = [];

  for (const strategy of strategies) {
    const strategyTrades = state.trades.filter((t) => t.strategy === strategy);

    if (strategyTrades.length === 0) {
      performances.push({
        strategy,
        wins: 0,
        losses: 0,
        totalTrades: 0,
        totalPnL: 0,
        avgProfit: 0,
        winRate: 0,
        score: 0,
        rank: OracleRank.TESTING,
        allocation: 0,
      });
      continue;
    }

    const wins = strategyTrades.filter((t) => t.success).length;
    const losses = strategyTrades.length - wins;
    const totalPnL = strategyTrades.reduce((sum, t) => sum + t.pnl, 0);
    const avgProfit = totalPnL / strategyTrades.length;
    const winRate = (wins / strategyTrades.length) * 100;
    const score = calculateScore(winRate, avgProfit);
    const rank = getRank(score);

    performances.push({
      strategy,
      wins,
      losses,
      totalTrades: strategyTrades.length,
      totalPnL,
      avgProfit,
      winRate,
      score,
      rank,
      allocation: 0, // Will be calculated in allocation step
    });
  }

  return performances;
}

/**
 * Calculate optimal capital allocations
 */
export function calculateAllocations(
  performances: StrategyPerformance[],
): StrategyPerformance[] {
  // Filter out disabled strategies
  const activePerformances = performances.filter((p) => p.rank !== OracleRank.DISABLED);

  if (activePerformances.length === 0) {
    // All disabled, give equal allocation to testing
    const equalAllocation = 100 / performances.length;
    return performances.map((p) => ({ ...p, allocation: equalAllocation }));
  }

  // Calculate total score of active strategies
  const totalScore = activePerformances.reduce((sum, p) => sum + Math.max(p.score, 1), 0);

  // Allocate proportionally to score
  const updated = performances.map((p) => {
    if (p.rank === OracleRank.DISABLED) {
      return { ...p, allocation: 0 };
    }

    const allocation = (Math.max(p.score, 1) / totalScore) * 100;
    return { ...p, allocation };
  });

  return updated;
}

/**
 * Analyze market conditions from recent activity
 */
export function analyzeMarketConditions(state: OracleState): MarketCondition {
  const recentTrades = state.trades.filter((t) => t.timestamp > Date.now() - MARKET_ANALYSIS_WINDOW_MS);

  if (recentTrades.length < 5) {
    return MarketCondition.BEAR;
  }

  const avgPnL = recentTrades.reduce((sum, t) => sum + t.pnl, 0) / recentTrades.length;
  const successRate = recentTrades.filter((t) => t.success).length / recentTrades.length;

  // Calculate volatility (standard deviation of PnL)
  const variance =
    recentTrades.reduce((sum, t) => sum + Math.pow(t.pnl - avgPnL, 2), 0) /
    recentTrades.length;
  const volatility = Math.sqrt(variance);

  if (volatility > 10) {
    return MarketCondition.VOLATILE;
  }

  if (successRate > 0.6 && avgPnL > 2) {
    return MarketCondition.BULL;
  }

  if (successRate < 0.4 || avgPnL < -1) {
    return MarketCondition.BEAR;
  }

  return MarketCondition.NEUTRAL;
}

/**
 * Run daily Oracle review
 */
export function runOracleReview(
  state: OracleState,
  strategies: StrategyType[],
): StrategyPerformance[] {
  const performances = analyzePerformance(state, strategies);
  const allocations = calculateAllocations(performances);
  const marketCondition = analyzeMarketConditions(state);

  state.lastReviewTime = Date.now();
  state.reviewCount++;
  state.marketCondition = marketCondition;

  return allocations;
}

/**
 * Format Oracle report
 */
export function formatOracleReport(
  performances: StrategyPerformance[],
  marketCondition: MarketCondition,
): string {
  const rankEmoji = {
    [OracleRank.CHAMPION]: "🏆",
    [OracleRank.PERFORMING]: "✅",
    [OracleRank.TESTING]: "🧪",
    [OracleRank.STRUGGLING]: "⚠️",
    [OracleRank.DISABLED]: "❌",
  };

  const conditionEmoji = {
    [MarketCondition.BULL]: "🐂",
    [MarketCondition.NEUTRAL]: "⚖️",
    [MarketCondition.BEAR]: "🐻",
    [MarketCondition.VOLATILE]: "🌪️",
  };

  // Sort by score descending
  const sorted = [...performances].sort((a, b) => b.score - a.score);

  const lines = [
    "═══════════════════════════════════════",
    "⚡ APEX ORACLE - DAILY PERFORMANCE REVIEW",
    "═══════════════════════════════════════",
    "",
    `📊 Market Condition: ${conditionEmoji[marketCondition]} ${marketCondition}`,
    "",
    "🎯 STRATEGY RANKINGS:",
    "",
  ];

  for (const perf of sorted) {
    const emoji = rankEmoji[perf.rank];
    lines.push(
      `${emoji} ${perf.strategy} - ${perf.rank}`,
      `   Score: ${perf.score.toFixed(1)} | Win Rate: ${perf.winRate.toFixed(1)}%`,
      `   Trades: ${perf.wins}W / ${perf.losses}L | P&L: $${perf.totalPnL.toFixed(2)}`,
      `   Allocation: ${perf.allocation.toFixed(1)}%`,
      "",
    );
  }

  lines.push("═══════════════════════════════════════");

  return lines.join("\n");
}

/**
 * Check if Oracle review is due
 */
export function isReviewDue(state: OracleState): boolean {
  const msSinceReview = Date.now() - state.lastReviewTime;
  return msSinceReview >= ORACLE_REVIEW_INTERVAL_MS;
}
