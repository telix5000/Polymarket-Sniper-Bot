import type { ClobClient } from "@polymarket/clob-client";
import type { ConsoleLogger } from "../utils/logger.util";

export interface Position {
  marketId: string;
  tokenId: string;
  side: "YES" | "NO";
  size: number;
  entryPrice: number;
  currentPrice: number;
  pnlPct: number;
  pnlUsd: number;
}

export interface PositionTrackerConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  refreshIntervalMs?: number;
}

/**
 * Tracks current positions and their P&L
 * Provides data to Quick Flip and Auto-Sell strategies
 */
export class PositionTracker {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positions: Map<string, Position> = new Map();
  private positionEntryTimes: Map<string, number> = new Map(); // Track when positions first appeared
  private refreshIntervalMs: number;
  private refreshTimer?: NodeJS.Timeout;
  private isRefreshing: boolean = false; // Prevent concurrent refreshes

  constructor(config: PositionTrackerConfig) {
    this.client = config.client;
    this.logger = config.logger;
    this.refreshIntervalMs = config.refreshIntervalMs ?? 30000; // 30 seconds default
  }

  /**
   * Start tracking positions
   */
  async start(): Promise<void> {
    this.logger.info("[PositionTracker] Starting position tracking");
    await this.refresh();
    
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) => {
        this.logger.error("[PositionTracker] Refresh failed", err as Error);
      });
    }, this.refreshIntervalMs);
  }

  /**
   * Stop tracking positions
   */
  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.logger.info("[PositionTracker] Stopped position tracking");
  }

  /**
   * Refresh positions from API
   */
  async refresh(): Promise<void> {
    // Prevent concurrent refreshes (race condition protection)
    if (this.isRefreshing) {
      this.logger.debug("[PositionTracker] Refresh already in progress, skipping");
      return;
    }

    this.isRefreshing = true;

    try {
      // Get current positions from CLOB API
      // Note: This is a placeholder - actual implementation would use
      // ClobClient methods to fetch positions
      this.logger.debug("[PositionTracker] Refreshing positions");
      
      // For now, we'll use a mock implementation
      // In production, this would call actual Polymarket API endpoints
      const positions = await this.fetchPositionsFromAPI();
      
      // Track which positions existed before this refresh
      const previousKeys = new Set(this.positions.keys());
      
      // Update positions map atomically
      const newPositions = new Map<string, Position>();
      const now = Date.now();
      
      for (const position of positions) {
        const key = `${position.marketId}-${position.tokenId}`;
        newPositions.set(key, position);
        
        // Preserve entry time if position already existed
        if (!this.positionEntryTimes.has(key)) {
          this.positionEntryTimes.set(key, now);
        }
      }
      
      // Replace positions map atomically to avoid race conditions
      this.positions = newPositions;
      
      // Note: Positions that temporarily disappear are handled by keeping their 
      // entry times in positionEntryTimes Map. This provides resilience against
      // temporary API glitches. Cleanup happens in strategies that use this tracker.
      
      this.logger.debug(
        `[PositionTracker] Refreshed ${positions.length} positions`
      );
    } catch (err) {
      this.logger.error(
        "[PositionTracker] Failed to refresh positions",
        err as Error
      );
      // Don't throw - let the caller decide whether to retry
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Get all current positions
   */
  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get position by market and token ID
   */
  getPosition(marketId: string, tokenId: string): Position | undefined {
    const key = `${marketId}-${tokenId}`;
    return this.positions.get(key);
  }

  /**
   * Get positions with P&L above threshold
   */
  getPositionsAboveTarget(targetPct: number): Position[] {
    return this.getPositions().filter((pos) => pos.pnlPct >= targetPct);
  }

  /**
   * Get positions below stop loss threshold
   */
  getPositionsBelowStopLoss(stopLossPct: number): Position[] {
    return this.getPositions().filter((pos) => pos.pnlPct <= -stopLossPct);
  }

  /**
   * Get positions near resolution (price > threshold)
   */
  getPositionsNearResolution(threshold: number): Position[] {
    return this.getPositions().filter((pos) => pos.currentPrice >= threshold);
  }

  /**
   * Fetch positions from Polymarket API
   * This is a placeholder for actual API integration
   */
  private async fetchPositionsFromAPI(): Promise<Position[]> {
    // TODO: Implement actual Polymarket API integration
    // This is a placeholder that needs to be replaced with real API calls
    
    // In production, this would:
    // 1. Call ClobClient method to get user's current positions
    //    const apiPositions = await this.client.getPositions();
    //    // Or alternative endpoint:
    //    // const apiPositions = await this.client.getBalances();
    // 
    // 2. For each position, fetch current market data to calculate P&L
    //    const positions: Position[] = [];
    //    for (const apiPosition of apiPositions) {
    //      // Get current market price
    //      const orderbook = await this.client.getOrderbook(apiPosition.marketId);
    //      const currentPrice = (orderbook.bids[0].price + orderbook.asks[0].price) / 2;
    //      
    //      // Calculate P&L
    //      const pnlUsd = (currentPrice - apiPosition.entryPrice) * apiPosition.size;
    //      const pnlPct = ((currentPrice - apiPosition.entryPrice) / apiPosition.entryPrice) * 100;
    //      
    //      positions.push({
    //        marketId: apiPosition.marketId,
    //        tokenId: apiPosition.tokenId,
    //        side: apiPosition.side,
    //        size: apiPosition.size,
    //        entryPrice: apiPosition.entryPrice,
    //        currentPrice: currentPrice,
    //        pnlPct: pnlPct,
    //        pnlUsd: pnlUsd,
    //      });
    //    }
    //    return positions;
    // 
    // 3. Handle API errors with exponential backoff retry
    // 4. Cache results briefly to avoid rate limiting
    
    return [];
  }

  /**
   * Get entry time for a position (when it was first seen)
   */
  getPositionEntryTime(marketId: string, tokenId: string): number | undefined {
    const key = `${marketId}-${tokenId}`;
    return this.positionEntryTimes.get(key);
  }
}
