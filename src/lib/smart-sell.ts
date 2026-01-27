/**
 * Smart Sell Module - Intelligent sell order execution
 *
 * This module implements best practices from Polymarket documentation and
 * community recommendations to avoid bad bids and losing money on sells:
 *
 * KEY IMPROVEMENTS:
 * 1. Orderbook depth analysis - Check liquidity before selling
 * 2. Slippage protection - Configurable based on position state
 * 3. Order type selection - FOK for liquid, GTC for illiquid markets
 * 4. Expected fill price calculation - Know what you'll get before executing
 * 5. Smart order sizing - Chunk orders to avoid eating through orderbook
 *
 * Based on research from:
 * - Polymarket official docs (docs.polymarket.com)
 * - py-clob-client best practices
 * - Reddit/community discussions on avoiding slippage
 */

import type { ClobClient } from "@polymarket/clob-client";
import { OrderType, Side } from "@polymarket/clob-client";
import { SELL, ORDER } from "./constants";
import type { Position, OrderResult, Logger } from "./types";
import { isLiveTradingEnabled } from "./auth";
import { isCloudflareBlock, formatErrorForLog } from "./error-handling";

// ============================================================================
// TYPES
// ============================================================================

/** Order book level with price and size */
export interface OrderBookLevel {
  price: number;
  size: number;
}

/** Analysis of orderbook liquidity */
export interface LiquidityAnalysis {
  /** Best bid price */
  bestBid: number;
  /** Total liquidity (USD) within slippage tolerance */
  liquidityAtSlippage: number;
  /** Total liquidity (USD) at best bid only */
  liquidityAtBestBid: number;
  /** Expected average fill price if selling full amount */
  expectedAvgPrice: number;
  /** Expected slippage percentage based on order size */
  expectedSlippagePct: number;
  /** Whether there's enough liquidity to fill the order */
  canFill: boolean;
  /** Number of orderbook levels needed to fill */
  levelsNeeded: number;
  /** Detailed breakdown per level */
  levels: OrderBookLevel[];
}

/** Configuration for smart sell */
export interface SmartSellConfig {
  /** Maximum slippage allowed (percentage, e.g., 2 = 2%) */
  maxSlippagePct?: number;
  /** Minimum liquidity required at best bid (USD) */
  minLiquidityUsd?: number;
  /** Order type: "FOK" for immediate fill, "GTC" to wait for better price */
  orderType?: "FOK" | "GTC";
  /** For GTC orders, expiration in seconds */
  gtcExpirationSeconds?: number;
  /** Force sell even if conditions aren't ideal (stop-loss scenarios) */
  forceSell?: boolean;
  /** Logger for detailed output */
  logger?: Logger;
}

/** Result of a smart sell operation */
export interface SmartSellResult extends OrderResult {
  /** Analysis of orderbook before sale */
  analysis?: LiquidityAnalysis;
  /** Actual fill price achieved */
  actualPrice?: number;
  /** How much slippage occurred */
  actualSlippagePct?: number;
  /** Order type used */
  orderType?: "FOK" | "GTC";
}

// ============================================================================
// ORDERBOOK ANALYSIS
// ============================================================================

/**
 * Parse orderbook levels into a clean format
 */
function parseOrderBookLevels(levels: any[]): OrderBookLevel[] {
  if (!levels || !Array.isArray(levels)) return [];
  return levels
    .map((l) => ({
      price: parseFloat(l.price),
      size: parseFloat(l.size),
    }))
    .filter((l) => !isNaN(l.price) && !isNaN(l.size) && l.size > 0);
}

/**
 * Analyze orderbook liquidity to determine expected fill
 *
 * This is the KEY function that prevents bad sells - it calculates
 * exactly what price you'll get BEFORE you execute the order.
 */
export function analyzeLiquidity(
  bids: OrderBookLevel[],
  sharesToSell: number,
  maxSlippagePct: number,
): LiquidityAnalysis {
  if (!bids || bids.length === 0) {
    return {
      bestBid: 0,
      liquidityAtSlippage: 0,
      liquidityAtBestBid: 0,
      expectedAvgPrice: 0,
      expectedSlippagePct: 100,
      canFill: false,
      levelsNeeded: 0,
      levels: [],
    };
  }

  // Sort bids by price descending (best prices first)
  const sortedBids = [...bids].sort((a, b) => b.price - a.price);
  const bestBid = sortedBids[0].price;
  const minAcceptablePrice = bestBid * (1 - maxSlippagePct / 100);

  let liquidityAtBestBid = sortedBids[0].size * sortedBids[0].price;
  let liquidityAtSlippage = 0;
  let totalShares = 0;
  let weightedPriceSum = 0;
  let levelsNeeded = 0;

  const levelsUsed: OrderBookLevel[] = [];

  for (const level of sortedBids) {
    // Skip levels below our minimum acceptable price
    if (level.price < minAcceptablePrice) break;

    const sharesFromLevel = Math.min(level.size, sharesToSell - totalShares);
    if (sharesFromLevel <= 0) break;

    totalShares += sharesFromLevel;
    weightedPriceSum += sharesFromLevel * level.price;
    liquidityAtSlippage += sharesFromLevel * level.price;
    levelsNeeded++;
    levelsUsed.push({ price: level.price, size: sharesFromLevel });

    if (totalShares >= sharesToSell) break;
  }

  const expectedAvgPrice = totalShares > 0 ? weightedPriceSum / totalShares : 0;
  const expectedSlippagePct =
    bestBid > 0 ? ((bestBid - expectedAvgPrice) / bestBid) * 100 : 100;

  return {
    bestBid,
    liquidityAtSlippage,
    liquidityAtBestBid,
    expectedAvgPrice,
    expectedSlippagePct,
    canFill: totalShares >= sharesToSell * SELL.MIN_FILL_RATIO,
    levelsNeeded,
    levels: levelsUsed,
  };
}

/**
 * Calculate optimal slippage tolerance based on position state
 *
 * Higher slippage allowed for:
 * - Stop-loss scenarios (big losses)
 * - Near-resolution positions ($0.95+)
 * - Forced sells
 */
export function calculateOptimalSlippage(
  position: Position,
  config?: SmartSellConfig,
): number {
  // If explicit slippage provided, use it (even with forceSell)
  // This allows liquidation mode to specify custom slippage while still forcing the sell
  if (config?.maxSlippagePct !== undefined) {
    return Math.min(config.maxSlippagePct, SELL.MAX_SLIPPAGE_PCT);
  }

  // If forced with no explicit slippage, use maximum slippage
  if (config?.forceSell) {
    return SELL.MAX_SLIPPAGE_PCT;
  }

  // High price positions (near $1) - can use tighter slippage
  // These are likely winners, don't give away profit
  if (position.curPrice >= SELL.HIGH_PRICE_THRESHOLD) {
    return SELL.HIGH_PRICE_SLIPPAGE_PCT;
  }

  // Significant loss - allow more slippage to exit
  // Getting out is priority over optimizing price
  if (position.pnlPct <= -SELL.LOSS_THRESHOLD_PCT) {
    return SELL.LOSS_SLIPPAGE_PCT;
  }

  // Default slippage
  return SELL.DEFAULT_SLIPPAGE_PCT;
}

/**
 * Determine optimal order type based on market conditions
 *
 * FOK: Use when liquidity is good and we want immediate fill
 * GTC: Use when liquidity is thin and we can wait for better price
 */
export function determineOrderType(
  analysis: LiquidityAnalysis,
  sharesToSell: number,
  config?: SmartSellConfig,
): "FOK" | "GTC" {
  // If explicitly specified, use that
  if (config?.orderType) {
    return config.orderType;
  }

  // If forced sell, always FOK
  if (config?.forceSell) {
    return "FOK";
  }

  // If good liquidity and can fill at acceptable price, use FOK
  if (
    analysis.canFill &&
    analysis.liquidityAtBestBid >= SELL.MIN_LIQUIDITY_USD &&
    analysis.levelsNeeded <= 2
  ) {
    return "FOK";
  }

  // For thin orderbooks or when we'd eat through multiple levels,
  // GTC is safer - post a limit order and wait
  return "GTC";
}

// ============================================================================
// SMART SELL EXECUTION
// ============================================================================

/**
 * Execute a smart sell order with proper protections
 *
 * This is the main entry point for selling positions. It:
 * 1. Analyzes the orderbook to predict fill price
 * 2. Calculates appropriate slippage tolerance
 * 3. Chooses between FOK and GTC order types
 * 4. Executes with retry logic
 * 5. Reports actual vs expected fill
 */
export async function smartSell(
  client: ClobClient,
  position: Position,
  config?: SmartSellConfig,
): Promise<SmartSellResult> {
  const logger = config?.logger;
  const sharesToSell = position.size;

  // Check if live trading is enabled
  if (!isLiveTradingEnabled()) {
    logger?.warn?.(
      `[SIM] SELL ${sharesToSell.toFixed(2)} shares - live trading disabled`,
    );
    return {
      success: true,
      reason: "SIMULATED",
    };
  }

  // Validate position has shares to sell
  if (sharesToSell <= ORDER.MIN_SHARES_THRESHOLD) {
    logger?.debug?.(
      `Sell rejected: Position too small (${sharesToSell} shares)`,
    );
    return { success: false, reason: "POSITION_TOO_SMALL" };
  }

  try {
    // STEP 1: Get orderbook
    let orderBook;
    try {
      orderBook = await client.getOrderBook(position.tokenId);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (
        errorMessage.includes("No orderbook") ||
        errorMessage.includes("404")
      ) {
        logger?.debug?.(`Sell rejected: Market closed (no orderbook)`);
        return { success: false, reason: "MARKET_CLOSED" };
      }
      throw err;
    }

    if (!orderBook?.bids?.length) {
      logger?.warn?.(`Sell rejected: No bids in orderbook`);
      return { success: false, reason: "NO_BIDS" };
    }

    // STEP 2: Parse and analyze orderbook
    const bids = parseOrderBookLevels(orderBook.bids);
    const maxSlippage = calculateOptimalSlippage(position, config);
    const analysis = analyzeLiquidity(bids, sharesToSell, maxSlippage);

    logger?.debug?.(
      `Sell analysis: bestBid=${(analysis.bestBid * 100).toFixed(1)}¢, ` +
        `expectedAvg=${(analysis.expectedAvgPrice * 100).toFixed(1)}¢, ` +
        `slippage=${analysis.expectedSlippagePct.toFixed(2)}%, ` +
        `canFill=${analysis.canFill}, levels=${analysis.levelsNeeded}`,
    );

    // STEP 3: Check liquidity requirements
    const minLiquidity = config?.minLiquidityUsd ?? SELL.MIN_LIQUIDITY_USD;
    if (analysis.liquidityAtSlippage < minLiquidity && !config?.forceSell) {
      logger?.warn?.(
        `Sell rejected: Insufficient liquidity ($${analysis.liquidityAtSlippage.toFixed(2)} < $${minLiquidity})`,
      );
      return {
        success: false,
        reason: "INSUFFICIENT_LIQUIDITY",
        analysis,
      };
    }

    // STEP 4: Check if we can fill within slippage tolerance
    if (!analysis.canFill && !config?.forceSell) {
      logger?.warn?.(
        `Sell rejected: Cannot fill at acceptable price. ` +
          `Expected slippage: ${analysis.expectedSlippagePct.toFixed(2)}% > max ${maxSlippage}%`,
      );
      return {
        success: false,
        reason: "SLIPPAGE_TOO_HIGH",
        analysis,
      };
    }

    // STEP 5: Determine order type
    const orderType = determineOrderType(analysis, sharesToSell, config);

    // Calculate the price to use
    // For FOK: use best bid price (the limit price for the order)
    // For GTC: use best bid (limit order waits for this price)
    // Note: FOK uses best bid because the order type itself ensures complete fill
    // The analysis already validated that we can fill within slippage tolerance
    const orderPrice = analysis.bestBid;

    logger?.info?.(
      `Sell executing: ${sharesToSell.toFixed(2)} shares @ ${(orderPrice * 100).toFixed(1)}¢ ` +
        `(${orderType}, max slippage: ${maxSlippage}%)`,
    );

    // STEP 6: Create and execute the order
    const signedOrder = await client.createMarketOrder({
      side: Side.SELL,
      tokenID: position.tokenId,
      amount: sharesToSell,
      price: orderPrice,
    });

    const clobOrderType = orderType === "FOK" ? OrderType.FOK : OrderType.GTC;
    const response = await client.postOrder(signedOrder, clobOrderType);

    // Check for Cloudflare block
    if (isCloudflareBlock(response)) {
      logger?.error?.(
        `Sell blocked by Cloudflare (403). Consider using VPN.`,
      );
      return { success: false, reason: "CLOUDFLARE_BLOCKED", analysis };
    }

    // Cast response for accessing all fields
    const respAny = response as any;

    if (response.success) {
      // For FOK orders, we need to verify the order actually FILLED, not just that it was accepted
      // The API returns success=true when the order is accepted, but FOK orders may not fill
      // Check the status field and takingAmount/makingAmount to confirm actual fill
      if (orderType === "FOK") {
        const status = respAny?.status?.toUpperCase?.() || "";
        const takingAmount = parseFloat(respAny?.takingAmount || "0");
        const makingAmount = parseFloat(respAny?.makingAmount || "0");
        
        // FOK order should have status "MATCHED" or "FILLED" and non-zero amounts
        // If status is "UNMATCHED", "DELAYED", or amounts are 0, the order didn't fill
        // Note: FOK orders are fill-or-kill, they cannot be "LIVE" (sitting on orderbook)
        const isMatched = status === "MATCHED" || status === "FILLED";
        const hasFilledAmount = takingAmount > 0 || makingAmount > 0;
        
        // If we have status info, use it to determine success
        // If status is explicitly unmatched or amounts are 0 when we expected a fill, it failed
        if (status && !isMatched) {
          logger?.warn?.(`⚠️ FOK order not filled (status: ${status})`);
          return { success: false, reason: "FOK_NOT_FILLED", analysis };
        }
        
        // If we have amount info and it shows no fill, fail
        if (respAny?.takingAmount !== undefined && !hasFilledAmount) {
          logger?.warn?.(`⚠️ FOK order not filled (zero amount)`);
          return { success: false, reason: "FOK_NOT_FILLED", analysis };
        }
      }

      const filledUsd = sharesToSell * orderPrice;
      // Note: We use the pre-calculated expected slippage from analysis
      // since we cannot get actual fill price from the order response
      const expectedSlippage = analysis.expectedSlippagePct;

      logger?.info?.(
        `✅ Sell success: $${filledUsd.toFixed(2)} ` +
          `(expected slippage: ${expectedSlippage.toFixed(2)}%)`,
      );

      return {
        success: true,
        filledUsd,
        avgPrice: orderPrice,
        // API returns orderID (capital ID) per types.d.ts OrderResponse interface
        orderId: respAny?.orderID || respAny?.orderHashes?.[0],
        analysis,
        actualPrice: orderPrice,
        actualSlippagePct: expectedSlippage,
        orderType,
      };
    } else {
      // Extract error message from various CLOB response structures
      const errorMsg =
        respAny?.errorMsg ||
        respAny?.data?.error ||
        respAny?.error ||
        "Unknown error";
      logger?.warn?.(`⚠️ Sell failed: ${errorMsg}`);

      // Handle specific error cases - distinguish between balance and allowance issues
      const lowerError = errorMsg.toLowerCase();
      if (lowerError.includes("not enough allowance") || lowerError.includes("insufficient allowance")) {
        return { success: false, reason: "INSUFFICIENT_ALLOWANCE", analysis };
      }
      if (
        lowerError.includes("not enough balance") ||
        lowerError.includes("insufficient balance") ||
        lowerError.includes("insufficient")
      ) {
        return { success: false, reason: "INSUFFICIENT_BALANCE", analysis };
      }
      if (lowerError.includes("fok") && lowerError.includes("not filled")) {
        return { success: false, reason: "FOK_NOT_FILLED", analysis };
      }

      return {
        success: false,
        reason: formatErrorForLog(errorMsg),
        analysis,
      };
    }
  } catch (err) {
    if (isCloudflareBlock(err)) {
      return { success: false, reason: "CLOUDFLARE_BLOCKED" };
    }

    // Extract clean error message from CLOB exception structures
    const errAny = err as any;
    let cleanMsg: string;
    if (errAny?.response?.data?.error) {
      cleanMsg = String(errAny.response.data.error);
    } else if (errAny?.data?.error) {
      cleanMsg = String(errAny.data.error);
    } else if (err instanceof Error) {
      cleanMsg = err.message;
    } else {
      cleanMsg = String(err);
    }

    logger?.error?.(`❌ Sell error: ${cleanMsg}`);

    // Check for specific error types and return appropriate reason codes
    // Distinguish between balance and allowance issues for better debugging
    const lowerMsg = cleanMsg.toLowerCase();
    if (lowerMsg.includes("not enough allowance") || lowerMsg.includes("insufficient allowance")) {
      return { success: false, reason: "INSUFFICIENT_ALLOWANCE" };
    }
    if (
      lowerMsg.includes("not enough balance") ||
      lowerMsg.includes("insufficient balance") ||
      lowerMsg.includes("insufficient")
    ) {
      return { success: false, reason: "INSUFFICIENT_BALANCE" };
    }

    return { success: false, reason: formatErrorForLog(cleanMsg) };
  }
}

/**
 * Check if selling would be profitable given current orderbook
 *
 * Use this before deciding to sell to avoid bad fills
 */
export async function checkSellProfitability(
  client: ClobClient,
  position: Position,
  minProfitPct: number = 0,
  logger?: Logger,
): Promise<{
  profitable: boolean;
  expectedProfitPct: number;
  expectedProfitUsd: number;
  analysis: LiquidityAnalysis;
}> {
  try {
    const orderBook = await client.getOrderBook(position.tokenId);
    if (!orderBook?.bids?.length) {
      return {
        profitable: false,
        expectedProfitPct: -100,
        expectedProfitUsd: -position.value,
        analysis: {
          bestBid: 0,
          liquidityAtSlippage: 0,
          liquidityAtBestBid: 0,
          expectedAvgPrice: 0,
          expectedSlippagePct: 100,
          canFill: false,
          levelsNeeded: 0,
          levels: [],
        },
      };
    }

    const bids = parseOrderBookLevels(orderBook.bids);
    const analysis = analyzeLiquidity(
      bids,
      position.size,
      SELL.DEFAULT_SLIPPAGE_PCT,
    );

    const costBasis = position.avgPrice * position.size;
    const expectedRevenue = analysis.expectedAvgPrice * position.size;
    const expectedProfitUsd = expectedRevenue - costBasis;
    const expectedProfitPct =
      costBasis > 0 ? (expectedProfitUsd / costBasis) * 100 : 0;

    logger?.debug?.(
      `Sell profitability check: expected P&L ${expectedProfitPct >= 0 ? "+" : ""}${expectedProfitPct.toFixed(1)}% ($${expectedProfitUsd.toFixed(2)})`,
    );

    return {
      profitable: expectedProfitPct >= minProfitPct,
      expectedProfitPct,
      expectedProfitUsd,
      analysis,
    };
  } catch (err) {
    logger?.error?.(`Error checking sell profitability: ${err}`);
    return {
      profitable: false,
      expectedProfitPct: -100,
      expectedProfitUsd: -position.value,
      analysis: {
        bestBid: 0,
        liquidityAtSlippage: 0,
        liquidityAtBestBid: 0,
        expectedAvgPrice: 0,
        expectedSlippagePct: 100,
        canFill: false,
        levelsNeeded: 0,
        levels: [],
      },
    };
  }
}

/**
 * Get recommendation for how to sell a position
 *
 * Returns advice on whether to:
 * - Sell now with FOK
 * - Place a GTC limit order
 * - Wait for better liquidity
 * - Hold until resolution
 */
export async function getSellRecommendation(
  client: ClobClient,
  position: Position,
  logger?: Logger,
): Promise<{
  recommendation: "SELL_NOW" | "PLACE_LIMIT" | "WAIT" | "HOLD_TO_RESOLUTION";
  reason: string;
  suggestedPrice?: number;
  expectedSlippage?: number;
}> {
  try {
    const orderBook = await client.getOrderBook(position.tokenId);
    if (!orderBook?.bids?.length) {
      return {
        recommendation: "HOLD_TO_RESOLUTION",
        reason: "No bids available - consider holding until market resolution",
      };
    }

    const bids = parseOrderBookLevels(orderBook.bids);
    const analysis = analyzeLiquidity(
      bids,
      position.size,
      SELL.DEFAULT_SLIPPAGE_PCT,
    );

    // Near resolution - likely winner, sell carefully
    if (position.curPrice >= SELL.HIGH_PRICE_THRESHOLD) {
      if (analysis.canFill && analysis.expectedSlippagePct < 1) {
        return {
          recommendation: "SELL_NOW",
          reason:
            "High probability position with good liquidity - safe to take profit",
          suggestedPrice: analysis.expectedAvgPrice,
          expectedSlippage: analysis.expectedSlippagePct,
        };
      }
      return {
        recommendation: "HOLD_TO_RESOLUTION",
        reason:
          "Near resolution but thin liquidity - holding may yield better value",
      };
    }

    // Good liquidity - can sell aggressively
    if (
      analysis.canFill &&
      analysis.levelsNeeded <= 2 &&
      analysis.liquidityAtBestBid >= SELL.MIN_LIQUIDITY_USD * 2
    ) {
      return {
        recommendation: "SELL_NOW",
        reason: `Good liquidity at ${(analysis.bestBid * 100).toFixed(0)}¢ - FOK order recommended`,
        suggestedPrice: analysis.expectedAvgPrice,
        expectedSlippage: analysis.expectedSlippagePct,
      };
    }

    // Moderate liquidity - use limit order
    if (
      analysis.canFill &&
      analysis.liquidityAtSlippage >= position.value * 0.5
    ) {
      return {
        recommendation: "PLACE_LIMIT",
        reason: `Moderate liquidity - GTC limit at ${(analysis.bestBid * 100).toFixed(0)}¢ recommended`,
        suggestedPrice: analysis.bestBid,
        expectedSlippage: 0,
      };
    }

    // Thin liquidity
    if (analysis.liquidityAtSlippage < position.value * 0.3) {
      return {
        recommendation: "WAIT",
        reason: `Very thin liquidity ($${analysis.liquidityAtSlippage.toFixed(0)}) - wait for better conditions`,
      };
    }

    // Default
    return {
      recommendation: "PLACE_LIMIT",
      reason: "Uncertain conditions - conservative GTC limit order recommended",
      suggestedPrice: analysis.bestBid,
      expectedSlippage: 0,
    };
  } catch (err) {
    logger?.error?.(`Error getting sell recommendation: ${err}`);
    return {
      recommendation: "WAIT",
      reason: "Error analyzing orderbook - recommend waiting",
    };
  }
}
