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
import { isCloudflareBlock, formatErrorForLog } from "./error-handling";

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
  /**
   * Optional maximum acceptable price for price protection.
   * 
   * **For BUY orders:**
   * - Rejects if ask price > maxAcceptablePrice
   * - Prevents buying at prices higher than expected
   * 
   * **For SELL orders:**
   * - Rejects if bid price < maxAcceptablePrice
   * - Prevents selling at prices lower than expected
   * 
   * **Special case - NUCLEAR mode:**
   * - If undefined: NO price protection (sells at ANY price)
   * - Used in emergency NUCLEAR mode to force sells
   * 
   * @example
   * // Standard sell with 1% slippage
   * maxAcceptablePrice: position.avgPrice * 0.99
   * 
   * @example
   * // Emergency CONSERVATIVE (won't sell below 50% of entry)
   * maxAcceptablePrice: position.avgPrice * 0.50
   * 
   * @example
   * // Emergency NUCLEAR (no protection)
   * maxAcceptablePrice: undefined
   */
  maxAcceptablePrice?: number;
  skipDuplicateCheck?: boolean;
  logger?: Logger;
  /**
   * Optional: exact number of shares to sell for SELL orders.
   * When provided, this is the total share limit across all iterations.
   * The loop will stop when either sizeUsd is exhausted or shares are exhausted.
   * For BUY orders, this parameter is ignored.
   */
  shares?: number;
}

/**
 * Post order to CLOB with retry logic and price protection
 * 
 * **Universal order posting function** supporting both BUY and SELL orders with:
 * - Optional price protection via maxAcceptablePrice parameter
 * - Retry logic for partial fills across multiple orderbook levels
 * - Fill-or-Kill (FOK) execution (order fills completely or not at all)
 * - Duplicate prevention for BUY orders (cooldowns)
 * 
 * **Key Implementation Details:**
 * 
 * 1. **Side Selection:**
 *    - BUY orders use orderbook **asks** (sellers)
 *    - SELL orders use orderbook **bids** (buyers) ✅ CORRECT!
 * 
 * 2. **Price Protection:**
 *    - If maxAcceptablePrice is undefined → NO PROTECTION (NUCLEAR mode for sells)
 *    - If maxAcceptablePrice is defined → enforces minimum/maximum price
 *    - For SELL: blocks if bestBid < maxAcceptablePrice
 *    - For BUY: blocks if bestAsk > maxAcceptablePrice
 * 
 * 3. **Execution Flow:**
 *    - Validates market exists (if marketId provided)
 *    - Fetches orderbook
 *    - Checks price protection
 *    - Executes order with retry loop (up to MAX_RETRIES)
 *    - Refreshes orderbook on each retry for current prices
 *    - Stops on success, exhausted size, or max retries
 * 
 * 4. **Retry Logic:**
 *    - Processes orderbook level by level
 *    - Fresh orderbook fetch on each iteration
 *    - Re-enforces price protection on each retry
 *    - Accumulates fills until sizeUsd or shares exhausted
 * 
 * **Based on:** Novus-Tech-LLC working implementation
 * 
 * **Common Return Reasons:**
 * - `ORDER_TOO_SMALL`: Order size < $0.10 minimum
 * - `NO_BIDS`: No buyers in orderbook (SELL orders)
 * - `NO_ASKS`: No sellers in orderbook (BUY orders)
 * - `PRICE_TOO_LOW`: Best bid below minimum (SELL orders)
 * - `PRICE_TOO_HIGH`: Best ask above maximum (BUY orders)
 * - `MARKET_CLOSED`: Market resolved or removed
 * - `INSUFFICIENT_BALANCE`: Not enough USDC (BUY orders)
 * - `INSUFFICIENT_ALLOWANCE`: Contract allowance too low
 * - `CLOUDFLARE_BLOCKED`: IP geo-blocked (use VPN)
 * - `NO_FILLS`: Couldn't fill after max retries
 * 
 * **Known Edge Cases:**
 * - Orderbook data can become stale between fetch and post
 * - FOK may be too strict in low liquidity (partial fills rejected)
 * - maxAcceptablePrice calculated from stale data may block unnecessarily
 * - Fresh orderbook fetch on each retry helps mitigate these issues
 * 
 * @param input - Order parameters (see PostOrderInput)
 * @returns Promise<OrderResult> - success boolean, filledUsd, avgPrice, or failure reason
 * 
 * @see docs/SELLING_LOGIC.md for complete selling logic documentation
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
    logger?.debug?.(`Order rejected: ORDER_TOO_SMALL (${sizeUsd.toFixed(4)} < ${ORDER.MIN_ORDER_USD})`);
    return { success: false, reason: "ORDER_TOO_SMALL" };
  }

  // Duplicate prevention for BUY orders
  if (side === "BUY" && !input.skipDuplicateCheck) {
    const now = Date.now();

    // Token-level cooldown
    const lastOrder = inFlight.get(tokenId);
    if (lastOrder && now - lastOrder < ORDER.COOLDOWN_MS) {
      logger?.debug?.(`Order rejected: IN_FLIGHT (token ${tokenId.slice(0, 8)}... cooldown)`);
      return { success: false, reason: "IN_FLIGHT" };
    }

    // Market-level cooldown
    if (input.marketId) {
      const lastMarket = marketCooldown.get(input.marketId);
      if (lastMarket && now - lastMarket < ORDER.MARKET_COOLDOWN_MS) {
        logger?.debug?.(`Order rejected: MARKET_COOLDOWN (market ${input.marketId.slice(0, 8)}...)`);
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
          logger?.debug?.(`Order rejected: MARKET_NOT_FOUND (${input.marketId})`);
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
        logger?.debug?.(`Order rejected: MARKET_CLOSED (no orderbook for ${tokenId.slice(0, 8)}...)`);
        return { success: false, reason: "MARKET_CLOSED" };
      }
      throw err;
    }

    if (!orderBook) {
      logger?.debug?.(`Order rejected: NO_ORDERBOOK (null response for ${tokenId.slice(0, 8)}...)`);
      return { success: false, reason: "NO_ORDERBOOK" };
    }

    const isBuy = side === "BUY";
    const levels = isBuy ? orderBook.asks : orderBook.bids;

    if (!levels || levels.length === 0) {
      const reason = isBuy ? "NO_ASKS" : "NO_BIDS";
      logger?.debug?.(`Order rejected: ${reason} (empty ${isBuy ? "asks" : "bids"} for ${tokenId.slice(0, 8)}...)`);
      return { success: false, reason };
    }

    const bestPrice = parseFloat(levels[0].price);

    // Price validation
    if (bestPrice <= ORDER.MIN_TRADEABLE_PRICE) {
      logger?.debug?.(`Order rejected: ZERO_PRICE (${bestPrice} <= ${ORDER.MIN_TRADEABLE_PRICE})`);
      return { success: false, reason: "ZERO_PRICE" };
    }

    // Loser position check for buys (price too low indicates likely losing outcome)
    if (isBuy && bestPrice < ORDER.GLOBAL_MIN_BUY_PRICE && !input.skipDuplicateCheck) {
      logger?.debug?.(`Order rejected: LOSER_POSITION (price ${bestPrice} < ${ORDER.GLOBAL_MIN_BUY_PRICE})`);
      return { success: false, reason: "LOSER_POSITION" };
    }

    // Price protection check
    if (maxAcceptablePrice !== undefined) {
      if (isBuy && bestPrice > maxAcceptablePrice) {
        logger?.debug?.(`Order rejected: PRICE_TOO_HIGH (${bestPrice} > max ${maxAcceptablePrice})`);
        return { success: false, reason: "PRICE_TOO_HIGH" };
      }
      if (!isBuy && bestPrice < maxAcceptablePrice) {
        logger?.debug?.(`Order rejected: PRICE_TOO_LOW`);
        logger?.debug?.(`   Best ${isBuy ? 'ask' : 'bid'}: ${(bestPrice * 100).toFixed(1)}¢`);
        logger?.debug?.(`   Min acceptable: ${(maxAcceptablePrice * 100).toFixed(1)}¢`);
        logger?.debug?.(`   Tip: This sell is blocked by price protection`);
        return { success: false, reason: "PRICE_TOO_LOW" };
      }
    }

    // Execute order with retry logic
    const orderSide = isBuy ? Side.BUY : Side.SELL;
    let remaining = sizeUsd;
    let remainingShares = input.shares; // Track remaining shares for SELL orders
    let totalFilled = 0;
    let totalShares = 0; // Track total shares for accurate avgPrice calculation
    let retryCount = 0;
    let lastErrorReason = "NO_ERROR"; // Track last error for better reporting

    // For SELL orders with shares specified, also check if remainingShares is exhausted
    const shouldContinue = () => {
      if (remaining <= ORDER.MIN_ORDER_USD) return false;
      if (!isBuy && remainingShares !== undefined && remainingShares <= ORDER.MIN_SHARES_THRESHOLD) return false;
      return retryCount < ORDER.MAX_RETRIES;
    };

    while (shouldContinue()) {
      // Refresh orderbook for each iteration
      const currentOrderBook = await client.getOrderBook(tokenId);
      const currentLevels = isBuy ? currentOrderBook.asks : currentOrderBook.bids;

      if (!currentLevels || currentLevels.length === 0) {
        break;
      }

      const level = currentLevels[0];
      const levelPrice = parseFloat(level.price);
      const levelSize = parseFloat(level.size);

      // Enforce maxAcceptablePrice on each iteration to provide price protection across retries
      if (maxAcceptablePrice !== undefined) {
        if (isBuy && levelPrice > maxAcceptablePrice) {
          return { success: false, reason: "PRICE_TOO_HIGH" };
        }
        if (!isBuy && levelPrice < maxAcceptablePrice) {
          return { success: false, reason: "PRICE_TOO_LOW" };
        }
      }

      // Calculate order size based on available liquidity
      // Convert USD amount to shares using current price
      const levelValue = levelSize * levelPrice;
      const orderValue = Math.min(remaining, levelValue);
      const orderShares = orderValue / levelPrice;

      // For SELL orders, optionally use the remaining shares value (capped by available liquidity)
      // For BUY orders, always use the calculated shares
      let amount = orderShares;
      if (!isBuy && remainingShares !== undefined) {
        amount = Math.min(remainingShares, orderShares);
      }

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
          totalShares += amount; // Track shares for accurate avgPrice
          // Decrement remaining shares for SELL orders
          if (!isBuy && remainingShares !== undefined) {
            remainingShares -= amount;
          }
          retryCount = 0; // Reset retry count on success
        } else {
          retryCount++;
          // Extract clean error message from response
          const errorObj = response as any;
          let cleanMessage = "";
          let reasonCode = "";
          
          if (errorObj?.errorMsg) {
            cleanMessage = errorObj.errorMsg;
          } else if (errorObj?.error) {
            cleanMessage = errorObj.error;
          } else {
            cleanMessage = "Unknown error";
          }
          
          // Check for Cloudflare block
          if (isCloudflareBlock(cleanMessage) || isCloudflareBlock(response)) {
            logger?.error?.(
              `Order blocked by Cloudflare (403). Your IP may be geo-blocked. Consider using a VPN.`,
            );
            return { success: false, reason: "CLOUDFLARE_BLOCKED" };
          }
          
          // Check for specific error types
          const lowerMsg = cleanMessage.toLowerCase();
          
          if (lowerMsg.includes("not enough balance") || lowerMsg.includes("insufficient balance")) {
            reasonCode = "INSUFFICIENT_BALANCE";
          } else if (lowerMsg.includes("not enough allowance") || lowerMsg.includes("insufficient allowance")) {
            reasonCode = "INSUFFICIENT_ALLOWANCE";
          } else if (lowerMsg.includes("price exceeds max") || lowerMsg.includes("slippage")) {
            reasonCode = "PRICE_SLIPPAGE";
          }
          
          lastErrorReason = reasonCode || cleanMessage; // Track for final return
          logger?.warn?.(`Order attempt failed: ${lastErrorReason}`);
        }
      } catch (err) {
        retryCount++;
        // Check for Cloudflare block in error
        if (isCloudflareBlock(err)) {
          logger?.error?.(
            `Order blocked by Cloudflare (403). Your IP may be geo-blocked. Consider using a VPN.`,
          );
          return { success: false, reason: "CLOUDFLARE_BLOCKED" };
        }
        
        // Extract clean error message
        const errorObj = err as any;
        let cleanMessage = "";
        let reasonCode = "";
        
        // Try to extract the actual error message from common CLOB response structures
        if (errorObj?.response?.data?.error) {
          cleanMessage = errorObj.response.data.error;
        } else if (errorObj?.data?.error) {
          cleanMessage = errorObj.data.error;
        } else if (errorObj?.message) {
          cleanMessage = errorObj.message;
        } else {
          cleanMessage = String(err);
        }
        
        // Check for specific error types and assign reason codes
        const lowerMsg = cleanMessage.toLowerCase();
        
        if (lowerMsg.includes("not enough balance") || lowerMsg.includes("insufficient balance")) {
          reasonCode = "INSUFFICIENT_BALANCE";
          cleanMessage = `Insufficient balance: ${cleanMessage}`;
        } else if (lowerMsg.includes("not enough allowance") || lowerMsg.includes("insufficient allowance")) {
          reasonCode = "INSUFFICIENT_ALLOWANCE";
          cleanMessage = `Insufficient allowance: ${cleanMessage}`;
        } else if (lowerMsg.includes("price exceeds max") || lowerMsg.includes("slippage")) {
          reasonCode = "PRICE_SLIPPAGE";
          cleanMessage = `Price slippage: ${cleanMessage}`;
        } else {
          reasonCode = formatErrorForLog(err);
        }
        
        logger?.warn?.(`Order execution error: ${cleanMessage}`);
        
        lastErrorReason = reasonCode || cleanMessage; // Track for final return
        
        if (retryCount >= ORDER.MAX_RETRIES) {
          return { success: false, reason: lastErrorReason };
        }
      }
    }

    if (totalFilled > 0) {
      // Note: if totalFilled > 0 then totalShares must also be > 0 since
      // totalFilled = sum(amount * price) and amount is always added to totalShares
      // The conditional check is defensive programming for edge cases.
      return {
        success: true,
        filledUsd: totalFilled,
        avgPrice: totalShares > 0 ? totalFilled / totalShares : 0,
      };
    }

    logger?.debug?.(`Order rejected: NO_FILLS after ${ORDER.MAX_RETRIES} retries for ${tokenId.slice(0, 8)}...`);
    return { 
      success: false, 
      reason: lastErrorReason !== "NO_ERROR" ? lastErrorReason : "NO_FILLS" 
    };
  } catch (err) {
    // Check for Cloudflare block
    if (isCloudflareBlock(err)) {
      return { success: false, reason: "CLOUDFLARE_BLOCKED" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("No orderbook") || msg.includes("404") || msg.includes("closed") || msg.includes("resolved")) {
      logger?.debug?.(`Order rejected: MARKET_CLOSED (error: ${msg.slice(0, 50)})`);
      return { success: false, reason: "MARKET_CLOSED" };
    }
    logger?.debug?.(`Order rejected: ${msg.slice(0, 100)}`);
    return { success: false, reason: formatErrorForLog(msg) };
  }
}

/**
 * Clear cooldowns (for testing)
 */
export function clearCooldowns(): void {
  inFlight.clear();
  marketCooldown.clear();
}
