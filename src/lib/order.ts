/**
 * V2 Order - Post orders to CLOB
 *
 * Based on the working upstream implementation from Novus-Tech-LLC/Polymarket-Sniper-Bot.
 * Uses the @polymarket/clob-client's createMarketOrder API:
 * - amount = number of shares to buy/sell
 * - price = limit price for the order
 *
 * Supports both FOK (Fill-Or-Kill) and GTC (Good-Til-Cancelled) order types:
 * - FOK: Immediate fill or nothing. Orders do NOT sit on orderbook.
 * - GTC: Limit orders that post to orderbook and wait until filled.
 *
 * Order type configuration hierarchy:
 * - BUY_ORDER_TYPE / SELL_ORDER_TYPE (side-specific override)
 * - ORDER_TYPE (global default)
 * - FOK if none are set
 */

import type { ClobClient } from "@polymarket/clob-client";
import { OrderType, Side } from "@polymarket/clob-client";
import { ORDER, BUY, SELL } from "./constants";
import type { OrderSide, OrderOutcome, OrderResult, Logger } from "./types";
import { isLiveTradingEnabled } from "./auth";
import { isCloudflareBlock, formatErrorForLog } from "../infra/error-handling";
import { getBestPricesFromRaw } from "./orderbook-utils";
import { HARD_MIN_PRICE, HARD_MAX_PRICE } from "./price-safety";

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
   * - For BUY orders: rejects if ask price > maxAcceptablePrice
   * - For SELL orders: rejects if bid price < maxAcceptablePrice
   * - If undefined: NO price protection (emergency NUCLEAR mode)
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
  /**
   * Optional: Order type override. If not provided, uses ORDER_TYPE/BUY_ORDER_TYPE/SELL_ORDER_TYPE env.
   * - "FOK": Fill-Or-Kill - immediate execution only, does NOT sit on orderbook
   * - "GTC": Good-Til-Cancelled - posts limit order to orderbook, waits for fill
   */
  orderType?: "FOK" | "GTC";
  /**
   * Optional: On-chain price intended for future deviance-aware GTC pricing.
   *
   * NOTE: As of now, `postOrder` does NOT use this value when computing
   * order prices. Providing `onChainPrice` currently has no effect on
   * how orders are priced or submitted and should not be relied upon.
   *
   * This field is reserved for potential future behavior where GTC orders
   * may take on-chain prices into account for pricing decisions.
   */
  onChainPrice?: number;
}

/**
 * Post order to CLOB
 *
 * Based on Novus-Tech-LLC working implementation:
 * - For BUY: uses orderbook.asks
 * - For SELL: uses orderbook.bids (CORRECT!)
 * - If maxAcceptablePrice undefined → sells at ANY price (NUCLEAR mode)
 *
 * Order Types:
 * - FOK (Fill-or-Kill): Immediate execution or fail. Does NOT wait on orderbook.
 * - GTC (Good-Til-Cancelled): Posts limit order, WAITS on orderbook until filled.
 *
 * IMPORTANT: FOK orders do NOT "sit there until filled" - they are instant or cancelled!
 * Use GTC if you want a limit order that waits for your price.
 */
export async function postOrder(input: PostOrderInput): Promise<OrderResult> {
  const { client, tokenId, side, sizeUsd, logger, maxAcceptablePrice } = input;

  // Determine order type - use override, or default based on side
  // Priority: explicit override > side-specific env > master ORDER_TYPE env > FOK
  const orderType =
    input.orderType ??
    (side === "BUY" ? BUY.DEFAULT_ORDER_TYPE : SELL.DEFAULT_ORDER_TYPE);

  // Check live trading
  if (!isLiveTradingEnabled()) {
    logger?.warn?.(
      `[SIM] ${side} ${sizeUsd.toFixed(2)} USD (${orderType}) - live trading disabled`,
    );
    return { success: true, reason: "SIMULATED" };
  }

  // Check minimum size
  if (sizeUsd < ORDER.MIN_ORDER_USD) {
    logger?.debug?.(
      `Order rejected: ORDER_TOO_SMALL (${sizeUsd.toFixed(4)} < ${ORDER.MIN_ORDER_USD})`,
    );
    return { success: false, reason: "ORDER_TOO_SMALL" };
  }

  // Duplicate prevention for BUY orders
  if (side === "BUY" && !input.skipDuplicateCheck) {
    const now = Date.now();

    // Token-level cooldown
    const lastOrder = inFlight.get(tokenId);
    if (lastOrder && now - lastOrder < ORDER.COOLDOWN_MS) {
      logger?.debug?.(
        `Order rejected: IN_FLIGHT (token ${tokenId.slice(0, 8)}... cooldown)`,
      );
      return { success: false, reason: "IN_FLIGHT" };
    }

    // Market-level cooldown
    if (input.marketId) {
      const lastMarket = marketCooldown.get(input.marketId);
      if (lastMarket && now - lastMarket < ORDER.MARKET_COOLDOWN_MS) {
        logger?.debug?.(
          `Order rejected: MARKET_COOLDOWN (market ${input.marketId.slice(0, 8)}...)`,
        );
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
          logger?.debug?.(
            `Order rejected: MARKET_NOT_FOUND (${input.marketId})`,
          );
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
      if (
        errorMessage.includes("No orderbook exists") ||
        errorMessage.includes("404")
      ) {
        logger?.debug?.(
          `Order rejected: MARKET_CLOSED (no orderbook for ${tokenId.slice(0, 8)}...)`,
        );
        return { success: false, reason: "MARKET_CLOSED" };
      }
      throw err;
    }

    if (!orderBook) {
      logger?.debug?.(
        `Order rejected: NO_ORDERBOOK (null response for ${tokenId.slice(0, 8)}...)`,
      );
      return { success: false, reason: "NO_ORDERBOOK" };
    }

    const isBuy = side === "BUY";
    const levels = isBuy ? orderBook.asks : orderBook.bids;

    if (!levels || levels.length === 0) {
      const reason = isBuy ? "NO_ASKS" : "NO_BIDS";
      logger?.debug?.(
        `Order rejected: ${reason} (empty ${isBuy ? "asks" : "bids"} for ${tokenId.slice(0, 8)}...)`,
      );
      return { success: false, reason };
    }

    const bestPrice = parseFloat(levels[0].price);

    // Validate price is a finite positive number
    if (!Number.isFinite(bestPrice) || bestPrice <= 0) {
      logger?.debug?.(
        `Order rejected: INVALID_PRICE (${bestPrice} is not a valid price)`,
      );
      return { success: false, reason: "INVALID_PRICE" };
    }

    // Validate orderbook sanity - best ask should be >= best bid
    // Use normalized prices (sorted correctly) instead of raw [0] index
    if (orderBook.asks?.length && orderBook.bids?.length) {
      const { bestBid: normalizedBid, bestAsk: normalizedAsk } =
        getBestPricesFromRaw(orderBook);
      if (
        normalizedBid !== null &&
        normalizedAsk !== null &&
        normalizedBid > normalizedAsk
      ) {
        logger?.error?.(
          `Order rejected: INVALID_ORDERBOOK (bid ${normalizedBid} > ask ${normalizedAsk})`,
        );
        return { success: false, reason: "INVALID_ORDERBOOK" };
      }
    }

    // Price validation
    if (bestPrice <= ORDER.MIN_TRADEABLE_PRICE) {
      logger?.debug?.(
        `Order rejected: ZERO_PRICE (${bestPrice} <= ${ORDER.MIN_TRADEABLE_PRICE})`,
      );
      return { success: false, reason: "ZERO_PRICE" };
    }

    // Loser position check for buys (price too low indicates likely losing outcome)
    if (
      isBuy &&
      bestPrice < ORDER.GLOBAL_MIN_BUY_PRICE &&
      !input.skipDuplicateCheck
    ) {
      logger?.debug?.(
        `Order rejected: LOSER_POSITION (price ${bestPrice} < ${ORDER.GLOBAL_MIN_BUY_PRICE})`,
      );
      return { success: false, reason: "LOSER_POSITION" };
    }

    // Price protection check
    if (maxAcceptablePrice !== undefined) {
      if (isBuy && bestPrice > maxAcceptablePrice) {
        logger?.debug?.(
          `Order rejected: PRICE_TOO_HIGH (${bestPrice} > max ${maxAcceptablePrice})`,
        );
        return { success: false, reason: "PRICE_TOO_HIGH" };
      }
      if (!isBuy && bestPrice < maxAcceptablePrice) {
        logger?.debug?.(
          `Order rejected: PRICE_TOO_LOW (${bestPrice} < min ${maxAcceptablePrice})`,
        );
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
      if (
        !isBuy &&
        remainingShares !== undefined &&
        remainingShares <= ORDER.MIN_SHARES_THRESHOLD
      )
        return false;
      return retryCount < ORDER.MAX_RETRIES;
    };

    while (shouldContinue()) {
      // Refresh orderbook for each iteration
      const currentOrderBook = await client.getOrderBook(tokenId);
      const currentLevels = isBuy
        ? currentOrderBook.asks
        : currentOrderBook.bids;

      if (!currentLevels || currentLevels.length === 0) {
        break;
      }

      const level = currentLevels[0];
      const rawLevelPrice = parseFloat(level.price);
      const levelSize = parseFloat(level.size);

      // Clamp price to HARD API bounds (0.01-0.99)
      const levelPrice = Math.max(
        HARD_MIN_PRICE,
        Math.min(HARD_MAX_PRICE, rawLevelPrice),
      );

      // Log if price was clamped (shouldn't happen normally, but safety first)
      if (levelPrice !== rawLevelPrice) {
        logger?.warn?.(
          `⚠️ [ORDER] Price clamped to HARD bounds: ${rawLevelPrice.toFixed(4)} → ${levelPrice.toFixed(4)} (${side})`,
        );
      }

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

        // Use the appropriate order type
        // FOK = Fill immediately or fail (does NOT sit on orderbook)
        // GTC = Post as limit order and WAIT for fill (sits on orderbook)
        const clobOrderType =
          orderType === "GTC" ? OrderType.GTC : OrderType.FOK;
        const response = await client.postOrder(signedOrder, clobOrderType);

        if (response.success) {
          // For GTC orders: order is POSTED but not necessarily FILLED
          // Don't update accounting - the order sits on the orderbook waiting
          // Return immediately with orderId for tracking
          if (orderType === "GTC") {
            const orderId =
              (response as any).orderId || (response as any).orderHashes?.[0];
            logger?.info?.(
              `GTC ${side} order posted: ${orderId?.slice(0, 12) || "unknown"}... @ ${(levelPrice * 100).toFixed(1)}¢`,
            );
            return {
              success: true,
              orderId,
              avgPrice: levelPrice,
              reason: "GTC_POSTED", // Indicates order is posted, not filled
            };
          }

          // For FOK orders: order filled immediately, update accounting
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

          if (
            lowerMsg.includes("not enough balance") ||
            lowerMsg.includes("insufficient balance")
          ) {
            reasonCode = "INSUFFICIENT_BALANCE";
          } else if (
            lowerMsg.includes("not enough allowance") ||
            lowerMsg.includes("insufficient allowance")
          ) {
            reasonCode = "INSUFFICIENT_ALLOWANCE";
          } else if (
            lowerMsg.includes("price exceeds max") ||
            lowerMsg.includes("slippage")
          ) {
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

        if (
          lowerMsg.includes("not enough balance") ||
          lowerMsg.includes("insufficient balance")
        ) {
          reasonCode = "INSUFFICIENT_BALANCE";
          cleanMessage = `Insufficient balance: ${cleanMessage}`;
        } else if (
          lowerMsg.includes("not enough allowance") ||
          lowerMsg.includes("insufficient allowance")
        ) {
          reasonCode = "INSUFFICIENT_ALLOWANCE";
          cleanMessage = `Insufficient allowance: ${cleanMessage}`;
        } else if (
          lowerMsg.includes("price exceeds max") ||
          lowerMsg.includes("slippage")
        ) {
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

    logger?.debug?.(
      `Order rejected: NO_FILLS after ${ORDER.MAX_RETRIES} retries for ${tokenId.slice(0, 8)}...`,
    );
    return {
      success: false,
      reason: lastErrorReason !== "NO_ERROR" ? lastErrorReason : "NO_FILLS",
    };
  } catch (err) {
    // Check for Cloudflare block
    if (isCloudflareBlock(err)) {
      return { success: false, reason: "CLOUDFLARE_BLOCKED" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("No orderbook") ||
      msg.includes("404") ||
      msg.includes("closed") ||
      msg.includes("resolved")
    ) {
      logger?.debug?.(
        `Order rejected: MARKET_CLOSED (error: ${msg.slice(0, 50)})`,
      );
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

// ═══════════════════════════════════════════════════════════════════════════
// GTC ORDER TRACKING - Monitor, adjust, and cancel GTC orders based on deviance
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Tracked GTC order for monitoring and potential cancellation/adjustment
 */
export interface TrackedGtcOrder {
  orderId: string;
  tokenId: string;
  side: OrderSide;
  price: number; // Price the order was placed at
  sizeUsd: number; // Original order size in USD
  shares: number; // Number of shares in the order
  createdAt: number; // Timestamp when order was placed
  expiresAt: number; // When to auto-cancel (internal timeout)
  reason: string; // Why this order was placed (e.g., "whale_copy", "deviance_arb")
  onChainPriceAtCreation?: number; // On-chain price when order was created (for deviance tracking)
}

/**
 * Order that needs repricing due to deviance shift
 */
export interface OrderToReprice {
  order: TrackedGtcOrder;
  newPrice: number;
  reason: string;
}

/**
 * GTC Order Tracker - Monitors open GTC orders and adjusts them based on price deviance
 *
 * CRITICAL: GTC orders sit on the orderbook and can fill at any time!
 * We need to monitor them and:
 * - Cancel when price drifts too far (market moved against us)
 * - REPRICE when on-chain deviance shifts (better price available)
 * - Cancel when order is too old (conditions may have changed)
 * - Cancel when whale flow reverses (our thesis is now wrong)
 *
 * DEVIANCE-AWARE REPRICING:
 * When on-chain price changes, we may want to adjust our GTC price to capture
 * the new deviance. This is like a "trailing limit order" that follows on-chain.
 */
export class GtcOrderTracker {
  private orders: Map<string, TrackedGtcOrder> = new Map();
  private readonly maxPriceDriftPct: number;
  private readonly defaultExpiryMs: number;
  private readonly repriceThresholdCents: number;

  constructor(options?: {
    maxPriceDriftPct?: number;
    defaultExpiryMs?: number;
    repriceThresholdCents?: number;
  }) {
    // Cancel GTC if price drifts more than 3% from our order price
    this.maxPriceDriftPct = options?.maxPriceDriftPct ?? 3;
    // Default expiry: 1 hour (can be overridden per-order)
    this.defaultExpiryMs =
      options?.defaultExpiryMs ?? BUY.GTC_EXPIRATION_SECONDS * 1000;
    // Reprice if deviance shifts by more than 1 cent
    this.repriceThresholdCents = options?.repriceThresholdCents ?? 1;
  }

  /**
   * Track a new GTC order
   */
  track(
    order: Omit<TrackedGtcOrder, "createdAt" | "expiresAt"> & {
      expiresAt?: number;
    },
  ): void {
    const now = Date.now();
    this.orders.set(order.orderId, {
      ...order,
      createdAt: now,
      expiresAt: order.expiresAt ?? now + this.defaultExpiryMs,
    });
    console.log(
      `📋 Tracking GTC ${order.side}: ${order.orderId.slice(0, 12)}... @ ${(order.price * 100).toFixed(1)}¢`,
    );
  }

  /**
   * Stop tracking an order (filled or cancelled)
   */
  untrack(orderId: string): void {
    if (this.orders.delete(orderId)) {
      console.log(`📋 Untracked GTC order: ${orderId.slice(0, 12)}...`);
    }
  }

  /**
   * Get all tracked orders
   */
  getOrders(): TrackedGtcOrder[] {
    return Array.from(this.orders.values());
  }

  /**
   * Get orders for a specific token
   */
  getOrdersForToken(tokenId: string): TrackedGtcOrder[] {
    return this.getOrders().filter((o) => o.tokenId === tokenId);
  }

  /**
   * Check which orders should be cancelled based on current conditions
   *
   * @param currentPrices - Map of tokenId → current market price
   * @returns Array of orderIds that should be cancelled
   */
  checkForCancellations(currentPrices: Map<string, number>): TrackedGtcOrder[] {
    const now = Date.now();
    const toCancel: TrackedGtcOrder[] = [];

    for (const order of this.orders.values()) {
      // Check 1: Time expiry
      if (now >= order.expiresAt) {
        console.log(
          `⏰ GTC order expired: ${order.orderId.slice(0, 12)}... (${order.side} @ ${(order.price * 100).toFixed(1)}¢)`,
        );
        toCancel.push(order);
        continue;
      }

      // Check 2: Price drift - cancel if market moved AWAY from our order
      // For limit orders, we want the market to move TOWARD our price to fill us.
      //
      // BUY order at 65¢: We want price to go DOWN toward 65¢ to fill
      //   - If price goes UP (now 70¢), market moved AWAY, cancel (won't fill)
      // SELL order at 70¢: We want price to go UP toward 70¢ to fill
      //   - If price goes DOWN (now 65¢), market moved AWAY, cancel (won't fill)
      //
      // CRITICAL: The logic checks if market moved unfavorably for our order filling
      const currentPrice = currentPrices.get(order.tokenId);
      if (currentPrice !== undefined) {
        const driftPct =
          Math.abs((currentPrice - order.price) / order.price) * 100;

        if (driftPct > this.maxPriceDriftPct) {
          // For BUY orders: cancel if price went UP (market moved away, won't fill)
          // For SELL orders: cancel if price went DOWN (market moved away, won't fill)
          const priceWentUp = currentPrice > order.price;
          const priceWentDown = currentPrice < order.price;
          const shouldCancel =
            (order.side === "BUY" && priceWentUp) ||
            (order.side === "SELL" && priceWentDown);

          if (shouldCancel) {
            console.log(
              `📉 GTC order stale (market moved away): ${order.orderId.slice(0, 12)}... ` +
                `${order.side} @ ${(order.price * 100).toFixed(1)}¢ → now ${(currentPrice * 100).toFixed(1)}¢ ` +
                `(${driftPct.toFixed(1)}% drift)`,
            );
            toCancel.push(order);
          }
        }
      }
    }

    return toCancel;
  }

  /**
   * Cancel orders via CLOB client
   *
   * @param client - CLOB client for cancellation
   * @param orders - Orders to cancel
   * @returns Number of successfully cancelled orders
   */
  async cancelOrders(
    client: ClobClient,
    orders: TrackedGtcOrder[],
  ): Promise<number> {
    if (orders.length === 0) return 0;

    try {
      // Use batch cancel API with order IDs
      const orderIds = orders.map((o) => o.orderId);
      await client.cancelOrders(orderIds);

      // Untrack all cancelled orders
      for (const order of orders) {
        this.untrack(order.orderId);
        console.log(
          `✅ Cancelled GTC: ${order.orderId.slice(0, 12)}... (${order.side} @ ${(order.price * 100).toFixed(1)}¢)`,
        );
      }

      return orders.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️ Failed to cancel GTC orders: ${msg}`);

      // Try to untrack orders that might already be filled/cancelled
      for (const order of orders) {
        this.untrack(order.orderId);
      }

      return 0;
    }
  }

  /**
   * Cancel all orders for a token (e.g., when whale flow reverses)
   */
  async cancelOrdersForToken(
    client: ClobClient,
    tokenId: string,
    reason: string,
  ): Promise<number> {
    const orders = this.getOrdersForToken(tokenId);
    if (orders.length > 0) {
      console.log(
        `🔄 Cancelling ${orders.length} GTC orders for token ${tokenId.slice(0, 8)}... (${reason})`,
      );
    }
    return this.cancelOrders(client, orders);
  }

  /**
   * Get summary stats for logging
   */
  getStats(): {
    total: number;
    buys: number;
    sells: number;
    totalValueUsd: number;
  } {
    const orders = this.getOrders();
    return {
      total: orders.length,
      buys: orders.filter((o) => o.side === "BUY").length,
      sells: orders.filter((o) => o.side === "SELL").length,
      totalValueUsd: orders.reduce((sum, o) => sum + o.sizeUsd, 0),
    };
  }
}

// Global GTC order tracker instance
export const gtcOrderTracker = new GtcOrderTracker();
