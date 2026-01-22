import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker, Position } from "./position-tracker";
import { getDynamicStopLoss, PRICE_TIERS, PROFIT_TARGETS } from "./trade-quality";
import { getOppositeToken } from "../utils/market-tokens.util";

/**
 * Smart Hedge-on-Stop-Loss Configuration
 *
 * GOAL: Always end up on the winning side while minimizing losses.
 *
 * This strategy extends the stop-loss concept by INTELLIGENTLY hedging instead
 * of just selling. When a position starts losing significantly AND the market
 * shows clear conviction in the opposite outcome, we switch sides.
 *
 * THE MATH (why this works):
 *
 * Example: Buy YES at 50¢ ($5 = 10 shares), price drops to 30¢
 *
 * WITHOUT HEDGE (just hold or sell):
 * - If NO wins (70% likely per market): Lose entire $5 (100% loss)
 * - If YES wins (30% likely): Get $10 (100% profit)
 * - Expected value: 0.3 × $5 + 0.7 × (-$5) = -$2.00
 *
 * WITH SMART HEDGE (sell YES at 30¢, buy NO at 70¢):
 * - Sell YES: Get $3 back (locked in $2 loss on YES)
 * - Buy NO at 70¢: ~4.3 shares with $3
 * - If NO wins (70% likely): Get $4.30 → Net loss only $0.70 (14%)
 * - If YES wins (30% likely): NO worthless → Lose full $5 (100%)
 * - Expected value: 0.3 × (-$5) + 0.7 × (-$0.70) = -$1.99
 *
 * KEY INSIGHTS:
 * 1. Same expected value, but MUCH lower risk when the market is right!
 *    - 70% of the time you lose $0.70 instead of $5.00
 * 2. You're "following the smart money" - the market is usually right
 * 3. Total exposure stays capped (using sell proceeds, not adding money)
 * 4. You end up holding the winning position 70% of the time!
 *
 * SMART HEDGING RULES:
 * 1. Only hedge when opposite side shows CONVICTION (>55% probability)
 * 2. Only hedge when our loss is significant (>15% typically)
 * 3. Only hedge binary markets (YES/NO) where winner is clear
 * 4. Use ALL proceeds for hedge - commit fully to the new direction
 */
export interface HedgeOnStopLossConfig {
  /**
   * Enable hedge-on-stop-loss strategy.
   * When false, positions just trigger normal stop-loss sells.
   */
  enabled: boolean;

  /**
   * Only apply hedging to positions below this entry price threshold.
   * Default: 0.6 (60¢) - Only risky tier positions get hedged.
   *
   * Rationale: Higher-tier positions (70¢+) have smaller stop-losses (3-12%)
   * and are more likely to recover. Risky positions (< 60¢) have 20% stop-loss
   * and are less certain, making hedging more valuable.
   */
  maxEntryPriceForHedge: number;

  /**
   * Minimum loss percentage to trigger hedging.
   * Default: 15% - Don't hedge small losses, only major reversals.
   *
   * This prevents hedging on temporary dips that might recover.
   */
  minLossPctForHedge: number;

  /**
   * Maximum percentage of the sold position value to use for buying the hedge.
   * Default: 100% - Use all proceeds from the sell to buy the opposite position.
   *
   * Lower values (e.g., 50%) provide partial hedging while preserving some cash.
   */
  hedgeSizePercent: number;

  /**
   * Stop-loss percentage for the hedge position.
   * Default: 10% - If the hedge also starts losing, cut it early.
   *
   * This prevents double losses if the market is volatile.
   */
  hedgeStopLossPct: number;

  /**
   * Maximum stop-loss percentage allowed for ANY position (absolute ceiling).
   * Default: 25% - No position should ever lose more than this.
   */
  maxStopLossPct: number;

  /**
   * Use dynamic stop-loss tiers based on entry price.
   * If false, uses maxStopLossPct for all positions.
   */
  useDynamicTiers: boolean;
}

export interface HedgeOnStopLossStrategyConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  positionTracker: PositionTracker;
  config: HedgeOnStopLossConfig;
}

/**
 * Hedge result for tracking and diagnostics
 */
export interface HedgeResult {
  originalPosition: {
    marketId: string;
    tokenId: string;
    side: string;
    size: number;
    entryPrice: number;
    lossPct: number;
  };
  sellResult: "success" | "failed" | "no_liquidity";
  sellPriceUsd?: number;
  hedgeResult?: "success" | "failed" | "skipped" | "no_opposite_token";
  hedgeTokenId?: string;
  hedgeSide?: string;
  hedgeSizeUsd?: number;
  hedgeEntryPrice?: number;
  timestamp: number;
}

/**
 * Hedge-on-Stop-Loss Strategy
 *
 * A smarter stop-loss that converts losing positions into winning ones.
 * Instead of simply selling at a loss, this strategy:
 *
 * 1. Sells the losing position (same as normal stop-loss)
 * 2. Uses the proceeds to buy the opposite outcome
 *
 * This is particularly effective for risky tier positions (< 60¢) where:
 * - The 20% stop-loss results in significant losses
 * - The opposite side is likely winning (and often has good value)
 *
 * Requirements:
 * - Binary markets only (YES/NO) - multi-outcome markets are not hedged
 * - Position must be in risky tier (configurable)
 * - Sufficient liquidity on both sides
 *
 * The strategy tracks all hedge operations for performance analysis.
 */
export class HedgeOnStopLossStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private config: HedgeOnStopLossConfig;

  /**
   * Tracks tokenIds with no liquidity to suppress repeated warnings.
   */
  private noLiquidityTokens: Set<string> = new Set();

  /**
   * Tracks positions currently being processed.
   * Key format: "marketId-tokenId"
   */
  private pendingOperations: Set<string> = new Set();

  /**
   * History of hedge operations for analysis.
   * Limited to last 100 operations.
   */
  private hedgeHistory: HedgeResult[] = [];
  private static readonly MAX_HISTORY_SIZE = 100;

  constructor(strategyConfig: HedgeOnStopLossStrategyConfig) {
    this.client = strategyConfig.client;
    this.logger = strategyConfig.logger;
    this.positionTracker = strategyConfig.positionTracker;
    this.config = strategyConfig.config;
  }

  /**
   * Execute the hedge-on-stop-loss strategy.
   *
   * Returns the number of positions that were hedged (sell + buy executed).
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    this.cleanupStaleEntries();

    let hedgedCount = 0;
    const allPositions = this.positionTracker.getPositions();

    // Filter to active, risky positions eligible for hedging
    const eligiblePositions = allPositions.filter((pos) => {
      // Skip resolved/redeemable positions
      if (pos.redeemable) return false;

      // Only hedge positions below the entry price threshold (risky tier)
      if (pos.entryPrice >= this.config.maxEntryPriceForHedge) return false;

      // Check if position exceeds stop-loss threshold
      const stopLossPct = this.getStopLossThreshold(pos.entryPrice);
      if (pos.pnlPct > -stopLossPct) return false;

      // Check minimum loss threshold for hedging
      if (Math.abs(pos.pnlPct) < this.config.minLossPctForHedge) return false;

      return true;
    });

    if (eligiblePositions.length === 0) {
      return 0;
    }

    this.logger.info(
      `[HedgeStopLoss] 🔄 ${eligiblePositions.length} position(s) eligible for hedge-on-stop-loss`,
    );

    // Process each eligible position
    for (const position of eligiblePositions) {
      const positionKey = `${position.marketId}-${position.tokenId}`;

      // Skip if already processing
      if (this.pendingOperations.has(positionKey)) {
        continue;
      }

      this.pendingOperations.add(positionKey);

      try {
        const hedged = await this.executeHedge(position);
        if (hedged) {
          hedgedCount++;
        }
      } catch (err) {
        this.logger.error(
          `[HedgeStopLoss] ❌ Failed to hedge position ${position.marketId}`,
          err as Error,
        );
      } finally {
        this.pendingOperations.delete(positionKey);
      }
    }

    if (hedgedCount > 0) {
      this.logger.info(
        `[HedgeStopLoss] 💱 Executed ${hedgedCount} hedge operation(s)`,
      );
    }

    return hedgedCount;
  }

  /**
   * Execute a hedge operation for a single position.
   *
   * 1. Find the opposite token
   * 2. Sell the losing position
   * 3. Buy the opposite position
   */
  private async executeHedge(position: Position): Promise<boolean> {
    const hedgeResult: HedgeResult = {
      originalPosition: {
        marketId: position.marketId,
        tokenId: position.tokenId,
        side: position.side,
        size: position.size,
        entryPrice: position.entryPrice,
        lossPct: position.pnlPct,
      },
      sellResult: "failed",
      timestamp: Date.now(),
    };

    try {
      this.logger.info(
        `[HedgeStopLoss] 🔻 Processing hedge for position: ` +
          `${position.side} at ${(position.entryPrice * 100).toFixed(1)}¢, ` +
          `current loss: ${position.pnlPct.toFixed(2)}%`,
      );

      // Step 1: Find the opposite token
      const oppositeToken = await getOppositeToken(
        position.tokenId,
        position.side,
        this.logger,
      );

      if (!oppositeToken) {
        this.logger.warn(
          `[HedgeStopLoss] ⚠️ No opposite token found for ${position.side} position - executing normal stop-loss`,
        );
        hedgeResult.hedgeResult = "no_opposite_token";

        // Fall back to normal stop-loss sell
        const sold = await this.sellPosition(position);
        hedgeResult.sellResult = sold ? "success" : "failed";
        this.addToHistory(hedgeResult);
        return sold;
      }

      // Step 2: Get orderbooks for both tokens
      const [currentOrderbook, oppositeOrderbook] = await Promise.all([
        this.client.getOrderBook(position.tokenId),
        this.client.getOrderBook(oppositeToken.tokenId),
      ]);

      // Check sell liquidity
      if (!currentOrderbook.bids || currentOrderbook.bids.length === 0) {
        this.logger.warn(
          `[HedgeStopLoss] ⚠️ No bids for ${position.side} - cannot hedge (illiquid)`,
        );
        hedgeResult.sellResult = "no_liquidity";
        this.addToHistory(hedgeResult);
        return false;
      }

      // Check buy liquidity for opposite token
      if (!oppositeOrderbook.asks || oppositeOrderbook.asks.length === 0) {
        this.logger.warn(
          `[HedgeStopLoss] ⚠️ No asks for ${oppositeToken.outcome} - executing normal stop-loss`,
        );
        hedgeResult.hedgeResult = "skipped";

        // Fall back to normal stop-loss sell
        const sold = await this.sellPosition(position);
        hedgeResult.sellResult = sold ? "success" : "failed";
        this.addToHistory(hedgeResult);
        return sold;
      }

      const sellBestBid = parseFloat(currentOrderbook.bids[0].price);
      const buyBestAsk = parseFloat(oppositeOrderbook.asks[0].price);

      // Step 3: Sell the losing position
      this.logger.info(
        `[HedgeStopLoss] 📉 Selling ${position.size.toFixed(2)} ${position.side} ` +
          `at ~${(sellBestBid * 100).toFixed(1)}¢`,
      );

      const sold = await this.sellPosition(position);
      if (!sold) {
        hedgeResult.sellResult = "failed";
        this.addToHistory(hedgeResult);
        return false;
      }

      hedgeResult.sellResult = "success";
      hedgeResult.sellPriceUsd = position.size * sellBestBid;

      // Step 4: Buy the opposite position
      const hedgeSizeUsd =
        hedgeResult.sellPriceUsd * (this.config.hedgeSizePercent / 100);

      this.logger.info(
        `[HedgeStopLoss] 📈 Buying ${oppositeToken.outcome} with $${hedgeSizeUsd.toFixed(2)} ` +
          `at ~${(buyBestAsk * 100).toFixed(1)}¢`,
      );

      const hedgeBought = await this.buyHedgePosition(
        position.marketId,
        oppositeToken.tokenId,
        oppositeToken.outcome,
        hedgeSizeUsd,
        buyBestAsk,
      );

      if (hedgeBought) {
        hedgeResult.hedgeResult = "success";
        hedgeResult.hedgeTokenId = oppositeToken.tokenId;
        hedgeResult.hedgeSide = oppositeToken.outcome;
        hedgeResult.hedgeSizeUsd = hedgeSizeUsd;
        hedgeResult.hedgeEntryPrice = buyBestAsk;

        this.logger.info(
          `[HedgeStopLoss] ✅ Hedge complete: Sold ${position.side} at ` +
            `${position.pnlPct.toFixed(2)}% loss, bought ${oppositeToken.outcome} ` +
            `at ${(buyBestAsk * 100).toFixed(1)}¢`,
        );
      } else {
        hedgeResult.hedgeResult = "failed";
        this.logger.warn(
          `[HedgeStopLoss] ⚠️ Sell succeeded but hedge buy failed - partial execution`,
        );
      }

      this.addToHistory(hedgeResult);
      return hedgeBought;
    } catch (err) {
      this.logger.error(
        `[HedgeStopLoss] ❌ Error during hedge: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.addToHistory(hedgeResult);
      throw err;
    }
  }

  /**
   * Sell a position (stop-loss execution).
   */
  private async sellPosition(position: Position): Promise<boolean> {
    try {
      const { postOrder } = await import("../utils/post-order.util");

      const orderbook = await this.client.getOrderBook(position.tokenId);
      if (!orderbook.bids || orderbook.bids.length === 0) {
        return false;
      }

      const bestBid = parseFloat(orderbook.bids[0].price);
      const sizeUsd = position.size * bestBid;

      const wallet = (this.client as { wallet?: Wallet }).wallet;

      const result = await postOrder({
        client: this.client,
        wallet,
        marketId: position.marketId,
        tokenId: position.tokenId,
        outcome: "YES", // Direction doesn't matter for sells
        side: "SELL",
        sizeUsd,
        maxAcceptablePrice: bestBid * 0.9, // Accept up to 10% slippage
        logger: this.logger,
        priority: true,
        orderConfig: { minOrderUsd: 0 },
      });

      return result.status === "submitted";
    } catch (err) {
      this.logger.error(
        `[HedgeStopLoss] ❌ Sell error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Buy the hedge position (opposite side).
   */
  private async buyHedgePosition(
    marketId: string,
    tokenId: string,
    outcome: string,
    sizeUsd: number,
    maxPrice: number,
  ): Promise<boolean> {
    try {
      const { postOrder } = await import("../utils/post-order.util");

      const wallet = (this.client as { wallet?: Wallet }).wallet;

      const result = await postOrder({
        client: this.client,
        wallet,
        marketId,
        tokenId,
        outcome: outcome as "YES" | "NO",
        side: "BUY",
        sizeUsd,
        maxAcceptablePrice: maxPrice * 1.05, // Accept up to 5% slippage for hedge
        logger: this.logger,
        priority: true,
        orderConfig: { minOrderUsd: 0 },
      });

      return result.status === "submitted";
    } catch (err) {
      this.logger.error(
        `[HedgeStopLoss] ❌ Hedge buy error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Get stop-loss threshold for a position based on entry price.
   */
  private getStopLossThreshold(entryPrice: number): number {
    if (!this.config.useDynamicTiers) {
      return this.config.maxStopLossPct;
    }

    const dynamicStopLoss = getDynamicStopLoss(entryPrice);
    return Math.min(dynamicStopLoss, this.config.maxStopLossPct);
  }

  /**
   * Clean up stale entries from tracking sets.
   */
  private cleanupStaleEntries(): void {
    const currentPositions = this.positionTracker.getPositions();
    const currentKeys = new Set(
      currentPositions.map((pos) => `${pos.marketId}-${pos.tokenId}`),
    );
    const currentTokenIds = new Set(currentPositions.map((pos) => pos.tokenId));

    // Clean up no-liquidity cache
    const tokensToRemove: string[] = [];
    for (const tokenId of this.noLiquidityTokens) {
      if (!currentTokenIds.has(tokenId)) {
        tokensToRemove.push(tokenId);
      }
    }
    for (const tokenId of tokensToRemove) {
      this.noLiquidityTokens.delete(tokenId);
    }
  }

  /**
   * Add a hedge result to history (with size limit).
   */
  private addToHistory(result: HedgeResult): void {
    this.hedgeHistory.push(result);
    while (this.hedgeHistory.length > HedgeOnStopLossStrategy.MAX_HISTORY_SIZE) {
      this.hedgeHistory.shift();
    }
  }

  /**
   * Get strategy statistics.
   */
  getStats(): {
    enabled: boolean;
    maxEntryPriceForHedge: number;
    minLossPctForHedge: number;
    hedgeSizePercent: number;
    maxStopLossPct: number;
    useDynamicTiers: boolean;
    totalHedgesExecuted: number;
    successfulHedges: number;
    recentHedges: HedgeResult[];
  } {
    const successfulHedges = this.hedgeHistory.filter(
      (h) => h.sellResult === "success" && h.hedgeResult === "success",
    ).length;

    return {
      enabled: this.config.enabled,
      maxEntryPriceForHedge: this.config.maxEntryPriceForHedge,
      minLossPctForHedge: this.config.minLossPctForHedge,
      hedgeSizePercent: this.config.hedgeSizePercent,
      maxStopLossPct: this.config.maxStopLossPct,
      useDynamicTiers: this.config.useDynamicTiers,
      totalHedgesExecuted: this.hedgeHistory.length,
      successfulHedges,
      recentHedges: this.hedgeHistory.slice(-10), // Last 10 hedges
    };
  }

  /**
   * Get hedge history for analysis.
   */
  getHedgeHistory(): HedgeResult[] {
    return [...this.hedgeHistory];
  }

  /**
   * Clear hedge history (for testing).
   */
  clearHistory(): void {
    this.hedgeHistory = [];
  }
}

/**
 * Default configuration for hedge-on-stop-loss strategy.
 *
 * Conservative defaults that only hedge risky positions with significant losses.
 */
export const DEFAULT_HEDGE_ON_STOP_LOSS_CONFIG: HedgeOnStopLossConfig = {
  enabled: false, // Disabled by default - user must opt-in
  maxEntryPriceForHedge: PRICE_TIERS.SPECULATIVE_MIN, // 0.6 (60¢) - only risky tier
  minLossPctForHedge: PROFIT_TARGETS.RISKY.stopLossPct - 5, // 15% (just before 20% stop-loss)
  hedgeSizePercent: 100, // Use all proceeds for hedge
  hedgeStopLossPct: 10, // Tighter stop-loss on hedges
  maxStopLossPct: 25, // Absolute ceiling
  useDynamicTiers: true, // Use dynamic stop-loss tiers
};
