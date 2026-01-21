import type { ClobClient } from "@polymarket/clob-client";
import type { ConsoleLogger } from "../utils/logger.util";
import { MAX_LIQUIDITY_USAGE_PCT } from "./constants";

export interface EndgameSweepConfig {
  enabled: boolean;
  minPrice: number;  // Minimum price to consider (e.g., 0.98 = 98¢)
  maxPrice: number;  // Maximum price to consider (e.g., 0.995 = 99.5¢)
  maxPositionUsd: number;  // Maximum USD to invest per position
}

export interface Market {
  id: string;
  tokenId: string;
  side: "YES" | "NO";
  price: number;
  liquidity: number;
}

export interface EndgameSweepStrategyConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  config: EndgameSweepConfig;
}

/**
 * Endgame Sweep Strategy
 * Scan markets for positions trading at 98-99¢ (near-certain outcomes)
 * Buy these positions for near-guaranteed 1-2% profit
 * Very low risk since outcome is almost certain
 */
export class EndgameSweepStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private config: EndgameSweepConfig;
  private purchasedMarkets: Set<string> = new Set();
  private purchaseTimestamps: Map<string, number> = new Map(); // Track when markets were purchased

  constructor(strategyConfig: EndgameSweepStrategyConfig) {
    this.client = strategyConfig.client;
    this.logger = strategyConfig.logger;
    this.config = strategyConfig.config;
  }

  /**
   * Execute the endgame sweep strategy
   * Returns number of positions purchased
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // Clean up stale entries (older than 24 hours)
    this.cleanupOldPurchases();

    let purchasedCount = 0;

    // Scan for markets with high-confidence outcomes
    const candidates = await this.scanForEndgameOpportunities();

    for (const market of candidates) {
      const marketKey = `${market.id}-${market.tokenId}`;
      
      // Skip if already purchased
      if (this.purchasedMarkets.has(marketKey)) {
        continue;
      }

      // Calculate expected profit
      const expectedProfit = (1.0 - market.price) / market.price;
      const expectedProfitPct = expectedProfit * 100;

      this.logger.info(
        `[EndgameSweep] Opportunity: ${market.id} at ${(market.price * 100).toFixed(1)}¢ (expected ${expectedProfitPct.toFixed(2)}% profit)`
      );

      try {
        await this.buyPosition(market);
        this.purchasedMarkets.add(marketKey);
        this.purchaseTimestamps.set(marketKey, Date.now());
        purchasedCount++;
      } catch (err) {
        this.logger.error(
          `[EndgameSweep] Failed to buy position ${market.id}`,
          err as Error
        );
      }
    }

    if (purchasedCount > 0) {
      this.logger.info(
        `[EndgameSweep] Purchased ${purchasedCount} endgame positions`
      );
    }

    return purchasedCount;
  }

  /**
   * Scan for endgame opportunities
   * Returns markets with prices in the target range
   */
  private async scanForEndgameOpportunities(): Promise<Market[]> {
    this.logger.debug(
      `[EndgameSweep] Scanning for positions between ${(this.config.minPrice * 100).toFixed(1)}¢ and ${(this.config.maxPrice * 100).toFixed(1)}¢`
    );

    // TODO: Implement actual Polymarket API integration
    // This is a placeholder that needs to be replaced with real API calls
    
    // In production, this would:
    // 1. Call client.getMarkets() or equivalent endpoint to fetch all active markets
    // 2. For each market, get current orderbook to check best ask/bid prices
    // 3. Filter markets where:
    //    - price is between minPrice and maxPrice (e.g., 0.98 - 0.995)
    //    - liquidity is sufficient (at least maxPositionUsd / price shares available)
    //    - market is still active and hasn't resolved yet
    //    - market has reasonable volume to ensure liquidity
    // 4. Sort results by expected profit (1.0 - price) descending
    // 5. Return top N opportunities
    //
    // Example structure (when implemented):
    // const markets = await this.client.getMarkets({ active: true });
    // const opportunities: Market[] = [];
    // for (const market of markets) {
    //   const orderbook = await this.client.getOrderbook(market.id);
    //   const bestAsk = orderbook.asks[0];
    //   if (bestAsk.price >= this.config.minPrice && 
    //       bestAsk.price <= this.config.maxPrice &&
    //       bestAsk.size * bestAsk.price >= this.config.maxPositionUsd) {
    //     opportunities.push({
    //       id: market.id,
    //       tokenId: market.tokenId,
    //       side: market.side,
    //       price: bestAsk.price,
    //       liquidity: bestAsk.size
    //     });
    //   }
    // }
    // return opportunities.sort((a, b) => (1 - a.price) - (1 - b.price)).slice(0, 10);

    return [];
  }

  /**
   * Buy a position
   * This is a placeholder for actual buying logic
   */
  private async buyPosition(market: Market): Promise<void> {
    // Validate market price before calculations
    if (market.price <= 0) {
      this.logger.warn(
        `[EndgameSweep] Invalid market price (${market.price}) for ${market.id}, skipping`
      );
      return;
    }

    // Calculate position size based on configured max and available liquidity
    const positionSize = Math.min(
      this.config.maxPositionUsd / market.price,
      market.liquidity * MAX_LIQUIDITY_USAGE_PCT // Don't take more than configured % of liquidity
    );

    // Validate position size before proceeding
    if (positionSize <= 0) {
      this.logger.warn(
        `[EndgameSweep] Invalid position size (${positionSize}) for ${market.id}, skipping`
      );
      return;
    }

    this.logger.debug(
      `[EndgameSweep] Would buy ${positionSize.toFixed(2)} of ${market.tokenId} at ${(market.price * 100).toFixed(1)}¢`
    );

    // TODO: Implement actual CLOB order creation
    // This is a placeholder that needs to be replaced with real order submission
    
    // In production, this would:
    // 1. Get current best ask price from orderbook
    //    const orderbook = await this.client.getOrderbook(market.id);
    //    const bestAsk = orderbook.asks[0];
    // 
    // 2. Create a market buy order (or limit order at ask price for better fill)
    //    const order = {
    //      tokenId: market.tokenId,
    //      side: 'BUY',
    //      type: 'LIMIT',
    //      price: bestAsk.price,
    //      size: positionSize,
    //      feeRateBps: 0, // Or get from client config
    //    };
    // 
    // 3. Sign the order with wallet credentials
    //    const signedOrder = await this.client.createOrder(order);
    // 
    // 4. Submit order to CLOB API
    //    const result = await this.client.postOrder(signedOrder);
    // 
    // 5. Poll for order status or wait for fill
    //    const filled = await this.client.waitForOrderFill(result.orderId, 30000);
    // 
    // 6. Log successful purchase with details
    //    if (filled) {
    //      const expectedProfit = (1.0 - market.price) * positionSize;
    //      this.logger.info(
    //        `[EndgameSweep] ✓ Bought ${positionSize.toFixed(2)} at ${(market.price * 100).toFixed(1)}¢ ` +
    //        `(expected profit: $${expectedProfit.toFixed(2)})`
    //      );
    //    }
  }

  /**
   * Get strategy statistics
   */
  getStats(): {
    purchasedCount: number;
    enabled: boolean;
    minPrice: number;
    maxPrice: number;
  } {
    return {
      purchasedCount: this.purchasedMarkets.size,
      enabled: this.config.enabled,
      minPrice: this.config.minPrice,
      maxPrice: this.config.maxPrice,
    };
  }

  /**
   * Clean up purchased markets older than 24 hours
   * This prevents the Set from growing indefinitely
   */
  private cleanupOldPurchases(): void {
    const now = Date.now();
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;
    
    let cleanedCount = 0;
    for (const [marketKey, timestamp] of this.purchaseTimestamps.entries()) {
      if (now - timestamp > twentyFourHoursMs) {
        this.purchasedMarkets.delete(marketKey);
        this.purchaseTimestamps.delete(marketKey);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      this.logger.debug(
        `[EndgameSweep] Cleaned up ${cleanedCount} old purchase records`
      );
    }
  }

  /**
   * Reset purchased markets tracking (for testing or daily reset)
   */
  reset(): void {
    this.purchasedMarkets.clear();
    this.purchaseTimestamps.clear();
  }
}
