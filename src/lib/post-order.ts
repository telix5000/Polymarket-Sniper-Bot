/**
 * V2 Order Posting Utility
 * Clean, self-contained order submission for Polymarket CLOB
 */

import type { ClobClient } from "@polymarket/clob-client";
import { OrderType, Side } from "@polymarket/clob-client";
import { ORDER_SETTINGS } from "./constants";

export type OrderSide = "BUY" | "SELL";
export type OrderOutcome = "YES" | "NO";

export interface PostOrderInput {
  client: ClobClient;
  tokenId: string;
  outcome: OrderOutcome;
  side: OrderSide;
  sizeUsd: number;
  maxPrice?: number; // For BUY: max price to pay
  minPrice?: number; // For SELL: min price to accept
  slippagePct?: number;
}

export interface PostOrderResult {
  success: boolean;
  reason?: string;
  filledUsd?: number;
  avgPrice?: number;
}

/**
 * Post an order to the Polymarket CLOB
 * Simple, clean implementation without V1 dependencies
 */
export async function postOrder(input: PostOrderInput): Promise<PostOrderResult> {
  const { client, tokenId, side, sizeUsd, slippagePct = ORDER_SETTINGS.DEFAULT_SLIPPAGE_PCT } = input;

  // Validate minimum order size
  if (sizeUsd < ORDER_SETTINGS.MIN_REMAINING_USD) {
    return { success: false, reason: "ORDER_TOO_SMALL" };
  }

  // Fetch orderbook
  let orderBook;
  try {
    orderBook = await client.getOrderBook(tokenId);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("No orderbook") || msg.includes("404")) {
      return { success: false, reason: "MARKET_CLOSED" };
    }
    return { success: false, reason: `ORDERBOOK_ERROR: ${msg}` };
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

  // Price protection
  if (bestPrice <= ORDER_SETTINGS.MIN_TRADEABLE_PRICE) {
    return { success: false, reason: "ZERO_PRICE_LEVEL" };
  }

  // BUY price check - don't buy loser positions
  if (isBuy && bestPrice < ORDER_SETTINGS.GLOBAL_MIN_BUY_PRICE) {
    return { success: false, reason: "LOSER_POSITION" };
  }

  // Slippage check
  const maxAcceptable = input.maxPrice ?? (isBuy ? bestPrice * (1 + slippagePct / 100) : undefined);
  const minAcceptable = input.minPrice ?? (!isBuy ? bestPrice * (1 - slippagePct / 100) : undefined);

  if (isBuy && maxAcceptable && bestPrice > maxAcceptable) {
    return { success: false, reason: "PRICE_TOO_HIGH" };
  }
  if (!isBuy && minAcceptable && bestPrice < minAcceptable) {
    return { success: false, reason: "PRICE_TOO_LOW" };
  }

  // Execute order
  const orderSide = isBuy ? Side.BUY : Side.SELL;
  let remaining = sizeUsd;
  let totalFilled = 0;
  let weightedPrice = 0;
  let retryCount = 0;

  while (remaining > ORDER_SETTINGS.MIN_REMAINING_USD && retryCount < ORDER_SETTINGS.MAX_RETRIES) {
    try {
      const currentBook = await client.getOrderBook(tokenId);
      const currentLevels = isBuy ? currentBook.asks : currentBook.bids;

      if (!currentLevels || currentLevels.length === 0) {
        break;
      }

      const level = currentLevels[0];
      const levelPrice = parseFloat(level.price);
      const levelSize = parseFloat(level.size);
      const levelValue = levelSize * levelPrice;
      const orderValue = Math.min(remaining, levelValue);
      const orderSize = orderValue / levelPrice;

      const signedOrder = await client.createMarketOrder({
        side: orderSide,
        tokenID: tokenId,
        amount: orderSize,
        price: levelPrice,
      });

      const response = await client.postOrder(signedOrder, OrderType.FOK);

      if (response.success) {
        remaining -= orderValue;
        totalFilled += orderValue;
        weightedPrice += orderValue * levelPrice;
        retryCount = 0;
      } else {
        retryCount++;
      }
    } catch {
      retryCount++;
      if (retryCount >= ORDER_SETTINGS.MAX_RETRIES) {
        break;
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
}
