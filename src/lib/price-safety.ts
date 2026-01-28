/**
 * Price Safety Module
 *
 * Ensures price formation is safe and cannot result in invalid prices.
 * In prediction markets, prices must be in (0, 1) range, typically clamped to [0.01, 0.99].
 *
 * Key safety features:
 * - Clamps all limit prices to safe bounds [MIN_PRICE, MAX_PRICE]
 * - Detects spread-too-wide conditions (illiquid markets)
 * - Validates orderbook sanity
 * - Logs price formation decisions for diagnostics
 */

import { isGitHubActions, ghWarning, ghError } from "./diag-mode";

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** Minimum valid price in prediction markets (1¢) */
export const MIN_PRICE = 0.01;

/** Maximum valid price in prediction markets (99¢) */
export const MAX_PRICE = 0.99;

/** Default maximum acceptable spread in cents for liquid markets */
export const DEFAULT_MAX_SPREAD_CENTS = 50;

/** Minimum depth (in USD) at best bid/ask to consider liquid */
export const DEFAULT_MIN_DEPTH_USD = 10;

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Price formation result including safety metadata
 */
export interface PriceFormationResult {
  /** The computed limit price (already clamped) */
  limitPrice: number;
  /** Original price before clamping */
  rawPrice: number;
  /** Whether the price was clamped to fit bounds */
  wasClamped: boolean;
  /** Clamp direction: "min", "max", or null if not clamped */
  clampDirection: "min" | "max" | null;
  /** Rejection reason if price formation failed */
  rejectionReason?: PriceRejectionReason;
  /** Diagnostic detail object (safe for logging, no secrets) */
  diagnostics: PriceFormationDiagnostics;
}

/**
 * Reasons for rejecting a price
 */
export type PriceRejectionReason =
  | "SPREAD_TOO_WIDE"
  | "PRICE_CLAMPED_TO_MAX"
  | "PRICE_CLAMPED_TO_MIN"
  | "PRICE_OUT_OF_RANGE"
  | "INVALID_ORDERBOOK"
  | "NO_LIQUIDITY"
  | "DEPTH_TOO_LOW";

/**
 * Diagnostic info for price formation (safe for logging)
 */
export interface PriceFormationDiagnostics {
  signalPrice?: number;
  bestBid: number;
  bestAsk: number;
  spreadCents: number;
  rawLimitPrice: number;
  clampedLimitPrice: number;
  slippagePct: number;
  side: "BUY" | "SELL";
  method: "slippage" | "signal" | "best_price";
}

/**
 * Orderbook state for price calculations (price-safety specific)
 */
export interface PriceOrderbookSnapshot {
  bestBid: number;
  bestAsk: number;
  bidDepthUsd?: number;
  askDepthUsd?: number;
}

/**
 * Price formation configuration
 */
export interface PriceFormationConfig {
  /** Slippage percentage (0-100) */
  slippagePct: number;
  /** Order side: BUY or SELL */
  side: "BUY" | "SELL";
  /** Optional signal price from whale trade */
  signalPrice?: number;
  /** Minimum allowed price */
  minPrice?: number;
  /** Maximum allowed price */
  maxPrice?: number;
  /** Maximum acceptable spread in cents */
  maxSpreadCents?: number;
  /** Minimum depth (USD) required at best bid/ask */
  minDepthUsd?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Clamp a price to the valid [MIN_PRICE, MAX_PRICE] range.
 *
 * @param price - The price to clamp
 * @param minPrice - Optional minimum price override (default: MIN_PRICE)
 * @param maxPrice - Optional maximum price override (default: MAX_PRICE)
 * @returns Clamped price value
 */
export function clampPrice(
  price: number,
  minPrice: number = MIN_PRICE,
  maxPrice: number = MAX_PRICE,
): number {
  return Math.max(minPrice, Math.min(maxPrice, price));
}

/**
 * Check if an orderbook represents a liquid market.
 *
 * @param orderbook - Orderbook snapshot
 * @param maxSpreadCents - Maximum acceptable spread in cents (default: 50)
 * @param minDepthUsd - Minimum required depth in USD (default: 10)
 * @returns true if the orderbook is liquid enough for trading
 */
export function isLiquidOrderbook(
  orderbook: PriceOrderbookSnapshot,
  maxSpreadCents: number = DEFAULT_MAX_SPREAD_CENTS,
  minDepthUsd: number = DEFAULT_MIN_DEPTH_USD,
): boolean {
  // Check for valid prices
  if (
    !orderbook.bestBid ||
    !orderbook.bestAsk ||
    orderbook.bestBid <= 0 ||
    orderbook.bestAsk <= 0
  ) {
    return false;
  }

  // Check spread
  const spreadCents = (orderbook.bestAsk - orderbook.bestBid) * 100;
  if (spreadCents > maxSpreadCents) {
    return false;
  }

  // Check depth if provided
  if (orderbook.bidDepthUsd !== undefined && orderbook.bidDepthUsd < minDepthUsd) {
    return false;
  }
  if (orderbook.askDepthUsd !== undefined && orderbook.askDepthUsd < minDepthUsd) {
    return false;
  }

  return true;
}

/**
 * Check for dust book (bid near 0, ask near 100) which indicates an illiquid/closed market.
 *
 * @param orderbook - Orderbook snapshot
 * @returns true if this appears to be a dust book
 */
export function isDustBook(orderbook: PriceOrderbookSnapshot): boolean {
  const bidCents = orderbook.bestBid * 100;
  const askCents = orderbook.bestAsk * 100;

  // Dust book: bid <= 2¢ AND ask >= 98¢
  return bidCents <= 2 && askCents >= 98;
}

/**
 * Calculate a safe limit price for an order with slippage tolerance.
 * ALWAYS clamps the result to [MIN_PRICE, MAX_PRICE] to prevent overpaying.
 *
 * Policy:
 * - For BUY: limitPrice = min(bestAsk * (1 + slippage), MAX_PRICE)
 * - For SELL: limitPrice = max(bestBid * (1 - slippage), MIN_PRICE)
 *
 * If signalPrice is provided:
 * - For BUY: limitPrice = min(signalPrice * (1 + slippage), bestAsk, MAX_PRICE)
 * - For SELL: limitPrice = max(signalPrice * (1 - slippage), bestBid, MIN_PRICE)
 *
 * @param orderbook - Current orderbook snapshot
 * @param config - Price formation configuration
 * @returns Price formation result with diagnostics
 */
export function calculateSafeLimitPrice(
  orderbook: PriceOrderbookSnapshot,
  config: PriceFormationConfig,
): PriceFormationResult {
  const {
    slippagePct,
    side,
    signalPrice,
    minPrice = MIN_PRICE,
    maxPrice = MAX_PRICE,
    maxSpreadCents = DEFAULT_MAX_SPREAD_CENTS,
    minDepthUsd = DEFAULT_MIN_DEPTH_USD,
  } = config;

  const { bestBid, bestAsk, bidDepthUsd, askDepthUsd } = orderbook;
  const spreadCents = (bestAsk - bestBid) * 100;
  const slippageMultiplier = slippagePct / 100;

  // Initialize diagnostics
  const diagnostics: PriceFormationDiagnostics = {
    signalPrice,
    bestBid,
    bestAsk,
    spreadCents,
    rawLimitPrice: 0,
    clampedLimitPrice: 0,
    slippagePct,
    side,
    method: signalPrice ? "signal" : "slippage",
  };

  // Check for invalid orderbook
  if (!bestBid || !bestAsk || bestBid <= 0 || bestAsk <= 0 || isNaN(bestBid) || isNaN(bestAsk)) {
    diagnostics.rawLimitPrice = 0;
    diagnostics.clampedLimitPrice = 0;
    return {
      limitPrice: 0,
      rawPrice: 0,
      wasClamped: false,
      clampDirection: null,
      rejectionReason: "INVALID_ORDERBOOK",
      diagnostics,
    };
  }

  // Check for dust book
  if (isDustBook(orderbook)) {
    diagnostics.rawLimitPrice = side === "BUY" ? bestAsk : bestBid;
    diagnostics.clampedLimitPrice = diagnostics.rawLimitPrice;
    return {
      limitPrice: 0,
      rawPrice: diagnostics.rawLimitPrice,
      wasClamped: false,
      clampDirection: null,
      rejectionReason: "SPREAD_TOO_WIDE",
      diagnostics,
    };
  }

  // Check for spread too wide
  if (spreadCents > maxSpreadCents) {
    diagnostics.rawLimitPrice = side === "BUY" ? bestAsk : bestBid;
    diagnostics.clampedLimitPrice = diagnostics.rawLimitPrice;
    return {
      limitPrice: 0,
      rawPrice: diagnostics.rawLimitPrice,
      wasClamped: false,
      clampDirection: null,
      rejectionReason: "SPREAD_TOO_WIDE",
      diagnostics,
    };
  }

  // Check for insufficient depth
  if (side === "BUY" && askDepthUsd !== undefined && askDepthUsd < minDepthUsd) {
    diagnostics.rawLimitPrice = bestAsk;
    diagnostics.clampedLimitPrice = bestAsk;
    return {
      limitPrice: 0,
      rawPrice: bestAsk,
      wasClamped: false,
      clampDirection: null,
      rejectionReason: "DEPTH_TOO_LOW",
      diagnostics,
    };
  }
  if (side === "SELL" && bidDepthUsd !== undefined && bidDepthUsd < minDepthUsd) {
    diagnostics.rawLimitPrice = bestBid;
    diagnostics.clampedLimitPrice = bestBid;
    return {
      limitPrice: 0,
      rawPrice: bestBid,
      wasClamped: false,
      clampDirection: null,
      rejectionReason: "DEPTH_TOO_LOW",
      diagnostics,
    };
  }

  // Calculate raw limit price based on side and slippage
  let rawPrice: number;

  if (side === "BUY") {
    // For BUY: We're willing to pay UP TO (bestAsk * (1 + slippage))
    // But if signalPrice is provided, use min(signalPrice * (1 + slippage), bestAsk)
    if (signalPrice !== undefined && signalPrice > 0) {
      // Use signal price with slippage, capped at best ask
      rawPrice = Math.min(signalPrice * (1 + slippageMultiplier), bestAsk);
      diagnostics.method = "signal";
    } else {
      // Standard: best ask with slippage
      rawPrice = bestAsk * (1 + slippageMultiplier);
      diagnostics.method = "slippage";
    }
  } else {
    // For SELL: We accept as low as (bestBid * (1 - slippage))
    // But if signalPrice is provided, use max(signalPrice * (1 - slippage), bestBid)
    if (signalPrice !== undefined && signalPrice > 0) {
      // Use signal price with slippage, floored at best bid
      rawPrice = Math.max(signalPrice * (1 - slippageMultiplier), bestBid);
      diagnostics.method = "signal";
    } else {
      // Standard: best bid with slippage
      rawPrice = bestBid * (1 - slippageMultiplier);
      diagnostics.method = "slippage";
    }
  }

  diagnostics.rawLimitPrice = rawPrice;

  // CRITICAL: Clamp to safe bounds
  const clampedPrice = clampPrice(rawPrice, minPrice, maxPrice);
  diagnostics.clampedLimitPrice = clampedPrice;

  // Determine if clamping occurred and direction
  let wasClamped = false;
  let clampDirection: "min" | "max" | null = null;
  let rejectionReason: PriceRejectionReason | undefined;

  if (rawPrice >= maxPrice) {
    wasClamped = true;
    clampDirection = "max";
    rejectionReason = "PRICE_CLAMPED_TO_MAX";
  } else if (rawPrice <= minPrice) {
    wasClamped = true;
    clampDirection = "min";
    rejectionReason = "PRICE_CLAMPED_TO_MIN";
  }

  return {
    limitPrice: clampedPrice,
    rawPrice,
    wasClamped,
    clampDirection,
    rejectionReason,
    diagnostics,
  };
}

/**
 * Log price formation diagnostics.
 * Emits structured JSON log and optionally GitHub Actions annotations.
 *
 * @param result - Price formation result
 * @param traceId - Optional trace ID for correlation
 */
export function logPriceFormation(
  result: PriceFormationResult,
  traceId?: string,
): void {
  const logEvent = {
    event: "PRICE_FORMATION",
    traceId,
    timestamp: new Date().toISOString(),
    ...result.diagnostics,
    wasClamped: result.wasClamped,
    clampDirection: result.clampDirection,
    rejectionReason: result.rejectionReason,
  };

  // Emit structured JSON log
  console.log(JSON.stringify(logEvent));

  // Emit GitHub Actions warnings for price clamping or rejections
  if (result.rejectionReason) {
    const message =
      `Price formation issue: ${result.rejectionReason}. ` +
      `Raw: ${(result.rawPrice * 100).toFixed(2)}¢, Clamped: ${(result.limitPrice * 100).toFixed(2)}¢, ` +
      `Spread: ${result.diagnostics.spreadCents.toFixed(1)}¢, Side: ${result.diagnostics.side}`;

    if (result.rejectionReason === "SPREAD_TOO_WIDE" || result.rejectionReason === "INVALID_ORDERBOOK") {
      // These are more serious - use error annotation
      if (isGitHubActions()) {
        ghError(message);
      } else {
        console.error(`❌ ${message}`);
      }
    } else if (result.wasClamped) {
      // Clamping is a warning - trade may still proceed but at a bounded price
      if (isGitHubActions()) {
        ghWarning(message);
      } else {
        console.warn(`⚠️ ${message}`);
      }
    }
  }
}

/**
 * Validate that a final limit price is within the configured entry bounds.
 * This ensures the price filter (e.g., 35-65¢) is applied to the final order price.
 *
 * @param price - The limit price to validate
 * @param minEntryCents - Minimum entry price in cents
 * @param maxEntryCents - Maximum entry price in cents
 * @returns true if price is within bounds
 */
export function isWithinEntryBounds(
  price: number,
  minEntryCents: number,
  maxEntryCents: number,
): boolean {
  const priceCents = price * 100;
  return priceCents >= minEntryCents && priceCents <= maxEntryCents;
}
