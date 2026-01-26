/**
 * V2 Order - Post orders to CLOB
 *
 * Based on the working upstream implementation from Novus-Tech-LLC/Polymarket-Sniper-Bot.
 * Uses the @polymarket/clob-client's createMarketOrder API:
 * - amount = number of shares to buy/sell
 * - price = limit price for the order
 *
 * Uses Fill-Or-Kill (FOK) order type to ensure orders fill completely or not at all.
 */

import type { ClobClient } from "@polymarket/clob-client";
import { OrderType, Side } from "@polymarket/clob-client";
import { ORDER } from "./constants";
import type { OrderSide, OrderOutcome, OrderResult, Logger } from "./types";
import { isLiveTradingEnabled } from "./auth";

// In-flight tracking to prevent duplicate orders
const inFlight = new Map<string, number>();
const marketCooldown = new Map<string, number>();

export interface PostOrderInput {
  client: ClobClient;
  tokenId: string;
  outcome: OrderOutcome;
  side: OrderSide;
  sizeUsd: number;
  marketId?: string;
  maxAcceptablePrice?: number;
  skipDuplicateCheck?: boolean;
  logger?: Logger;
  /**
   * Optional: exact number of shares to sell for SELL orders.
   * When provided, will use the minimum of this value and the calculated shares.
   * For BUY orders, this parameter is ignored.
   */
  shares?: number;
}

/**
 * Post order to CLOB
 *
 * Calculates the number of shares based on sizeUsd and current orderbook price,
 * then executes the order using Fill-Or-Kill (FOK) execution.
 */
export async function postOrder(input: PostOrderInput): Promise<OrderResult> {
  const { client, tokenId, side, sizeUsd, logger, maxAcceptablePrice } = input;

  // Check live trading
  if (!isLiveTradingEnabled()) {
    logger?.warn?.(`[SIM] ${side} ${sizeUsd.toFixed(2)} USD - live trading disabled`);
    return { success: true, reason: "SIMULATED" };
  }

  // Check minimum size
  if (sizeUsd < ORDER.MIN_ORDER_USD) {
    return { success: false, reason: "ORDER_TOO_SMALL" };
  }

  // Duplicate prevention for BUY orders
  if (side === "BUY" && !input.skipDuplicateCheck) {
    const now = Date.now();

    // Token-level cooldown
    const lastOrder = inFlight.get(tokenId);
    if (lastOrder && now - lastOrder < ORDER.COOLDOWN_MS) {
      return { success: false, reason: "IN_FLIGHT" };
    }

    // Market-level cooldown
    if (input.marketId) {
      const lastMarket = marketCooldown.get(input.marketId);
      if (lastMarket && now - lastMarket < ORDER.MARKET_COOLDOWN_MS) {
        return { success: false, reason: "MARKET_COOLDOWN" };
      }
    }

    inFlight.set(tokenId, now);
    if (input.marketId) marketCooldown.set(input.marketId, now);
  }

  try {
    // Validate market exists if marketId provided
    if (input.marketId) {
      try {
        const market = await client.getMarket(input.marketId);
        if (!market) {
          return { success: false, reason: "MARKET_NOT_FOUND" };
        }
      } catch {
        // Continue even if market fetch fails - we'll catch any real issues on orderbook fetch
      }
    }

    // Get orderbook
    let orderBook;
    try {
      orderBook = await client.getOrderBook(tokenId);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (errorMessage.includes("No orderbook exists") || errorMessage.includes("404")) {
        return { success: false, reason: "MARKET_CLOSED" };
      }
      throw err;
    }

    if (!orderBook) {
      return { success: false, reason: "NO_ORDERBOOK" };
    }

    const isBuy = side === "BUY";
    const levels = isBuy ? orderBook.asks : orderBook.bids;

    if (!levels || levels.length === 0) {
      return { success: false, reason: isBuy ? "NO_ASKS" : "NO_BIDS" };
    }

    const bestPrice = parseFloat(levels[0].price);

    // Price validation
    if (bestPrice <= ORDER.MIN_TRADEABLE_PRICE) {
      return { success: false, reason: "ZERO_PRICE" };
    }

    // Loser position check for buys (price too low indicates likely losing outcome)
    if (isBuy && bestPrice < ORDER.GLOBAL_MIN_BUY_PRICE && !input.skipDuplicateCheck) {
      return { success: false, reason: "LOSER_POSITION" };
    }

    // Price protection check
    if (maxAcceptablePrice !== undefined) {
      if (isBuy && bestPrice > maxAcceptablePrice) {
        return { success: false, reason: "PRICE_TOO_HIGH" };
      }
      if (!isBuy && bestPrice < maxAcceptablePrice) {
        return { success: false, reason: "PRICE_TOO_LOW" };
      }
    }

    // Execute order with retry logic
    const orderSide = isBuy ? Side.BUY : Side.SELL;
    let remaining = sizeUsd;
    let totalFilled = 0;
    let weightedPrice = 0;
    let retryCount = 0;

    while (remaining > ORDER.MIN_ORDER_USD && retryCount < ORDER.MAX_RETRIES) {
      // Refresh orderbook for each iteration
      const currentOrderBook = await client.getOrderBook(tokenId);
      const currentLevels = isBuy ? currentOrderBook.asks : currentOrderBook.bids;

      if (!currentLevels || currentLevels.length === 0) {
        break;
      }

      const level = currentLevels[0];
      const levelPrice = parseFloat(level.price);
      const levelSize = parseFloat(level.size);

      // Calculate order size based on available liquidity
      // Convert USD amount to shares using current price
      const levelValue = levelSize * levelPrice;
      const orderValue = Math.min(remaining, levelValue);
      const orderShares = orderValue / levelPrice;

      // For SELL orders, optionally use the provided shares value (capped by available liquidity)
      // For BUY orders, always use the calculated shares
      const amount = !isBuy && input.shares !== undefined
        ? Math.min(input.shares, orderShares)
        : orderShares;

      try {
        const signedOrder = await client.createMarketOrder({
          side: orderSide,
          tokenID: tokenId,
          amount: amount,
          price: levelPrice,
        });

        const response = await client.postOrder(signedOrder, OrderType.FOK);

        if (response.success) {
          const filledValue = amount * levelPrice;
          remaining -= filledValue;
          totalFilled += filledValue;
          weightedPrice += filledValue * levelPrice;
          retryCount = 0; // Reset retry count on success
        } else {
          retryCount++;
          logger?.warn?.(`Order attempt failed: ${response.errorMsg || "Unknown error"}`);
        }
      } catch (err) {
        retryCount++;
        const msg = err instanceof Error ? err.message : String(err);
        logger?.warn?.(`Order execution error: ${msg}`);
        if (retryCount >= ORDER.MAX_RETRIES) {
          return { success: false, reason: msg };
        }
      }
    }

    if (totalFilled > 0) {
      return {
        success: true,
        filledUsd: totalFilled,
        avgPrice: weightedPrice / totalFilled,
      };
    }

    return { success: false, reason: "NO_FILLS" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("No orderbook") || msg.includes("404") || msg.includes("closed") || msg.includes("resolved")) {
      return { success: false, reason: "MARKET_CLOSED" };
    }
    return { success: false, reason: msg };
  }
}

/**
 * Clear cooldowns (for testing)
 */
export function clearCooldowns(): void {
  inFlight.clear();
  marketCooldown.clear();
}
