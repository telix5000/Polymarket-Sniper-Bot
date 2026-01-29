/**
 * Order Execution Module
 *
 * Provides a shared, robust order execution path for both whale entries and scan entries.
 * This module consolidates the order placement logic with proper fallback handling.
 *
 * Key features:
 * - Single shared execution path for all entry types (whale/scan)
 * - Structured FOK → GTC fallback with book-respecting pricing
 * - Comprehensive rejection diagnostics
 * - Tick size handling with dynamic lookup
 * - Pre-placement invariant enforcement
 */

import type { ClobClient } from "@polymarket/clob-client";
import { Side, OrderType } from "@polymarket/clob-client";
import {
  computeExecutionLimitPrice,
  isBookHealthyForExecution,
  getTickSizeForToken,
  roundToTick,
  assertValidLimitPrice,
  toApiPriceUnits,
  classifyRejectionReason,
  logOrderRejection,
  HARD_MIN_PRICE,
  HARD_MAX_PRICE,
  STRATEGY_MIN_PRICE,
  STRATEGY_MAX_PRICE,
  type ComputeExecutionPriceResult,
  type OrderRejectionDiagnostic,
} from "./price-safety";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Input for order placement with fallback
 */
export interface PlaceOrderInput {
  /** CLOB client instance */
  client: ClobClient;
  /** Token ID to trade */
  tokenId: string;
  /** Market ID (optional, for logging) */
  marketId?: string;
  /** Order side */
  side: "BUY" | "SELL";
  /** Order size in USD */
  sizeUsd: number;
  /** Best bid price (0-1 scale) */
  bestBid: number;
  /** Best ask price (0-1 scale) */
  bestAsk: number;
  /** Slippage as fraction (e.g., 0.06 for 6%) */
  slippageFrac: number;
  /** Strategy maximum price (default: STRATEGY_MAX_PRICE) */
  strategyMaxPrice?: number;
  /** Strategy minimum price (default: STRATEGY_MIN_PRICE) */
  strategyMinPrice?: number;
  /** Tick size (optional - will be fetched if not provided) */
  tickSize?: number;
  /** Whether to use GTC fallback if FOK fails (default: true) */
  useGtcFallback?: boolean;
  /** Reduced slippage fraction for GTC fallback (default: slippageFrac * 0.5) */
  gtcSlippageFrac?: number;
}

/**
 * Result of order placement
 */
export interface PlaceOrderResult {
  /** Whether the order was successfully placed/filled */
  success: boolean;
  /** Order ID (for GTC orders that are posted but not filled) */
  orderId?: string;
  /** Filled amount in USD (0 for pending GTC) */
  filledUsd: number;
  /** Execution price in cents */
  filledPriceCents: number;
  /** Whether this is a pending GTC order (not yet filled) */
  isPending?: boolean;
  /** Reason for failure (if success=false) */
  reason?: string;
  /** Order type used */
  orderType: "FOK" | "GTC";
  /** Diagnostic info for rejections */
  diagnostic?: OrderRejectionDiagnostic;
}

/**
 * Orderbook snapshot for execution validation
 */
export interface ExecutionOrderbook {
  bestBid: number;
  bestAsk: number;
  bidDepthUsd?: number;
  askDepthUsd?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// PRE-PLACEMENT VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate orderbook and price conditions before placing an order.
 * 
 * Enforces invariants:
 * - Book is healthy (not EMPTY/DUST/DEAD/CROSSED)
 * - BUY: limitPrice >= bestAsk (after rounding + must-not-cross)
 * - SELL: limitPrice <= bestBid (after rounding + must-not-cross)
 * - Price is within both HARD and strategy bounds
 * 
 * @param input - Validation input
 * @returns Validation result with computed limit price if valid
 */
export function validateBeforePlacement(input: {
  bestBid: number;
  bestAsk: number;
  side: "BUY" | "SELL";
  limitPrice: number;
  tickSize: number;
  strategyMaxPrice?: number;
  strategyMinPrice?: number;
  maxSpreadCents?: number;
}): { valid: boolean; reason?: string } {
  const {
    bestBid,
    bestAsk,
    side,
    limitPrice,
    tickSize,
    strategyMaxPrice = STRATEGY_MAX_PRICE,
    strategyMinPrice = STRATEGY_MIN_PRICE,
    maxSpreadCents = 50,
  } = input;

  // Check book health
  const healthCheck = isBookHealthyForExecution(bestBid, bestAsk);
  if (!healthCheck.healthy) {
    return { valid: false, reason: `UNHEALTHY_BOOK_${healthCheck.reason}` };
  }

  // Check spread
  const spreadCents = (bestAsk - bestBid) * 100;
  if (spreadCents > maxSpreadCents) {
    return { valid: false, reason: `SPREAD_TOO_WIDE_${spreadCents.toFixed(0)}c` };
  }

  // Check strategy bounds
  if (side === "BUY" && bestAsk > strategyMaxPrice) {
    return { valid: false, reason: `ASK_ABOVE_STRATEGY_MAX` };
  }
  if (side === "SELL" && bestBid < strategyMinPrice) {
    return { valid: false, reason: `BID_BELOW_STRATEGY_MIN` };
  }

  // Check HARD bounds
  if (limitPrice < HARD_MIN_PRICE || limitPrice > HARD_MAX_PRICE) {
    return { valid: false, reason: `LIMIT_OUTSIDE_HARD_BOUNDS` };
  }

  // Check must-not-cross invariant
  // Round the limit price to tick first using directional rounding
  const roundedLimit = roundToTick(limitPrice, tickSize, side);

  if (side === "BUY" && roundedLimit < bestAsk) {
    // This shouldn't happen if computeExecutionLimitPrice was used correctly
    // but double-check as a safety invariant
    console.warn(
      `⚠️ [VALIDATE] BUY limit ${roundedLimit.toFixed(4)} < bestAsk ${bestAsk.toFixed(4)} - would not fill`,
    );
    // We allow this but warn - the order simply won't fill immediately
  }

  if (side === "SELL" && roundedLimit > bestBid) {
    console.warn(
      `⚠️ [VALIDATE] SELL limit ${roundedLimit.toFixed(4)} > bestBid ${bestBid.toFixed(4)} - would not fill`,
    );
    // We allow this but warn - the order simply won't fill immediately
  }

  return { valid: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED ORDER PLACEMENT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Place an order with structured fallback.
 *
 * This is the SINGLE shared entry point for order execution. Both whale entries
 * and scan entries should use this function.
 *
 * Execution flow:
 * 1. Compute execution limit price using computeExecutionLimitPrice()
 * 2. Validate pre-placement invariants
 * 3. Try FOK (Fill-Or-Kill) at computed limit
 * 4. If FOK fails and useGtcFallback=true:
 *    - Compute GTC price with book-respecting logic
 *    - Place GTC limit order
 * 5. Return result with comprehensive diagnostics on rejection
 *
 * @param input - Order placement input
 * @returns Order placement result
 */
export async function placeOrderWithFallback(
  input: PlaceOrderInput,
): Promise<PlaceOrderResult> {
  const {
    client,
    tokenId,
    marketId,
    side,
    sizeUsd,
    bestBid,
    bestAsk,
    slippageFrac,
    strategyMaxPrice = STRATEGY_MAX_PRICE,
    strategyMinPrice = STRATEGY_MIN_PRICE,
    useGtcFallback = true,
    gtcSlippageFrac = slippageFrac * 0.5,
  } = input;

  // Get tick size
  const { tickSize, isDefault: tickSizeIsDefault } = getTickSizeForToken(
    tokenId,
    input.tickSize,
  );

  // Step 1: Compute FOK limit price
  const fokPriceResult = computeExecutionLimitPrice({
    bestBid,
    bestAsk,
    side,
    slippageFrac,
    tokenIdPrefix: tokenId.slice(0, 12),
    tickSize,
  });

  if (!fokPriceResult.success) {
    return {
      success: false,
      filledUsd: 0,
      filledPriceCents: 0,
      reason: `PRICE_COMPUTE_FAIL_${fokPriceResult.rejectionReason}`,
      orderType: "FOK",
    };
  }

  const fokPrice = fokPriceResult.limitPrice;
  const basePrice = fokPriceResult.basePrice;

  // Step 2: Validate pre-placement invariants
  const validation = validateBeforePlacement({
    bestBid,
    bestAsk,
    side,
    limitPrice: fokPrice,
    tickSize,
    strategyMaxPrice,
    strategyMinPrice,
  });

  if (!validation.valid) {
    return {
      success: false,
      filledUsd: 0,
      filledPriceCents: 0,
      reason: validation.reason,
      orderType: "FOK",
    };
  }

  // Step 3: Assert price is valid before API call
  try {
    assertValidLimitPrice(fokPrice, side, `FOK ${tokenId.slice(0, 12)}`);
    toApiPriceUnits(fokPrice); // Validates range
  } catch (err) {
    return {
      success: false,
      filledUsd: 0,
      filledPriceCents: 0,
      reason: err instanceof Error ? err.message : "INVALID_PRICE",
      orderType: "FOK",
    };
  }

  // Calculate shares
  const shares = sizeUsd / fokPrice;

  // Step 4: Try FOK order
  try {
    const fokOrder = await client.createMarketOrder({
      side: side === "BUY" ? Side.BUY : Side.SELL,
      tokenID: tokenId,
      amount: shares,
      price: fokPrice,
    });

    const fokResponse = await client.postOrder(fokOrder, OrderType.FOK);

    if (fokResponse.success) {
      console.log(
        `📥 FOK ${side} $${sizeUsd.toFixed(2)} @ ${(basePrice * 100).toFixed(1)}¢ ` +
        `(limit=${(fokPrice * 100).toFixed(2)}¢, tick=${tickSize})`,
      );
      return {
        success: true,
        filledUsd: sizeUsd,
        filledPriceCents: basePrice * 100,
        orderType: "FOK",
      };
    }

    // FOK failed - log diagnostic
    const fokErrorMsg = fokResponse.errorMsg || "Unknown FOK error";
    console.log(`⏳ FOK missed: ${fokErrorMsg}, trying GTC fallback...`);

    // Step 5: Try GTC fallback if enabled
    if (!useGtcFallback) {
      const diagnostic = createRejectionDiagnostic({
        tokenId,
        marketId,
        side,
        sizeUsd,
        shares,
        bestBid,
        bestAsk,
        tickSize,
        tickSizeIsDefault,
        limitPrice: fokPrice,
        orderType: "FOK",
        errorMessage: fokErrorMsg,
      });
      logOrderRejection(diagnostic);

      return {
        success: false,
        filledUsd: 0,
        filledPriceCents: 0,
        reason: "FOK_REJECTED",
        orderType: "FOK",
        diagnostic,
      };
    }

    // Compute GTC price with book-respecting logic
    const gtcPrice = computeGtcFallbackPrice({
      side,
      bestBid,
      bestAsk,
      fokLimitPrice: fokPrice,
      slippageFrac: gtcSlippageFrac,
      strategyMaxPrice,
      strategyMinPrice,
      tickSize,
    });

    if (gtcPrice === null) {
      // Market moved outside strategy bounds - don't place GTC
      const diagnostic = createRejectionDiagnostic({
        tokenId,
        marketId,
        side,
        sizeUsd,
        shares,
        bestBid,
        bestAsk,
        tickSize,
        tickSizeIsDefault,
        limitPrice: fokPrice,
        orderType: "FOK",
        errorMessage: `FOK rejected and GTC skipped (market outside strategy bounds)`,
      });
      logOrderRejection(diagnostic);

      return {
        success: false,
        filledUsd: 0,
        filledPriceCents: 0,
        reason: "MARKET_MOVED_OUTSIDE_BOUNDS",
        orderType: "FOK",
        diagnostic,
      };
    }

    // Place GTC order
    // Recalculate shares for GTC price to maintain consistent USD value
    const gtcShares = sizeUsd / gtcPrice;
    try {
      const gtcOrder = await client.createOrder({
        side: side === "BUY" ? Side.BUY : Side.SELL,
        tokenID: tokenId,
        size: gtcShares,
        price: gtcPrice,
      });

      const gtcResponse = await client.postOrder(gtcOrder, OrderType.GTC);

      if (gtcResponse.success) {
        const orderId = (gtcResponse as any).orderId || (gtcResponse as any).orderHashes?.[0];
        console.log(
          `📋 GTC ${side} posted @ ${(gtcPrice * 100).toFixed(1)}¢ ` +
          `(orderId=${orderId?.slice(0, 12) || "unknown"}...)`,
        );
        return {
          success: true,
          orderId,
          filledUsd: 0, // Not filled yet
          filledPriceCents: gtcPrice * 100,
          isPending: true,
          orderType: "GTC",
        };
      }

      // GTC also failed
      const gtcErrorMsg = gtcResponse.errorMsg || "Unknown GTC error";
      const diagnostic = createRejectionDiagnostic({
        tokenId,
        marketId,
        side,
        sizeUsd,
        shares,
        bestBid,
        bestAsk,
        tickSize,
        tickSizeIsDefault,
        limitPrice: gtcPrice,
        orderType: "GTC",
        errorMessage: `FOK: ${fokErrorMsg} | GTC: ${gtcErrorMsg}`,
      });
      logOrderRejection(diagnostic);

      return {
        success: false,
        filledUsd: 0,
        filledPriceCents: 0,
        reason: "FOK_AND_GTC_REJECTED",
        orderType: "GTC",
        diagnostic,
      };
    } catch (gtcErr) {
      const gtcErrorMsg = gtcErr instanceof Error ? gtcErr.message : String(gtcErr);
      console.warn(`⚠️ GTC fallback error: ${gtcErrorMsg}`);

      const diagnostic = createRejectionDiagnostic({
        tokenId,
        marketId,
        side,
        sizeUsd,
        shares,
        bestBid,
        bestAsk,
        tickSize,
        tickSizeIsDefault,
        limitPrice: fokPrice,
        orderType: "GTC",
        errorMessage: `FOK: ${fokErrorMsg} | GTC error: ${gtcErrorMsg}`,
      });
      logOrderRejection(diagnostic);

      return {
        success: false,
        filledUsd: 0,
        filledPriceCents: 0,
        reason: `GTC_ERROR: ${gtcErrorMsg}`,
        orderType: "GTC",
        diagnostic,
      };
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    
    const diagnostic = createRejectionDiagnostic({
      tokenId,
      marketId,
      side,
      sizeUsd,
      shares,
      bestBid,
      bestAsk,
      tickSize,
      tickSizeIsDefault,
      limitPrice: fokPrice,
      orderType: "FOK",
      errorMessage: errorMsg,
    });
    logOrderRejection(diagnostic);

    return {
      success: false,
      filledUsd: 0,
      filledPriceCents: 0,
      reason: errorMsg,
      orderType: "FOK",
      diagnostic,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute GTC fallback price with book-respecting logic.
 *
 * For GTC orders after FOK fails:
 * - BUY: price = min(strategyMax, max(bestAsk, limitPrice))
 * - SELL: price = max(strategyMin, min(bestBid, limitPrice))
 *
 * Then apply HARD clamp, tick rounding, and must-not-cross.
 *
 * Note: slippageFrac is reserved for future use (e.g., applying additional
 * slippage to GTC price based on market conditions).
 *
 * @returns GTC price, or null if market moved outside strategy bounds
 */
function computeGtcFallbackPrice(input: {
  side: "BUY" | "SELL";
  bestBid: number;
  bestAsk: number;
  fokLimitPrice: number;
  /** Reserved for future use - currently GTC uses book-respecting pricing */
  slippageFrac: number;
  strategyMaxPrice: number;
  strategyMinPrice: number;
  tickSize: number;
}): number | null {
  const {
    side,
    bestBid,
    bestAsk,
    fokLimitPrice,
    // slippageFrac reserved for future use
    strategyMaxPrice,
    strategyMinPrice,
    tickSize,
  } = input;

  // Check if market moved outside strategy bounds - don't place GTC if so
  if (side === "BUY" && bestAsk > strategyMaxPrice) {
    console.log(
      `⚠️ [GTC] Skip: bestAsk ${(bestAsk * 100).toFixed(1)}¢ > strategyMax ${(strategyMaxPrice * 100).toFixed(1)}¢`,
    );
    return null;
  }
  if (side === "SELL" && bestBid < strategyMinPrice) {
    console.log(
      `⚠️ [GTC] Skip: bestBid ${(bestBid * 100).toFixed(1)}¢ < strategyMin ${(strategyMinPrice * 100).toFixed(1)}¢`,
    );
    return null;
  }

  // Compute base GTC price
  let gtcPrice: number;

  if (side === "BUY") {
    // BUY: price = min(strategyMax, max(bestAsk, limitPrice))
    gtcPrice = Math.min(strategyMaxPrice, Math.max(bestAsk, fokLimitPrice));
  } else {
    // SELL: price = max(strategyMin, min(bestBid, limitPrice))
    gtcPrice = Math.max(strategyMinPrice, Math.min(bestBid, fokLimitPrice));
  }

  // Apply HARD clamp
  gtcPrice = Math.max(HARD_MIN_PRICE, Math.min(HARD_MAX_PRICE, gtcPrice));

  // Round to tick with directional rounding
  // BUY: ceiling, SELL: floor
  gtcPrice = roundToTick(gtcPrice, tickSize, side);

  // Apply must-not-cross rule after rounding
  if (side === "BUY" && gtcPrice < bestAsk) {
    // Bump up to next tick at/above ask using epsilon-adjusted rounding
    gtcPrice = roundToTick(bestAsk, tickSize, "BUY");
    gtcPrice = Math.min(gtcPrice, HARD_MAX_PRICE);
  } else if (side === "SELL" && gtcPrice > bestBid) {
    // Bump down to next tick at/below bid using epsilon-adjusted rounding
    gtcPrice = roundToTick(bestBid, tickSize, "SELL");
    gtcPrice = Math.max(gtcPrice, HARD_MIN_PRICE);
  }

  return gtcPrice;
}

/**
 * Create rejection diagnostic object for logging
 */
function createRejectionDiagnostic(input: {
  tokenId: string;
  marketId?: string;
  side: "BUY" | "SELL";
  sizeUsd?: number;
  shares?: number;
  bestBid?: number;
  bestAsk?: number;
  tickSize: number;
  tickSizeIsDefault: boolean;
  limitPrice: number;
  orderType: "FOK" | "GTC" | "FAK" | "GTD";
  postOnly?: boolean;
  errorMessage: string;
}): OrderRejectionDiagnostic {
  return {
    tokenId: input.tokenId,
    marketId: input.marketId,
    side: input.side,
    sizeUsd: input.sizeUsd,
    shares: input.shares,
    bestBid: input.bestBid,
    bestAsk: input.bestAsk,
    tickSize: input.tickSize,
    tickSizeIsDefault: input.tickSizeIsDefault,
    finalLimitPriceDollars: input.limitPrice,
    finalLimitPriceApiUnits: input.limitPrice, // Same for Polymarket
    orderType: input.orderType,
    postOnly: input.postOnly,
    errorCode: undefined,
    errorMessage: input.errorMessage,
    rejectionClass: classifyRejectionReason(input.errorMessage),
    timestamp: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS FOR TESTING
// ═══════════════════════════════════════════════════════════════════════════

export {
  computeGtcFallbackPrice as _computeGtcFallbackPrice,
  createRejectionDiagnostic as _createRejectionDiagnostic,
};
