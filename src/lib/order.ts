/**
 * V2 Order - Post orders to CLOB
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
  maxPrice?: number;
  minPrice?: number;
  slippagePct?: number;
  skipDuplicateCheck?: boolean;
  logger?: Logger;
}

/**
 * Post order to CLOB
 */
export async function postOrder(input: PostOrderInput): Promise<OrderResult> {
  const { client, tokenId, side, sizeUsd, logger, slippagePct = ORDER.DEFAULT_SLIPPAGE_PCT } = input;

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
    // Get orderbook
    const orderBook = await client.getOrderBook(tokenId);
    if (!orderBook) {
      return { success: false, reason: "NO_ORDERBOOK" };
    }

    const isBuy = side === "BUY";
    const levels = isBuy ? orderBook.asks : orderBook.bids;

    if (!levels?.length) {
      return { success: false, reason: isBuy ? "NO_ASKS" : "NO_BIDS" };
    }

    const bestPrice = parseFloat(levels[0].price);

    // Price validation
    if (bestPrice <= ORDER.MIN_TRADEABLE_PRICE) {
      return { success: false, reason: "ZERO_PRICE" };
    }

    if (isBuy && bestPrice < ORDER.GLOBAL_MIN_BUY_PRICE && !input.skipDuplicateCheck) {
      return { success: false, reason: "LOSER_POSITION" };
    }

    // Slippage check
    const maxAccept = input.maxPrice ?? (isBuy ? bestPrice * (1 + slippagePct / 100) : undefined);
    const minAccept = input.minPrice ?? (!isBuy ? bestPrice * (1 - slippagePct / 100) : undefined);

    if (isBuy && maxAccept && bestPrice > maxAccept) {
      return { success: false, reason: "PRICE_TOO_HIGH" };
    }
    if (!isBuy && minAccept && bestPrice < minAccept) {
      return { success: false, reason: "PRICE_TOO_LOW" };
    }

    // Execute order
    const orderSide = isBuy ? Side.BUY : Side.SELL;
    let remaining = sizeUsd;
    let totalFilled = 0;
    let weightedPrice = 0;
    let retries = 0;

    while (remaining > ORDER.MIN_ORDER_USD && retries < ORDER.MAX_RETRIES) {
      try {
        const book = await client.getOrderBook(tokenId);
        const lvls = isBuy ? book.asks : book.bids;
        if (!lvls?.length) break;

        const lvl = lvls[0];
        const price = parseFloat(lvl.price);
        const size = parseFloat(lvl.size);
        const value = Math.min(remaining, size * price);
        const amount = value / price;

        const signed = await client.createMarketOrder({
          side: orderSide,
          tokenID: tokenId,
          amount,
          price,
        });

        const resp = await client.postOrder(signed, OrderType.FOK);

        if (resp.success) {
          remaining -= value;
          totalFilled += value;
          weightedPrice += value * price;
          retries = 0;
        } else {
          retries++;
        }
      } catch {
        retries++;
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
    if (msg.includes("No orderbook") || msg.includes("404")) {
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
