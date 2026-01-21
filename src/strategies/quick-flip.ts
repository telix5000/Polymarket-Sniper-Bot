import type { ClobClient } from "@polymarket/clob-client";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker } from "./position-tracker";

export interface QuickFlipConfig {
  enabled: boolean;
  targetPct: number;        // Sell at this gain percentage (e.g., 5 = 5%)
  stopLossPct: number;      // Sell at this loss percentage (e.g., 3 = -3%)
  minHoldSeconds: number;   // Minimum time to hold position before selling
}

export interface QuickFlipStrategyConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  positionTracker: PositionTracker;
  config: QuickFlipConfig;
}

/**
 * Quick Flip Strategy
 * Monitors owned positions for price gains and sells when target is reached
 * Also implements stop-loss to limit downside
 * Recycles capital faster than waiting for resolution
 */
export class QuickFlipStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private config: QuickFlipConfig;
  private positionEntryTimes: Map<string, number> = new Map();

  constructor(strategyConfig: QuickFlipStrategyConfig) {
    this.client = strategyConfig.client;
    this.logger = strategyConfig.logger;
    this.positionTracker = strategyConfig.positionTracker;
    this.config = strategyConfig.config;
  }

  /**
   * Execute the quick flip strategy
   * Returns number of positions sold
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // Clean up entry times for positions that no longer exist
    this.cleanupStaleEntries();

    let soldCount = 0;

    // Check for positions that hit target gain
    const targetPositions = this.positionTracker.getPositionsAboveTarget(
      this.config.targetPct
    );
    
    for (const position of targetPositions) {
      if (this.shouldSell(position.marketId, position.tokenId)) {
        this.logger.info(
          `[QuickFlip] Selling position at +${position.pnlPct.toFixed(2)}% gain: ${position.marketId}`
        );
        
        try {
          await this.sellPosition(position.marketId, position.tokenId, position.size);
          soldCount++;
        } catch (err) {
          this.logger.error(
            `[QuickFlip] Failed to sell position ${position.marketId}`,
            err as Error
          );
        }
      }
    }

    // Check for positions that hit stop loss
    const stopLossPositions = this.positionTracker.getPositionsBelowStopLoss(
      this.config.stopLossPct
    );
    
    for (const position of stopLossPositions) {
      if (this.shouldSell(position.marketId, position.tokenId)) {
        this.logger.warn(
          `[QuickFlip] Stop-loss triggered at ${position.pnlPct.toFixed(2)}%: ${position.marketId}`
        );
        
        try {
          await this.sellPosition(position.marketId, position.tokenId, position.size);
          soldCount++;
        } catch (err) {
          this.logger.error(
            `[QuickFlip] Failed to execute stop-loss for ${position.marketId}`,
            err as Error
          );
        }
      }
    }

    if (soldCount > 0) {
      this.logger.info(`[QuickFlip] Sold ${soldCount} positions`);
    }

    return soldCount;
  }

  /**
   * Check if position should be sold based on hold time
   * Gets entry time from position tracker (not on first call)
   */
  private shouldSell(marketId: string, tokenId: string): boolean {
    const key = `${marketId}-${tokenId}`;
    
    // Check if we already have an entry time tracked
    let entryTime = this.positionEntryTimes.get(key);
    
    if (!entryTime) {
      // Record current time as entry time (first time seeing this position)
      entryTime = Date.now();
      this.positionEntryTimes.set(key, entryTime);
      return false; // Don't sell on first detection
    }

    const holdTimeSeconds = (Date.now() - entryTime) / 1000;
    return holdTimeSeconds >= this.config.minHoldSeconds;
  }

  /**
   * Sell a position
   * This is a placeholder for actual selling logic
   */
  private async sellPosition(
    marketId: string,
    tokenId: string,
    size: number
  ): Promise<void> {
    this.logger.debug(
      `[QuickFlip] Would sell ${size} of ${tokenId} in market ${marketId}`
    );
    
    // TODO: Implement actual CLOB sell order creation
    // This is a placeholder that needs to be replaced with real order submission
    
    // In production, this would:
    // 1. Get current best bid price from orderbook
    //    const orderbook = await this.client.getOrderbook(marketId);
    //    const bestBid = orderbook.bids[0];
    // 
    // 2. Create a sell order slightly below best bid for quick fill
    //    const sellPrice = bestBid.price * 0.999; // Slight discount for immediate fill
    //    const order = {
    //      tokenId: tokenId,
    //      side: 'SELL',
    //      type: 'LIMIT',
    //      price: sellPrice,
    //      size: size,
    //      feeRateBps: 0,
    //    };
    // 
    // 3. Sign the sell order
    //    const signedOrder = await this.client.createOrder(order);
    // 
    // 4. Submit order to CLOB
    //    const result = await this.client.postOrder(signedOrder);
    // 
    // 5. Wait for fill confirmation (with timeout)
    //    const filled = await this.client.waitForOrderFill(result.orderId, 30000);
    // 
    // 6. Log the sale result
    //    if (filled) {
    //      this.logger.info(
    //        `[QuickFlip] ✓ Sold ${size.toFixed(2)} shares at ${(sellPrice * 100).toFixed(1)}¢`
    //      );
    //    }
    
    // Remove from entry times after selling
    const key = `${marketId}-${tokenId}`;
    this.positionEntryTimes.delete(key);
  }

  /**
   * Clean up entry times for positions that no longer exist
   * Prevents memory leak from tracking sold/closed positions
   */
  private cleanupStaleEntries(): void {
    const currentPositions = this.positionTracker.getPositions();
    const currentKeys = new Set(
      currentPositions.map(pos => `${pos.marketId}-${pos.tokenId}`)
    );
    
    let cleanedCount = 0;
    const keysToDelete: string[] = [];
    for (const key of this.positionEntryTimes.keys()) {
      if (!currentKeys.has(key)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.positionEntryTimes.delete(key);
      cleanedCount++;
    }
    
    if (cleanedCount > 0) {
      this.logger.debug(
        `[QuickFlip] Cleaned up ${cleanedCount} stale position entries`
      );
    }
  }

  /**
   * Get strategy statistics
   */
  getStats(): {
    trackedPositions: number;
    enabled: boolean;
    targetPct: number;
    stopLossPct: number;
  } {
    return {
      trackedPositions: this.positionEntryTimes.size,
      enabled: this.config.enabled,
      targetPct: this.config.targetPct,
      stopLossPct: this.config.stopLossPct,
    };
  }
}
