/**
 * Price Safety Module
 *
 * Ensures price formation is safe and cannot result in invalid prices.
 * In prediction markets, prices must be in (0, 1) range.
 *
 * Key safety features:
 * - Clamps all limit prices to safe bounds [MIN_PRICE, MAX_PRICE]
 * - Detects spread-too-wide conditions (illiquid markets)
 * - Validates orderbook sanity
 * - Logs price formation decisions for diagnostics
 *
 * PRICE BOUNDS - The Profit Law (35¢ - 65¢):
 * ═══════════════════════════════════════════════════════════════════════════
 * Default bounds follow the "profit law" - the sweet spot for profitable trades:
 *
 *   MIN_PRICE = 0.35 (35 cents) - Below this, risk/reward unfavorable
 *   MAX_PRICE = 0.65 (65 cents) - Above this, limited upside potential
 *
 * This matches preferredEntryLowCents (35) and preferredEntryHighCents (65).
 *
 * Override via environment variables:
 *   ORDER_MIN_PRICE - Minimum price bound (default: 0.35)
 *   ORDER_MAX_PRICE - Maximum price bound (default: 0.65)
 *
 * Note: Polymarket API accepts 0.01-0.99, but we follow the profit law.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { isGitHubActions, ghWarning, ghError } from "./diag-mode";

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS - Two-layer bounds system
// ═══════════════════════════════════════════════════════════════════════════
//
// HARD API BOUNDS: 0.01-0.99 (Polymarket API limits, always enforced)
// STRATEGY BOUNDS: 0.35-0.65 (user's configured willingness to trade)
//
// The execution flow is:
// 1. Check if base price is within STRATEGY bounds (skip if not)
// 2. Apply slippage
// 3. Clamp to STRATEGY bounds (never below ask for BUY, never above bid for SELL)
// 4. Clamp to HARD API bounds
// 5. Round to tick size
// 6. Apply "must not cross" rule (bump prices after tick rounding to avoid crossing the book)
// 7. Final HARD API bounds clamp
// ═══════════════════════════════════════════════════════════════════════════

// Helper to read numeric env vars
const envNum = (key: string, defaultValue: number): number => {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? defaultValue : parsed;
};

/**
 * HARD API BOUNDS - Polymarket API limits (always enforced)
 * These are the absolute minimum/maximum prices the API accepts.
 */
export const HARD_MIN_PRICE = 0.01;
export const HARD_MAX_PRICE = 0.99;

/**
 * STRATEGY BOUNDS - User's configured willingness to trade
 * Default: 0.35-0.65 (35¢-65¢) - "Profit Law" sweet spot
 * Override via ORDER_MIN_PRICE / ORDER_MAX_PRICE env vars
 *
 * Used for:
 * 1. Filtering whale trades/scan candidates by price range
 * 2. Determining if base price is acceptable (skip if outside bounds)
 * 3. Clamping slippage-adjusted prices
 */
export const STRATEGY_MIN_PRICE = envNum("ORDER_MIN_PRICE", 0.35);
export const STRATEGY_MAX_PRICE = envNum("ORDER_MAX_PRICE", 0.65);

// Aliases for backward compatibility
export const MIN_PRICE = STRATEGY_MIN_PRICE;
export const MAX_PRICE = STRATEGY_MAX_PRICE;

/**
 * Default tick size for Polymarket markets.
 * Most markets use 0.01 (1¢) ticks.
 */
export const DEFAULT_TICK_SIZE = 0.01;

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
  if (
    orderbook.bidDepthUsd !== undefined &&
    orderbook.bidDepthUsd < minDepthUsd
  ) {
    return false;
  }
  if (
    orderbook.askDepthUsd !== undefined &&
    orderbook.askDepthUsd < minDepthUsd
  ) {
    return false;
  }

  return true;
}

/**
 * Default thresholds for dead/empty book detection
 */
export const DEAD_BOOK_THRESHOLDS = {
  /** Maximum bid for dead book classification (default: 2¢) */
  DEAD_BID_CENTS: 2,
  /** Minimum ask for dead book classification (default: 98¢) */
  DEAD_ASK_CENTS: 98,
  /** Maximum bid for empty book classification (default: 1¢) */
  EMPTY_BID_CENTS: 1,
  /** Minimum ask for empty book classification (default: 99¢) */
  EMPTY_ASK_CENTS: 99,
} as const;

/**
 * Book health classification result
 */
export type BookHealthStatus =
  | "HEALTHY" // Book is tradeable
  | "DEAD_BOOK" // Bid <= 2¢ AND Ask >= 98¢ - market appears resolved but not yet settled
  | "EMPTY_BOOK" // Bid <= 1¢ AND Ask >= 99¢ - extreme case, completely untradeable
  | "DUST_BOOK"; // Same as DEAD_BOOK (alias for backward compatibility)

/**
 * Result of book health check
 */
export interface BookHealthResult {
  status: BookHealthStatus;
  healthy: boolean;
  bestBidCents: number;
  bestAskCents: number;
  spreadCents: number;
  reason?: string;
}

/**
 * Check if orderbook represents a dead book (essentially resolved market).
 * A dead book has:
 * - bestBid <= deadBidCents (default: 2¢)
 * - bestAsk >= deadAskCents (default: 98¢)
 *
 * These markets appear resolved (one outcome near 100%, other near 0%)
 * but haven't been settled yet. Trading them would result in:
 * - Buying at ~99¢ for ~1¢ max profit
 * - Selling at ~1¢ for massive loss
 *
 * @param bestBid - Best bid price (0-1 scale)
 * @param bestAsk - Best ask price (0-1 scale)
 * @param deadBidCents - Max bid in cents for dead classification (default: 2)
 * @param deadAskCents - Min ask in cents for dead classification (default: 98)
 * @returns true if this is a dead book
 */
export function isDeadBook(
  bestBid: number,
  bestAsk: number,
  deadBidCents: number = DEAD_BOOK_THRESHOLDS.DEAD_BID_CENTS,
  deadAskCents: number = DEAD_BOOK_THRESHOLDS.DEAD_ASK_CENTS,
): boolean {
  const bidCents = bestBid * 100;
  const askCents = bestAsk * 100;
  return bidCents <= deadBidCents && askCents >= deadAskCents;
}

/**
 * Check if orderbook represents an empty book (extreme dead book).
 * An empty book has:
 * - bestBid <= emptyBidCents (default: 1¢)
 * - bestAsk >= emptyAskCents (default: 99¢)
 *
 * This is a stricter version of dead book - the market is completely untradeable.
 *
 * @param bestBid - Best bid price (0-1 scale)
 * @param bestAsk - Best ask price (0-1 scale)
 * @param emptyBidCents - Max bid in cents for empty classification (default: 1)
 * @param emptyAskCents - Min ask in cents for empty classification (default: 99)
 * @returns true if this is an empty book
 */
export function isEmptyBook(
  bestBid: number,
  bestAsk: number,
  emptyBidCents: number = DEAD_BOOK_THRESHOLDS.EMPTY_BID_CENTS,
  emptyAskCents: number = DEAD_BOOK_THRESHOLDS.EMPTY_ASK_CENTS,
): boolean {
  const bidCents = bestBid * 100;
  const askCents = bestAsk * 100;
  return bidCents <= emptyBidCents && askCents >= emptyAskCents;
}

/**
 * Comprehensive book health check.
 * Returns detailed classification of orderbook health.
 *
 * @param bestBid - Best bid price (0-1 scale)
 * @param bestAsk - Best ask price (0-1 scale)
 * @param thresholds - Optional custom thresholds
 * @returns BookHealthResult with status and details
 */
export function checkBookHealth(
  bestBid: number,
  bestAsk: number,
  thresholds?: {
    deadBidCents?: number;
    deadAskCents?: number;
    emptyBidCents?: number;
    emptyAskCents?: number;
  },
): BookHealthResult {
  const deadBidCents =
    thresholds?.deadBidCents ?? DEAD_BOOK_THRESHOLDS.DEAD_BID_CENTS;
  const deadAskCents =
    thresholds?.deadAskCents ?? DEAD_BOOK_THRESHOLDS.DEAD_ASK_CENTS;
  const emptyBidCents =
    thresholds?.emptyBidCents ?? DEAD_BOOK_THRESHOLDS.EMPTY_BID_CENTS;
  const emptyAskCents =
    thresholds?.emptyAskCents ?? DEAD_BOOK_THRESHOLDS.EMPTY_ASK_CENTS;

  const bidCents = bestBid * 100;
  const askCents = bestAsk * 100;
  const spreadCents = askCents - bidCents;

  // Check for empty book first (stricter)
  if (bidCents <= emptyBidCents && askCents >= emptyAskCents) {
    return {
      status: "EMPTY_BOOK",
      healthy: false,
      bestBidCents: bidCents,
      bestAskCents: askCents,
      spreadCents,
      reason: `Empty book: bid ${bidCents.toFixed(1)}¢ <= ${emptyBidCents}¢ AND ask ${askCents.toFixed(1)}¢ >= ${emptyAskCents}¢`,
    };
  }

  // Check for dead book
  if (bidCents <= deadBidCents && askCents >= deadAskCents) {
    return {
      status: "DEAD_BOOK",
      healthy: false,
      bestBidCents: bidCents,
      bestAskCents: askCents,
      spreadCents,
      reason: `Dead book: bid ${bidCents.toFixed(1)}¢ <= ${deadBidCents}¢ AND ask ${askCents.toFixed(1)}¢ >= ${deadAskCents}¢`,
    };
  }

  return {
    status: "HEALTHY",
    healthy: true,
    bestBidCents: bidCents,
    bestAskCents: askCents,
    spreadCents,
  };
}

/**
 * Check for dust book (bid near 0, ask near 100) which indicates an illiquid/closed market.
 * This is an alias for isDeadBook() for backward compatibility.
 *
 * @param orderbook - Orderbook snapshot
 * @returns true if this appears to be a dust book
 */
export function isDustBook(orderbook: PriceOrderbookSnapshot): boolean {
  // Delegate to isDeadBook() to maintain single source of truth
  return isDeadBook(orderbook.bestBid, orderbook.bestAsk);
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
  if (
    !bestBid ||
    !bestAsk ||
    bestBid <= 0 ||
    bestAsk <= 0 ||
    isNaN(bestBid) ||
    isNaN(bestAsk)
  ) {
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
  if (
    side === "BUY" &&
    askDepthUsd !== undefined &&
    askDepthUsd < minDepthUsd
  ) {
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
  if (
    side === "SELL" &&
    bidDepthUsd !== undefined &&
    bidDepthUsd < minDepthUsd
  ) {
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

    if (
      result.rejectionReason === "SPREAD_TOO_WIDE" ||
      result.rejectionReason === "INVALID_ORDERBOOK"
    ) {
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

// ═══════════════════════════════════════════════════════════════════════════
// SHARED LIMIT PRICE COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Input for computing a limit price
 */
export interface ComputeLimitPriceInput {
  /** Best bid price in dollars (0-1 scale) */
  bestBid: number;
  /** Best ask price in dollars (0-1 scale) */
  bestAsk: number;
  /** Order side: "BUY" or "SELL" */
  side: "BUY" | "SELL";
  /** Slippage as a fraction (e.g., 0.059 for 5.9%) */
  slippageFrac: number;
  /** Token ID prefix for logging (optional) */
  tokenIdPrefix?: string;
}

/**
 * Result from computing a limit price
 */
export interface ComputeLimitPriceResult {
  /** The computed and clamped limit price (always in [MIN_PRICE, MAX_PRICE]) */
  limitPrice: number;
  /** The raw computed price before clamping */
  rawPrice: number;
  /** Whether the price was clamped */
  wasClamped: boolean;
  /** Direction of clamping: "min", "max", or null */
  clampDirection: "min" | "max" | null;
}

/**
 * Compute a safe limit price for order submission.
 *
 * This utility function encapsulates the price clamping logic for convenience.
 * It can be used by any order submission path that needs to compute a safe limit price.
 *
 * Policy:
 * - For BUY: limitPrice = min(MAX_PRICE, bestAsk * (1 + slippageFrac))
 * - For SELL: limitPrice = max(MIN_PRICE, bestBid * (1 - slippageFrac))
 *
 * The slippageFrac parameter MUST be a fraction (0.059 for 5.9%), NOT a percentage (5.9).
 * If you have a percentage, convert it first: slippageFrac = slippagePct / 100
 *
 * CRITICAL: This function ALWAYS clamps the result to [MIN_PRICE, MAX_PRICE].
 * This prevents "invalid price" errors from the CLOB API.
 *
 * @param input - Price computation input
 * @returns Computed limit price result with diagnostics
 */
export function computeLimitPrice(
  input: ComputeLimitPriceInput,
): ComputeLimitPriceResult {
  const { bestBid, bestAsk, side, slippageFrac, tokenIdPrefix } = input;

  // Validate slippageFrac is a fraction, not a percentage
  // If slippageFrac > 1, it's likely a percentage and should be divided by 100
  if (slippageFrac > 1) {
    console.warn(
      `⚠️ [PRICE_SAFETY] slippageFrac=${slippageFrac} appears to be a percentage, not a fraction. ` +
        `Expected value like 0.059 for 5.9%, not ${slippageFrac}. This may cause invalid prices!`,
    );
  }

  // Compute raw price based on side
  let rawPrice: number;

  if (side === "BUY") {
    // For BUY: We're willing to pay UP TO (bestAsk * (1 + slippageFrac))
    rawPrice = bestAsk * (1 + slippageFrac);
  } else {
    // For SELL: We accept as low as (bestBid * (1 - slippageFrac))
    rawPrice = bestBid * (1 - slippageFrac);
  }

  // Handle NaN or invalid prices
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
    console.warn(
      `⚠️ [PRICE_SAFETY] Invalid raw price: ${rawPrice} for ${side}. ` +
        `bestBid=${bestBid}, bestAsk=${bestAsk}, slippageFrac=${slippageFrac}. Clamping to bounds.`,
    );
    rawPrice = side === "BUY" ? MAX_PRICE : MIN_PRICE;
  }

  // CRITICAL: Clamp to safe bounds [MIN_PRICE, MAX_PRICE]
  let limitPrice = rawPrice;
  let wasClamped = false;
  let clampDirection: "min" | "max" | null = null;

  if (rawPrice > MAX_PRICE) {
    limitPrice = MAX_PRICE;
    wasClamped = true;
    clampDirection = "max";
    console.warn(
      `⚠️ [PRICE_SAFETY] Price clamped to MAX: ${rawPrice.toFixed(6)} → ${MAX_PRICE} ` +
        `(${side}, bestAsk=${bestAsk}, slippageFrac=${slippageFrac})`,
    );
  } else if (rawPrice < MIN_PRICE) {
    limitPrice = MIN_PRICE;
    wasClamped = true;
    clampDirection = "min";
    console.warn(
      `⚠️ [PRICE_SAFETY] Price clamped to MIN: ${rawPrice.toFixed(6)} → ${MIN_PRICE} ` +
        `(${side}, bestBid=${bestBid}, slippageFrac=${slippageFrac})`,
    );
  }

  // Log ORDER_PRICE_DEBUG for diagnostics (always, not just when clamped)
  const mid = (bestBid + bestAsk) / 2;
  const debugLog = {
    event: "ORDER_PRICE_DEBUG",
    tokenIdPrefix: tokenIdPrefix || "unknown",
    side,
    bestBid: bestBid.toFixed(4),
    bestBidCents: (bestBid * 100).toFixed(2),
    bestAsk: bestAsk.toFixed(4),
    bestAskCents: (bestAsk * 100).toFixed(2),
    mid: mid.toFixed(4),
    slippagePct: (slippageFrac * 100).toFixed(2),
    slippageFrac: slippageFrac.toFixed(4),
    rawPrice: rawPrice.toFixed(6),
    computedLimitPrice: limitPrice.toFixed(6),
    wasClamped,
    clampDirection,
    units: "dollars",
    timestamp: new Date().toISOString(),
  };

  console.log(JSON.stringify(debugLog));

  return {
    limitPrice,
    rawPrice,
    wasClamped,
    clampDirection,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXECUTION PRICE COMPUTATION (WITH PROPER BASE PRICE SELECTION)
// ═══════════════════════════════════════════════════════════════════════════
// The key fix: Use actual bestAsk for BUY, bestBid for SELL (not 0.99 default).
// Clamping uses MIN_PRICE/MAX_PRICE (user's configured bounds).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Input for computing an execution limit price
 */
export interface ComputeExecutionPriceInput {
  /** Best bid price in dollars (0-1 scale) */
  bestBid: number;
  /** Best ask price in dollars (0-1 scale) */
  bestAsk: number;
  /** Order side: "BUY" or "SELL" */
  side: "BUY" | "SELL";
  /** Slippage as a fraction (e.g., 0.061 for 6.1%) */
  slippageFrac: number;
  /** Token ID prefix for logging */
  tokenIdPrefix?: string;
  /** Tick size for price rounding (default: 0.01) */
  tickSize?: number;
}

/**
 * Result from computing an execution limit price
 */
export interface ComputeExecutionPriceResult {
  /** Whether computation succeeded (book is healthy) */
  success: boolean;
  /** The computed execution limit price (clamped to STRATEGY bounds respecting "never cross" rule, then HARD API bounds [0.01, 0.99], rounded to tick) */
  limitPrice: number;
  /** The base price used (bestAsk for BUY, bestBid for SELL) */
  basePrice: number;
  /** The raw computed price before clamping */
  rawPrice: number;
  /** Whether the price was clamped */
  wasClamped: boolean;
  /** Direction of clamping: "min", "max", or null */
  clampDirection: "min" | "max" | null;
  /** Rejection reason if computation failed */
  rejectionReason?: "INVALID_BOOK" | "DUST_BOOK" | "EMPTY_BOOK" | "PRICE_NAN" | "ASK_ABOVE_MAX" | "BID_BELOW_MIN" | "CROSSED_BOOK";
}

/**
 * Round a price to a valid tick size.
 * 
 * DIRECTIONAL ROUNDING:
 * - BUY orders: round UP (ceiling) to ensure we don't offer less than the ask
 * - SELL orders: round DOWN (floor) to ensure we don't ask more than the bid
 * - If side not specified: round to nearest (legacy behavior)
 * 
 * This prevents "crossing book" issues where rounding causes the limit price
 * to be worse than the best price on the opposite side.
 * 
 * NOTE: Uses epsilon-adjusted rounding to handle floating point precision issues.
 * For example, 0.59 / 0.01 = 58.99999999999999 in JS, which would floor to 58.
 * We add a small epsilon before flooring/ceiling to handle this.
 * 
 * @param price - The price to round (in dollars, 0-1 scale)
 * @param tickSize - The tick size (default: 0.01)
 * @param side - Optional order side for directional rounding ("BUY" = ceiling, "SELL" = floor)
 * @returns The rounded price
 */
export function roundToTick(
  price: number, 
  tickSize: number = DEFAULT_TICK_SIZE,
  side?: "BUY" | "SELL",
): number {
  if (!Number.isFinite(price) || !Number.isFinite(tickSize)) {
    return price;
  }

  if (tickSize <= 0) {
    const message = `roundToTick: received non-positive tickSize (${tickSize}); returning unrounded price ${price}.`;
    if (isGitHubActions()) {
      ghWarning(message);
    } else {
      console.warn(message);
    }
    return price;
  }

  // Use epsilon to handle floating point precision issues
  // e.g., 0.59 / 0.01 = 58.99999999999999, not 59
  const EPSILON = 1e-9;
  const ticks = price / tickSize;

  // Directional rounding based on order side
  // BUY: round UP (ceiling) - we're willing to pay more
  // SELL: round DOWN (floor) - we're willing to accept less
  // No side: round to nearest (legacy behavior)
  //
  // Epsilon adjustment ensures floating-point precision errors don't cause
  // incorrect rounding at exact tick boundaries:
  // - For BUY (ceiling): 58.999999999 (from 0.59/0.01) → 58.999999998 (ticks - EPSILON) → ceil → 59
  // - For SELL (floor): 58.999999999 (from 0.59/0.01) → 59.000000000 (ticks + EPSILON) → floor → 59
  if (side === "BUY") {
    return Math.ceil(ticks - EPSILON) * tickSize;
  } else if (side === "SELL") {
    return Math.floor(ticks + EPSILON) * tickSize;
  } else {
    // Legacy: round to nearest
    return Math.round(ticks) * tickSize;
  }
}

/**
 * Check if an orderbook is healthy enough for execution.
 * Returns false for empty/dust books that should be rejected (not defaulted to 0.99).
 * 
 * @param bestBid - Best bid price (0-1 scale)
 * @param bestAsk - Best ask price (0-1 scale)
 * @returns Object with healthy flag and reason if unhealthy
 */
export function isBookHealthyForExecution(
  bestBid: number | undefined | null,
  bestAsk: number | undefined | null,
): { healthy: boolean; reason?: "INVALID_BOOK" | "DUST_BOOK" | "EMPTY_BOOK" | "CROSSED_BOOK" } {
  // Check for invalid/missing prices
  if (
    bestBid === undefined || 
    bestBid === null || 
    bestAsk === undefined || 
    bestAsk === null ||
    !Number.isFinite(bestBid) ||
    !Number.isFinite(bestAsk) ||
    bestBid <= 0 ||
    bestAsk <= 0
  ) {
    return { healthy: false, reason: "INVALID_BOOK" };
  }

  // Check for crossed book (bid > ask) - indicates stale/corrupted data
  if (bestBid > bestAsk) {
    return { healthy: false, reason: "CROSSED_BOOK" };
  }

  // Check for empty book (bid <= 1¢ AND ask >= 99¢)
  const bidCents = bestBid * 100;
  const askCents = bestAsk * 100;
  
  if (bidCents <= 1 && askCents >= 99) {
    return { healthy: false, reason: "EMPTY_BOOK" };
  }

  // Check for dust book (bid <= 2¢ AND ask >= 98¢)
  if (bidCents <= 2 && askCents >= 98) {
    return { healthy: false, reason: "DUST_BOOK" };
  }

  return { healthy: true };
}

/**
 * Compute an execution limit price for order submission.
 * 
 * TWO-LAYER BOUNDS SYSTEM:
 * 1. STRATEGY bounds (STRATEGY_MIN_PRICE/STRATEGY_MAX_PRICE, default 0.35-0.65)
 *    - If base price is outside strategy bounds → SKIP (don't try)
 *    - Clamp slippage-adjusted price to strategy bounds
 *    - BUY: clamp to [bestAsk, STRATEGY_MAX] (never below ask)
 *    - SELL: clamp to [STRATEGY_MIN, bestBid] (never above bid)
 * 
 * 2. HARD API bounds (0.01-0.99) - always enforced after strategy bounds
 * 
 * 3. Tick rounding with "must not cross" rule to avoid missed fills
 * 
 * @param input - Execution price computation input
 * @returns Result with limitPrice and diagnostics
 */
export function computeExecutionLimitPrice(
  input: ComputeExecutionPriceInput,
): ComputeExecutionPriceResult {
  const {
    bestBid,
    bestAsk,
    side,
    slippageFrac,
    tokenIdPrefix = "unknown",
    tickSize = DEFAULT_TICK_SIZE,
  } = input;

  // Helper: clamp value to [min, max]
  const clamp = (value: number, min: number, max: number): number => {
    return Math.max(min, Math.min(max, value));
  };

  // Validate slippageFrac is a fraction, not a percentage
  if (slippageFrac > 1) {
    console.warn(
      `⚠️ [EXEC_PRICE] slippageFrac=${slippageFrac} appears to be a percentage, not a fraction. ` +
        `Expected value like 0.061 for 6.1%, not ${slippageFrac}. This may cause invalid prices!`,
    );
  }

  // Step 1: Validate book health - REJECT if unhealthy (dust/empty/crossed)
  const healthCheck = isBookHealthyForExecution(bestBid, bestAsk);
  if (!healthCheck.healthy) {
    console.log(
      JSON.stringify({
        event: "ORDER_PRICE_DEBUG",
        result: "REJECTED",
        reason: healthCheck.reason,
        tokenIdPrefix,
        side,
        bestBid: bestBid?.toFixed?.(4) ?? "null",
        bestAsk: bestAsk?.toFixed?.(4) ?? "null",
        strategyMin: STRATEGY_MIN_PRICE,
        strategyMax: STRATEGY_MAX_PRICE,
        hardMin: HARD_MIN_PRICE,
        hardMax: HARD_MAX_PRICE,
        timestamp: new Date().toISOString(),
      }),
    );

    return {
      success: false,
      limitPrice: 0,
      basePrice: 0,
      rawPrice: 0,
      wasClamped: false,
      clampDirection: null,
      rejectionReason: healthCheck.reason,
    };
  }

  // Step 2: Determine base price from orderbook
  // BUY: we pay the ask price (seller's price)
  // SELL: we receive the bid price (buyer's price)
  const basePrice = side === "BUY" ? bestAsk : bestBid;

  // Step 3: Reject early if base price is outside STRATEGY bounds
  // BUY: reject if bestAsk > STRATEGY_MAX (don't clamp and try anyway)
  // SELL: reject if bestBid < STRATEGY_MIN
  if (side === "BUY" && basePrice > STRATEGY_MAX_PRICE) {
    console.log(
      JSON.stringify({
        event: "ORDER_PRICE_DEBUG",
        result: "REJECTED",
        reason: "ASK_ABOVE_STRATEGY_MAX",
        tokenIdPrefix,
        side,
        bestBid: bestBid.toFixed(4),
        bestAsk: bestAsk.toFixed(4),
        strategyMin: STRATEGY_MIN_PRICE,
        strategyMax: STRATEGY_MAX_PRICE,
        hardMin: HARD_MIN_PRICE,
        hardMax: HARD_MAX_PRICE,
        basePriceUsed: basePrice.toFixed(4),
        message: `bestAsk ${(bestAsk * 100).toFixed(1)}¢ > STRATEGY_MAX ${(STRATEGY_MAX_PRICE * 100).toFixed(1)}¢ - SKIP`,
        timestamp: new Date().toISOString(),
      }),
    );

    return {
      success: false,
      limitPrice: 0,
      basePrice,
      rawPrice: 0,
      wasClamped: false,
      clampDirection: null,
      rejectionReason: "ASK_ABOVE_MAX",
    };
  }

  if (side === "SELL" && basePrice < STRATEGY_MIN_PRICE) {
    console.log(
      JSON.stringify({
        event: "ORDER_PRICE_DEBUG",
        result: "REJECTED",
        reason: "BID_BELOW_STRATEGY_MIN",
        tokenIdPrefix,
        side,
        bestBid: bestBid.toFixed(4),
        bestAsk: bestAsk.toFixed(4),
        strategyMin: STRATEGY_MIN_PRICE,
        strategyMax: STRATEGY_MAX_PRICE,
        hardMin: HARD_MIN_PRICE,
        hardMax: HARD_MAX_PRICE,
        basePriceUsed: basePrice.toFixed(4),
        message: `bestBid ${(bestBid * 100).toFixed(1)}¢ < STRATEGY_MIN ${(STRATEGY_MIN_PRICE * 100).toFixed(1)}¢ - SKIP`,
        timestamp: new Date().toISOString(),
      }),
    );

    return {
      success: false,
      limitPrice: 0,
      basePrice,
      rawPrice: 0,
      wasClamped: false,
      clampDirection: null,
      rejectionReason: "BID_BELOW_MIN",
    };
  }

  // Step 4: Compute raw limit price with slippage
  // BUY: raw = bestAsk * (1 + slippage)
  // SELL: raw = bestBid * (1 - slippage)
  const rawPrice = side === "BUY"
    ? basePrice * (1 + slippageFrac)
    : basePrice * (1 - slippageFrac);

  // Handle NaN or invalid
  if (!Number.isFinite(rawPrice)) {
    console.log(
      JSON.stringify({
        event: "ORDER_PRICE_DEBUG",
        result: "REJECTED",
        reason: "PRICE_NAN",
        tokenIdPrefix,
        side,
        basePrice: basePrice.toFixed(4),
        slippageFrac: slippageFrac.toFixed(4),
        rawPrice: String(rawPrice),
        timestamp: new Date().toISOString(),
      }),
    );

    return {
      success: false,
      limitPrice: 0,
      basePrice,
      rawPrice: 0,
      wasClamped: false,
      clampDirection: null,
      rejectionReason: "PRICE_NAN",
    };
  }

  // Step 5: Strategy clamp
  // BUY: clamp(raw, bestAsk, STRATEGY_MAX) - never below ask or you guarantee no fill
  // SELL: clamp(raw, STRATEGY_MIN, bestBid) - never above bid or you guarantee no fill
  let clampedToStrategy: number;
  let wasClampedToStrategy = false;
  let strategyClampDirection: "min" | "max" | null = null;

  if (side === "BUY") {
    clampedToStrategy = clamp(rawPrice, basePrice, STRATEGY_MAX_PRICE);
    if (clampedToStrategy !== rawPrice) {
      wasClampedToStrategy = true;
      strategyClampDirection = rawPrice < basePrice ? "min" : "max";
    }
  } else {
    clampedToStrategy = clamp(rawPrice, STRATEGY_MIN_PRICE, basePrice);
    if (clampedToStrategy !== rawPrice) {
      wasClampedToStrategy = true;
      strategyClampDirection = rawPrice < STRATEGY_MIN_PRICE ? "min" : "max";
    }
  }

  // Step 6: Hard clamp to API bounds [0.01, 0.99]
  const clampedToHard = clamp(clampedToStrategy, HARD_MIN_PRICE, HARD_MAX_PRICE);
  let wasClampedToHard = false;
  let hardClampDirection: "min" | "max" | null = null;
  
  if (clampedToHard !== clampedToStrategy) {
    wasClampedToHard = true;
    hardClampDirection = clampedToStrategy < HARD_MIN_PRICE ? "min" : "max";
  }

  // Step 7: Round to tick size with DIRECTIONAL rounding
  // BUY: round UP (ceiling) - we're willing to pay more
  // SELL: round DOWN (floor) - we're willing to accept less
  let roundedFinal = roundToTick(clampedToHard, tickSize, side);

  // Step 8: Re-assert "must not cross" rule after rounding
  // BUY: if final < bestAsk after rounding → bump up to next tick at/above ask
  // SELL: if final > bestBid after rounding → bump down to next tick at/below bid
  let wouldCrossBookAfterRounding = false;
  
  if (side === "BUY" && roundedFinal < basePrice) {
    wouldCrossBookAfterRounding = true;
    // Bump up to next tick at/above ask, but never above HARD_MAX_PRICE
    const bumped = Math.ceil(basePrice / tickSize) * tickSize;
    const hardSafeBumped = Math.min(bumped, HARD_MAX_PRICE);
    if (hardSafeBumped !== bumped) {
      wasClampedToHard = true;
      hardClampDirection = "max";
    }
    roundedFinal = hardSafeBumped;
  } else if (side === "SELL" && roundedFinal > basePrice) {
    wouldCrossBookAfterRounding = true;
    // Bump down to next tick at/below bid, but never below HARD_MIN_PRICE
    const bumped = Math.floor(basePrice / tickSize) * tickSize;
    const hardSafeBumped = Math.max(bumped, HARD_MIN_PRICE);
    if (hardSafeBumped !== bumped) {
      wasClampedToHard = true;
      hardClampDirection = "min";
    }
    roundedFinal = hardSafeBumped;
  }

  // Final safety: ensure within HARD bounds after all adjustments
  const limitPrice = clamp(roundedFinal, HARD_MIN_PRICE, HARD_MAX_PRICE);

  // Track if final HARD clamp changed the price after rounding / "must not cross" bump
  const hardClampAppliedAfterBump = limitPrice !== roundedFinal;
  const finalClampDirection =
    hardClampAppliedAfterBump
      ? (limitPrice === HARD_MIN_PRICE ? "min" : "max")
      : null;

  // Overall clamping status
  const wasClamped =
    wasClampedToStrategy ||
    wasClampedToHard ||
    wouldCrossBookAfterRounding ||
    hardClampAppliedAfterBump;
  const clampDirection =
    finalClampDirection || hardClampDirection || strategyClampDirection;

  // Step 9: Detailed logging with all bounds info
  const mid = (bestBid + bestAsk) / 2;
  const spreadCents = (bestAsk - bestBid) * 100;

  console.log(
    JSON.stringify({
      event: "ORDER_PRICE_DEBUG",
      result: "OK",
      tokenIdPrefix,
      side,
      // Book values
      bestBid: bestBid.toFixed(4),
      bestAsk: bestAsk.toFixed(4),
      // Strategy and hard bounds
      strategyMin: STRATEGY_MIN_PRICE,
      strategyMax: STRATEGY_MAX_PRICE,
      hardMin: HARD_MIN_PRICE,
      hardMax: HARD_MAX_PRICE,
      // Base price used
      basePriceUsed: basePrice.toFixed(4),
      // Price computation chain
      raw: rawPrice.toFixed(6),
      clampedToStrategy: clampedToStrategy.toFixed(6),
      clampedToHard: clampedToHard.toFixed(6),
      roundedFinal: limitPrice.toFixed(6),
      // Clamping info
      wasClampedToStrategy,
      strategyClampDirection,
      wasClampedToHard,
      hardClampDirection,
      wouldCrossBookAfterRounding,
      // Config
      tickSize,
      slippageFrac: slippageFrac.toFixed(4),
      // Additional context
      spreadCents: spreadCents.toFixed(2),
      mid: mid.toFixed(4),
      timestamp: new Date().toISOString(),
    }),
  );

  // Log warning if clamped
  if (wasClamped) {
    const reasons = [];
    if (wasClampedToStrategy) reasons.push("STRATEGY");
    if (wasClampedToHard) reasons.push("HARD");
    if (wouldCrossBookAfterRounding) reasons.push("ROUNDING_CROSS_FIX");
    console.warn(
      `⚠️ [EXEC_PRICE] Price adjusted (${reasons.join("+")}): ` +
        `raw=${rawPrice.toFixed(4)} → strategy=${clampedToStrategy.toFixed(4)} → hard=${clampedToHard.toFixed(4)} → final=${limitPrice.toFixed(4)} ` +
        `(${side}, base=${basePrice.toFixed(4)}, slippage=${(slippageFrac * 100).toFixed(2)}%)`,
    );
  }

  return {
    success: true,
    limitPrice,
    basePrice,
    rawPrice,
    wasClamped,
    clampDirection,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TICK SIZE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Tick size cache for markets
 * Key: tokenId or marketId
 * Value: { tickSize: number, isDefault: boolean, fetchedAt: number }
 */
const tickSizeCache = new Map<string, { tickSize: number; isDefault: boolean; fetchedAt: number }>();

/** Cache TTL for tick sizes (5 minutes) */
const TICK_SIZE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Get the tick size for a token/market.
 * 
 * Currently returns the default tick size (0.01) for all markets since
 * Polymarket markets consistently use 1¢ ticks. This function provides
 * a single point for future customization if markets with different tick
 * sizes are introduced.
 * 
 * @param tokenIdOrMarketId - Token ID or Market ID to get tick size for
 * @param apiTickSize - Optional API-provided tick size (if available from market metadata)
 * @returns Object with tickSize and whether it's the default
 */
export function getTickSizeForToken(
  tokenIdOrMarketId: string,
  apiTickSize?: number,
): { tickSize: number; isDefault: boolean } {
  // Check cache first
  const cached = tickSizeCache.get(tokenIdOrMarketId);
  if (cached && Date.now() - cached.fetchedAt < TICK_SIZE_CACHE_TTL_MS) {
    return { tickSize: cached.tickSize, isDefault: cached.isDefault };
  }

  // Use API-provided tick size if valid
  if (apiTickSize !== undefined && Number.isFinite(apiTickSize) && apiTickSize > 0) {
    const entry = { tickSize: apiTickSize, isDefault: false, fetchedAt: Date.now() };
    tickSizeCache.set(tokenIdOrMarketId, entry);
    return { tickSize: apiTickSize, isDefault: false };
  }

  // Fall back to default and log when we're using default
  // Only log once per token to avoid spam
  if (!cached) {
    console.log(
      `ℹ️ [TICK_SIZE] Using default tick size ${DEFAULT_TICK_SIZE} for ${tokenIdOrMarketId.slice(0, 12)}... (no API tick size provided)`,
    );
  }

  const entry = { tickSize: DEFAULT_TICK_SIZE, isDefault: true, fetchedAt: Date.now() };
  tickSizeCache.set(tokenIdOrMarketId, entry);
  return { tickSize: DEFAULT_TICK_SIZE, isDefault: true };
}

/**
 * Clear the tick size cache (for testing)
 */
export function clearTickSizeCache(): void {
  tickSizeCache.clear();
}

// ═══════════════════════════════════════════════════════════════════════════
// PRICE UNIT CONVERSION HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert a price in dollars to API units.
 * 
 * Polymarket CLOB API expects prices in the range [0.01, 0.99] representing
 * probability/price in dollars (e.g., 0.65 = 65¢).
 * 
 * This function is an identity transform but provides documentation and
 * validation that the price is in the expected format.
 * 
 * @param priceDollars - Price in dollars (0.01-0.99 range)
 * @returns Price in API units (same as input, validates range)
 * @throws Error if price is outside valid range
 */
export function toApiPriceUnits(priceDollars: number): number {
  if (!Number.isFinite(priceDollars)) {
    throw new Error(`toApiPriceUnits: invalid price ${priceDollars} (not finite)`);
  }
  if (priceDollars < HARD_MIN_PRICE || priceDollars > HARD_MAX_PRICE) {
    throw new Error(
      `toApiPriceUnits: price ${priceDollars} outside API bounds [${HARD_MIN_PRICE}, ${HARD_MAX_PRICE}]`,
    );
  }
  return priceDollars;
}

/**
 * Convert a price from API units to dollars.
 * 
 * This is an identity transform since API already uses dollars, but provides
 * clear documentation that the conversion is intentional.
 * 
 * @param apiPrice - Price from API response (0.01-0.99 range)
 * @returns Price in dollars (same as input)
 */
export function fromApiPriceUnits(apiPrice: number): number {
  if (!Number.isFinite(apiPrice)) {
    console.warn(`fromApiPriceUnits: received non-finite price ${apiPrice}`);
    return 0;
  }
  return apiPrice;
}

/**
 * Assert that a final limit price is within both HARD bounds and strategy bounds.
 * 
 * @param limitPrice - The computed limit price to validate
 * @param side - Order side ("BUY" or "SELL")
 * @param context - Optional context for error messages
 * @returns true if valid
 * @throws Error if price is invalid
 */
export function assertValidLimitPrice(
  limitPrice: number,
  side: "BUY" | "SELL",
  context?: string,
): boolean {
  const ctx = context ? ` (${context})` : "";

  if (!Number.isFinite(limitPrice)) {
    throw new Error(`Invalid limit price: ${limitPrice} is not finite${ctx}`);
  }

  if (limitPrice < HARD_MIN_PRICE || limitPrice > HARD_MAX_PRICE) {
    throw new Error(
      `Invalid limit price: ${limitPrice} outside HARD bounds [${HARD_MIN_PRICE}, ${HARD_MAX_PRICE}]${ctx}`,
    );
  }

  // Strategy bounds check (warning, not error - already clamped)
  if (side === "BUY" && limitPrice > STRATEGY_MAX_PRICE) {
    console.warn(
      `⚠️ BUY limit price ${limitPrice} > STRATEGY_MAX ${STRATEGY_MAX_PRICE}${ctx}`,
    );
  }
  if (side === "SELL" && limitPrice < STRATEGY_MIN_PRICE) {
    console.warn(
      `⚠️ SELL limit price ${limitPrice} < STRATEGY_MIN ${STRATEGY_MIN_PRICE}${ctx}`,
    );
  }

  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// ORDER REJECTION CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Classification of order rejection reasons
 */
export type RejectionClass =
  | "PRICE_INCREMENT"      // Invalid tick/price increment
  | "INVALID_PRICE_UNITS"  // Price format/units issue
  | "POST_ONLY_WOULD_TRADE" // postOnly order would immediately trade
  | "INSUFFICIENT_BALANCE" // Not enough USDC balance
  | "INSUFFICIENT_ALLOWANCE" // Not enough token allowance
  | "MIN_SIZE"             // Order size below minimum
  | "PRECISION"            // Too many decimal places
  | "STALE_ORDERBOOK"      // Stale nonce or orderbook data
  | "CROSSED_BOOK"         // Limit price crosses the book incorrectly
  | "MARKET_CLOSED"        // Market is resolved/closed
  | "RATE_LIMITED"         // API rate limit hit
  | "NETWORK_ERROR"        // Network/connection issue
  | "UNKNOWN";             // Unclassified error

/**
 * Classify a rejection reason from an error message.
 * 
 * Maps common CLOB API error messages to standardized rejection classes.
 * This helps with diagnostics and automated error handling.
 * 
 * @param errorMsg - Error message from API or order rejection
 * @returns Classified rejection reason
 */
export function classifyRejectionReason(errorMsg: string): RejectionClass {
  const lower = errorMsg.toLowerCase();

  // Price increment / tick errors
  if (
    lower.includes("price increment") ||
    lower.includes("invalid tick") ||
    lower.includes("tick size") ||
    lower.includes("price_increment")
  ) {
    return "PRICE_INCREMENT";
  }

  // Price units errors
  if (
    lower.includes("invalid price") ||
    lower.includes("price units") ||
    lower.includes("price format") ||
    lower.includes("price must be")
  ) {
    return "INVALID_PRICE_UNITS";
  }

  // Post-only would trade
  if (
    (
      (lower.includes("post only") || lower.includes("postonly")) &&
      lower.includes("would trade")
    ) ||
    lower.includes("taker_not_allowed")
  ) {
    return "POST_ONLY_WOULD_TRADE";
  }

  // Balance issues
  if (
    lower.includes("insufficient balance") ||
    lower.includes("not enough balance") ||
    lower.includes("balance too low")
  ) {
    return "INSUFFICIENT_BALANCE";
  }

  // Allowance issues
  if (
    lower.includes("insufficient allowance") ||
    lower.includes("not enough allowance") ||
    lower.includes("allowance too low")
  ) {
    return "INSUFFICIENT_ALLOWANCE";
  }

  // Min size errors
  if (
    lower.includes("min size") ||
    lower.includes("minimum size") ||
    lower.includes("order too small") ||
    lower.includes("size too small")
  ) {
    return "MIN_SIZE";
  }

  // Precision errors
  if (
    lower.includes("precision") ||
    lower.includes("decimal") ||
    lower.includes("too many decimals")
  ) {
    return "PRECISION";
  }

  // Stale data
  if (
    lower.includes("stale") ||
    lower.includes("nonce") ||
    lower.includes("expired") ||
    lower.includes("outdated")
  ) {
    return "STALE_ORDERBOOK";
  }

  // Crossed book
  if (
    lower.includes("crossed") ||
    /\bcross\b/.test(lower) ||
    lower.includes("would cross")
  ) {
    return "CROSSED_BOOK";
  }

  // Market closed
  if (
    lower.includes("market closed") ||
    lower.includes("market resolved") ||
    lower.includes("no orderbook") ||
    lower.includes("market not found")
  ) {
    return "MARKET_CLOSED";
  }

  // Rate limiting
  if (
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("429")
  ) {
    return "RATE_LIMITED";
  }

  // Network errors
  if (
    lower.includes("network") ||
    lower.includes("connection") ||
    lower.includes("timeout") ||
    lower.includes("econnrefused")
  ) {
    return "NETWORK_ERROR";
  }

  return "UNKNOWN";
}

/**
 * Diagnostic info for order rejection logging
 */
export interface OrderRejectionDiagnostic {
  tokenId: string;
  marketId?: string;
  side: "BUY" | "SELL";
  sizeUsd?: number;
  shares?: number;
  bestBid?: number;
  bestAsk?: number;
  tickSize: number;
  tickSizeIsDefault: boolean;
  finalLimitPriceDollars: number;
  finalLimitPriceApiUnits: number;
  orderType: "FOK" | "GTC" | "FAK" | "GTD";
  postOnly?: boolean;
  errorCode?: string;
  errorMessage: string;
  rejectionClass: RejectionClass;
  timestamp: string;
}

/**
 * Log comprehensive order rejection diagnostic.
 * 
 * Produces a structured JSON log with all relevant context for debugging
 * ORDER_REJECTED errors.
 * 
 * @param diag - Diagnostic info to log
 */
export function logOrderRejection(diag: OrderRejectionDiagnostic): void {
  // Structured JSON log for machine parsing
  console.log(
    JSON.stringify({
      event: "ORDER_REJECTED_DIAGNOSTIC",
      ...diag,
    }),
  );

  // Human-readable summary
  console.error(
    `❌ [ORDER_REJECTED] ${diag.side} ${diag.sizeUsd?.toFixed(2) ?? "?"} USD | ` +
    `token=${diag.tokenId.slice(0, 12)}... | ` +
    `limit=${(diag.finalLimitPriceDollars * 100).toFixed(2)}¢ | ` +
    `bid=${diag.bestBid ? (diag.bestBid * 100).toFixed(2) : "?"}¢ ask=${diag.bestAsk ? (diag.bestAsk * 100).toFixed(2) : "?"}¢ | ` +
    `tick=${diag.tickSize}${diag.tickSizeIsDefault ? "(default)" : ""} | ` +
    `type=${diag.orderType} | ` +
    `class=${diag.rejectionClass} | ` +
    `error="${diag.errorMessage}"`,
  );
}
