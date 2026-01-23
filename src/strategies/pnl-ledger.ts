/**
 * PnL Ledger - Deterministic PnL Accounting
 *
 * Tracks all PnL with:
 * - Realized vs unrealized separation
 * - Per-strategy attribution
 * - Fee tracking
 * - Audit trail
 */

import type { ConsoleLogger } from "../utils/logger.util";
import type { StrategyId, OrderSide } from "./risk-types";

export interface Trade {
  timestamp: number;
  strategyId: StrategyId;
  marketId: string;
  tokenId: string;
  side: OrderSide;
  size: number;
  price: number;
  fees: number;
  pnlRealized?: number; // Set on closing trades
}

export interface PositionPnL {
  marketId: string;
  tokenId: string;
  strategyId: StrategyId;
  size: number;
  costBasis: number;
  currentValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
  totalFees: number;
  trades: number;
}

export interface LedgerSummary {
  totalRealizedPnl: number;
  totalUnrealizedPnl: number;
  totalFees: number;
  netPnl: number;
  byStrategy: Map<
    StrategyId,
    { realized: number; unrealized: number; fees: number }
  >;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
}

export class PnLLedger {
  private logger: ConsoleLogger;

  // Trade history
  private trades: Trade[] = [];
  private maxTradeHistory: number = 5000;

  // Position tracking: tokenId -> PositionPnL
  private positions: Map<string, PositionPnL> = new Map();

  // Aggregated stats
  private totalRealizedPnl: number = 0;
  private totalFees: number = 0;
  private realizedByStrategy: Map<StrategyId, number> = new Map();
  private feesByStrategy: Map<StrategyId, number> = new Map();

  // Win/loss tracking
  private wins: number[] = [];
  private losses: number[] = [];

  constructor(logger: ConsoleLogger) {
    this.logger = logger;
  }

  /**
   * Record a trade (buy or sell)
   */
  recordTrade(trade: Trade): void {
    this.trades.push(trade);

    // Trim history if needed
    if (this.trades.length > this.maxTradeHistory) {
      this.trades = this.trades.slice(-this.maxTradeHistory / 2);
    }

    // Track fees
    this.totalFees += trade.fees;
    this.feesByStrategy.set(
      trade.strategyId,
      (this.feesByStrategy.get(trade.strategyId) ?? 0) + trade.fees,
    );

    // Update position
    const position = this.positions.get(trade.tokenId);

    if (trade.side === "BUY") {
      this.recordBuy(trade, position);
    } else {
      this.recordSell(trade, position);
    }
  }

  /**
   * Record a buy trade
   */
  private recordBuy(trade: Trade, existing?: PositionPnL): void {
    const tradeValue = trade.size * trade.price;

    if (existing) {
      // Add to existing position (average cost basis)
      const newSize = existing.size + trade.size;
      const newCostBasis = existing.costBasis + tradeValue + trade.fees;

      existing.size = newSize;
      existing.costBasis = newCostBasis;
      existing.totalFees += trade.fees;
      existing.trades++;
    } else {
      // New position
      this.positions.set(trade.tokenId, {
        marketId: trade.marketId,
        tokenId: trade.tokenId,
        strategyId: trade.strategyId,
        size: trade.size,
        costBasis: tradeValue + trade.fees,
        currentValue: tradeValue,
        unrealizedPnl: -trade.fees, // Start negative due to fees
        realizedPnl: 0,
        totalFees: trade.fees,
        trades: 1,
      });
    }
  }

  /**
   * Record a sell trade
   */
  private recordSell(trade: Trade, existing?: PositionPnL): void {
    if (!existing || existing.size <= 0) {
      // Selling without position - could be a short or data issue
      this.logger.warn(
        `[PnLLedger] Sell without position for ${trade.tokenId}, treating as new short`,
      );
      return;
    }

    const tradeValue = trade.size * trade.price;
    const avgCost = existing.costBasis / existing.size;
    const costOfSold = trade.size * avgCost;
    const realizedPnl = tradeValue - costOfSold - trade.fees;

    // Update position
    existing.size -= trade.size;
    existing.costBasis -= costOfSold;
    existing.realizedPnl += realizedPnl;
    existing.totalFees += trade.fees;
    existing.trades++;

    // Track overall realized PnL
    this.totalRealizedPnl += realizedPnl;
    this.realizedByStrategy.set(
      trade.strategyId,
      (this.realizedByStrategy.get(trade.strategyId) ?? 0) + realizedPnl,
    );

    // Track win/loss
    if (realizedPnl > 0) {
      this.wins.push(realizedPnl);
    } else if (realizedPnl < 0) {
      this.losses.push(realizedPnl);
    }

    // Remove position if fully closed
    if (existing.size <= 0.001) {
      this.positions.delete(trade.tokenId);
    }

    this.logger.debug(
      `[PnLLedger] ${trade.strategyId} SELL realized: $${realizedPnl.toFixed(2)} ` +
        `(${realizedPnl >= 0 ? "WIN" : "LOSS"})`,
    );
  }

  /**
   * Update unrealized PnL based on current prices
   */
  updateUnrealizedPnl(currentPrices: Map<string, number>): void {
    for (const [tokenId, position] of this.positions) {
      const currentPrice = currentPrices.get(tokenId);
      if (currentPrice === undefined) continue;

      position.currentValue = position.size * currentPrice;
      position.unrealizedPnl = position.currentValue - position.costBasis;
    }
  }

  /**
   * Get summary of all PnL.
   *
   * Optionally accepts a map of current prices to refresh unrealized PnL
   * before computing the summary. If no prices are provided, the existing
   * unrealized PnL values are used as-is.
   */
  getSummary(currentPrices?: Map<string, number>): LedgerSummary {
    // Refresh unrealized PnL if current prices are provided
    if (currentPrices !== undefined) {
      this.updateUnrealizedPnl(currentPrices);
    }

    // Calculate totals
    let totalUnrealizedPnl = 0;
    const byStrategy = new Map<
      StrategyId,
      { realized: number; unrealized: number; fees: number }
    >();

    for (const position of this.positions.values()) {
      totalUnrealizedPnl += position.unrealizedPnl;

      const existing = byStrategy.get(position.strategyId) ?? {
        realized: 0,
        unrealized: 0,
        fees: 0,
      };
      existing.unrealized += position.unrealizedPnl;
      byStrategy.set(position.strategyId, existing);
    }

    // Add realized PnL to strategy breakdown
    for (const [strategyId, realized] of this.realizedByStrategy) {
      const existing = byStrategy.get(strategyId) ?? {
        realized: 0,
        unrealized: 0,
        fees: 0,
      };
      existing.realized = realized;
      existing.fees = this.feesByStrategy.get(strategyId) ?? 0;
      byStrategy.set(strategyId, existing);
    }

    // Win/loss stats
    const totalTrades = this.wins.length + this.losses.length;
    const avgWin =
      this.wins.length > 0
        ? this.wins.reduce((a, b) => a + b, 0) / this.wins.length
        : 0;
    const avgLoss =
      this.losses.length > 0
        ? this.losses.reduce((a, b) => a + b, 0) / this.losses.length
        : 0;

    return {
      totalRealizedPnl: this.totalRealizedPnl,
      totalUnrealizedPnl,
      totalFees: this.totalFees,
      netPnl: this.totalRealizedPnl + totalUnrealizedPnl,
      byStrategy,
      winningTrades: this.wins.length,
      losingTrades: this.losses.length,
      winRate: totalTrades > 0 ? this.wins.length / totalTrades : 0,
      avgWin,
      avgLoss,
      largestWin: this.wins.length > 0 ? Math.max(...this.wins) : 0,
      largestLoss: this.losses.length > 0 ? Math.min(...this.losses) : 0,
    };
  }

  /**
   * Get position PnL for a specific token
   */
  getPositionPnL(tokenId: string): PositionPnL | undefined {
    return this.positions.get(tokenId);
  }

  /**
   * Get all open positions
   */
  getOpenPositions(): PositionPnL[] {
    return Array.from(this.positions.values()).filter((p) => p.size > 0.001);
  }

  /**
   * Get recent trades
   */
  getRecentTrades(limit: number = 100): Trade[] {
    return this.trades.slice(-limit);
  }

  /**
   * Format summary for logging
   */
  formatSummary(): string {
    const summary = this.getSummary();
    const lines = [
      `=== PnL Summary ===`,
      `Realized: $${summary.totalRealizedPnl.toFixed(2)}`,
      `Unrealized: $${summary.totalUnrealizedPnl.toFixed(2)}`,
      `Fees: $${summary.totalFees.toFixed(2)}`,
      `Net: $${summary.netPnl.toFixed(2)}`,
      `Win Rate: ${(summary.winRate * 100).toFixed(1)}% (${summary.winningTrades}W / ${summary.losingTrades}L)`,
      `Avg Win: $${summary.avgWin.toFixed(2)} | Avg Loss: $${summary.avgLoss.toFixed(2)}`,
    ];

    if (summary.byStrategy.size > 0) {
      lines.push(`--- By Strategy ---`);
      for (const [strategyId, stats] of summary.byStrategy) {
        lines.push(
          `  ${strategyId}: R=$${stats.realized.toFixed(2)} U=$${stats.unrealized.toFixed(2)}`,
        );
      }
    }

    return lines.join("\n");
  }

  /**
   * Reset ledger (for testing or new session)
   */
  reset(): void {
    this.trades = [];
    this.positions.clear();
    this.totalRealizedPnl = 0;
    this.totalFees = 0;
    this.realizedByStrategy.clear();
    this.feesByStrategy.clear();
    this.wins = [];
    this.losses = [];
  }
}
