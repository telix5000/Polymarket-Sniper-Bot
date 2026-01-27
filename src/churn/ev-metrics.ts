/**
 * Churn Engine - EV Metrics Module
 *
 * Track rolling metrics over ROLLING_WINDOW_TRADES:
 * - win_rate
 * - avg_win_cents
 * - avg_loss_cents
 * - EV_cents
 * - profit_factor = avg_win / avg_loss
 *
 * Trading is allowed ONLY when:
 * - EV_cents >= MIN_EV_CENTS
 * - profit_factor >= MIN_PROFIT_FACTOR
 */

import type { ChurnConfig } from "./config";

/**
 * Trade result for EV calculation
 */
export interface TradeResult {
  tokenId: string;
  side: "LONG" | "SHORT";
  entryPriceCents: number;
  exitPriceCents: number;
  sizeUsd: number;
  timestamp: number;
  pnlCents: number; // Per share
  pnlUsd: number;
  isWin: boolean;
}

/**
 * Rolling EV Metrics
 */
export interface EvMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinCents: number;
  avgLossCents: number;
  evCents: number;
  profitFactor: number;
  totalPnlUsd: number;
  lastUpdated: number;
}

/**
 * EV Metrics Tracker
 * Maintains a rolling window of trades for EV calculation
 */
export class EvTracker {
  private trades: TradeResult[] = [];
  private readonly config: ChurnConfig;
  private pausedUntil = 0;

  constructor(config: ChurnConfig) {
    this.config = config;
  }

  /**
   * Record a completed trade
   */
  recordTrade(trade: TradeResult): void {
    this.trades.push(trade);

    // Trim to rolling window
    while (this.trades.length > this.config.rollingWindowTrades) {
      this.trades.shift();
    }

    // Check if we should pause
    const metrics = this.getMetrics();
    if (
      metrics.totalTrades >= 10 &&
      (metrics.evCents < this.config.minEvCents ||
        metrics.profitFactor < this.config.minProfitFactor)
    ) {
      this.pausedUntil = Date.now() + this.config.pauseSeconds * 1000;
    }
  }

  /**
   * Get current EV metrics
   */
  getMetrics(): EvMetrics {
    if (this.trades.length === 0) {
      return {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        avgWinCents: 0,
        avgLossCents: 0,
        evCents: 0,
        profitFactor: 0,
        totalPnlUsd: 0,
        lastUpdated: Date.now(),
      };
    }

    const wins = this.trades.filter((t) => t.isWin);
    const losses = this.trades.filter((t) => !t.isWin);

    const totalTrades = this.trades.length;
    const winCount = wins.length;
    const lossCount = losses.length;
    const winRate = winCount / totalTrades;

    // Average win/loss in cents per share
    const avgWinCents =
      winCount > 0
        ? wins.reduce((sum, t) => sum + t.pnlCents, 0) / winCount
        : 0;
    const avgLossCents =
      lossCount > 0
        ? Math.abs(losses.reduce((sum, t) => sum + t.pnlCents, 0) / lossCount)
        : 0;

    // EV = p(win) * avg_win - p(loss) * avg_loss - churn_cost
    const pWin = winRate;
    const pLoss = 1 - winRate;
    const evCents =
      pWin * avgWinCents -
      pLoss * avgLossCents -
      this.config.churnCostCentsEstimate;

    // Profit factor = avg_win / avg_loss
    const profitFactor = avgLossCents > 0 ? avgWinCents / avgLossCents : 0;

    // Total P&L
    const totalPnlUsd = this.trades.reduce((sum, t) => sum + t.pnlUsd, 0);

    return {
      totalTrades,
      wins: winCount,
      losses: lossCount,
      winRate,
      avgWinCents,
      avgLossCents,
      evCents,
      profitFactor,
      totalPnlUsd,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Check if trading is allowed based on EV metrics
   */
  isTradingAllowed(): { allowed: boolean; reason?: string } {
    // Check pause
    if (this.pausedUntil > Date.now()) {
      const remainingMs = this.pausedUntil - Date.now();
      return {
        allowed: false,
        reason: `PAUSED (${Math.ceil(remainingMs / 1000)}s remaining)`,
      };
    }

    const metrics = this.getMetrics();

    // Need minimum trades for meaningful metrics
    if (metrics.totalTrades < 10) {
      return { allowed: true }; // Allow during warmup
    }

    // Check EV threshold
    if (metrics.evCents < this.config.minEvCents) {
      return {
        allowed: false,
        reason: `EV too low (${metrics.evCents.toFixed(2)}¢ < ${this.config.minEvCents}¢)`,
      };
    }

    // Check profit factor
    if (metrics.profitFactor < this.config.minProfitFactor) {
      return {
        allowed: false,
        reason: `Profit factor too low (${metrics.profitFactor.toFixed(2)} < ${this.config.minProfitFactor})`,
      };
    }

    return { allowed: true };
  }

  /**
   * Force unpause (for testing or manual override)
   */
  unpause(): void {
    this.pausedUntil = 0;
  }

  /**
   * Get pause status
   */
  isPaused(): boolean {
    return this.pausedUntil > Date.now();
  }

  /**
   * Get remaining pause time in seconds
   */
  getPauseRemainingSeconds(): number {
    if (!this.isPaused()) return 0;
    return Math.ceil((this.pausedUntil - Date.now()) / 1000);
  }

  /**
   * Clear all trades (for testing)
   */
  clear(): void {
    this.trades = [];
    this.pausedUntil = 0;
  }

  /**
   * Get recent trades (for debugging)
   */
  getRecentTrades(count = 10): TradeResult[] {
    return this.trades.slice(-count);
  }

  /**
   * Convert to JSON log entry
   */
  toLogEntry(): object {
    const metrics = this.getMetrics();
    const tradingStatus = this.isTradingAllowed();
    return {
      type: "ev_metrics",
      timestamp: new Date().toISOString(),
      metrics: {
        totalTrades: metrics.totalTrades,
        wins: metrics.wins,
        losses: metrics.losses,
        winRate: parseFloat(metrics.winRate.toFixed(4)),
        avgWinCents: parseFloat(metrics.avgWinCents.toFixed(2)),
        avgLossCents: parseFloat(metrics.avgLossCents.toFixed(2)),
        evCents: parseFloat(metrics.evCents.toFixed(2)),
        profitFactor: parseFloat(metrics.profitFactor.toFixed(2)),
        totalPnlUsd: parseFloat(metrics.totalPnlUsd.toFixed(2)),
      },
      tradingAllowed: tradingStatus.allowed,
      tradingBlockedReason: tradingStatus.reason || null,
      paused: this.isPaused(),
      pauseRemainingSeconds: this.getPauseRemainingSeconds(),
    };
  }
}

/**
 * Calculate P&L in cents for a trade
 */
export function calculatePnlCents(
  side: "LONG" | "SHORT",
  entryPriceCents: number,
  exitPriceCents: number,
): number {
  if (side === "LONG") {
    return exitPriceCents - entryPriceCents;
  } else {
    return entryPriceCents - exitPriceCents;
  }
}

/**
 * Calculate P&L in USD for a trade
 */
export function calculatePnlUsd(
  pnlCents: number,
  sizeUsd: number,
  entryPriceCents: number,
): number {
  if (entryPriceCents === 0) return 0;
  const shares = sizeUsd / (entryPriceCents / 100);
  return (pnlCents / 100) * shares;
}

/**
 * Create a trade result from raw data
 */
export function createTradeResult(
  tokenId: string,
  side: "LONG" | "SHORT",
  entryPriceCents: number,
  exitPriceCents: number,
  sizeUsd: number,
): TradeResult {
  const pnlCents = calculatePnlCents(side, entryPriceCents, exitPriceCents);
  const pnlUsd = calculatePnlUsd(pnlCents, sizeUsd, entryPriceCents);
  return {
    tokenId,
    side,
    entryPriceCents,
    exitPriceCents,
    sizeUsd,
    timestamp: Date.now(),
    pnlCents,
    pnlUsd,
    isWin: pnlCents > 0,
  };
}
