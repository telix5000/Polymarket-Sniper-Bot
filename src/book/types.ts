/**
 * Book Module Types - Shared types for orderbook resolution and health checking
 *
 * These types are used by both WHALE and SCAN flows for unified book handling.
 */

// ============================================================================
// Core Types
// ============================================================================

/**
 * Normalized price level with price and size
 */
export interface NormalizedLevel {
  price: number; // Decimal (0-1)
  size: number; // Size in shares/contracts
}

/**
 * Orderbook snapshot with metadata about the fetch
 */
export interface OrderBookSnapshot {
  /** Source of the orderbook data */
  source: "REST" | "WS_CACHE" | "ALT_REST";
  /** Token ID this book is for */
  tokenId: string;
  /** Optional market ID */
  marketId?: string | number;
  /** Normalized bid levels (sorted descending by price) */
  bids: NormalizedLevel[];
  /** Normalized ask levels (sorted ascending by price) */
  asks: NormalizedLevel[];
  /** Computed best bid price (decimal) */
  bestBid?: number;
  /** Computed best ask price (decimal) */
  bestAsk?: number;
  /** HTTP status code from REST fetch (if applicable) */
  httpStatus?: number;
  /** Latency in milliseconds for the fetch */
  latencyMs?: number;
  /** Whether parsing succeeded */
  parsedOk: boolean;
  /** Small descriptor of raw response shape (not full dump) */
  rawShape?: string;
  /** Error message if fetch failed */
  error?: string;
}

/**
 * Book health status enumeration for BookResolver
 * 
 * Note: This is distinct from BookHealthStatus in price-safety.ts which uses
 * different values ("HEALTHY", "DEAD_BOOK"). This type is specific to the
 * BookResolver module and includes more granular status values.
 */
export type BookResolverHealthStatus =
  | "OK"
  | "EMPTY_BOOK"
  | "DUST_BOOK"
  | "WIDE_SPREAD"
  | "ASK_TOO_HIGH"
  | "NO_DATA"
  | "PARSE_ERROR";

/**
 * Book health evaluation result
 */
export interface BookHealth {
  /** Whether the book is healthy enough to trade */
  healthy: boolean;
  /** Status classification */
  status: BookResolverHealthStatus;
  /** Human-readable reason for the status */
  reason: string;
  /** Best bid in cents */
  bestBidCents: number;
  /** Best ask in cents */
  bestAskCents: number;
  /** Spread in cents */
  spreadCents: number;
  /** Number of bid levels */
  bidsLen: number;
  /** Number of ask levels */
  asksLen: number;
}

/**
 * Input parameters for resolving a healthy book
 */
export interface ResolveBookParams {
  /** The token ID to fetch */
  tokenId: string;
  /** Optional market ID for additional context */
  marketId?: string | number;
  /** Optional condition ID for the market */
  conditionId?: string;
  /** Optional outcome index (0 or 1) */
  outcomeIdx?: number;
  /** Hint about caller (for logging) */
  flow: "whale" | "scan";
  /** Optional maximum spread in cents to consider healthy */
  maxSpreadCents?: number;
}

/**
 * Result from resolving a healthy book
 */
export interface ResolveBookResult {
  /** Whether a healthy book was found */
  success: boolean;
  /** The orderbook snapshot (may be present even if not healthy) */
  snapshot?: OrderBookSnapshot;
  /** Book health evaluation */
  health: BookHealth;
  /** Whether cross-check was performed */
  crossChecked: boolean;
  /** Cross-check source if performed */
  crossCheckSource?: "WS_CACHE" | "ALT_REST";
  /** Cross-check result if performed */
  crossCheckHealth?: BookHealth;
}

// ============================================================================
// Thresholds (Re-export from price-safety for consistency)
// ============================================================================

import { DEAD_BOOK_THRESHOLDS, DEFAULT_MAX_SPREAD_CENTS } from "../lib/price-safety";

/**
 * Unified thresholds for book health evaluation
 * Both WHALE and SCAN flows use these same thresholds
 * 
 * Re-exports from price-safety.ts to maintain single source of truth
 */
export const BOOK_THRESHOLDS = {
  /** Maximum bid for dust book classification (cents) */
  DUST_BID_CENTS: DEAD_BOOK_THRESHOLDS.DEAD_BID_CENTS,
  /** Minimum ask for dust book classification (cents) */
  DUST_ASK_CENTS: DEAD_BOOK_THRESHOLDS.DEAD_ASK_CENTS,
  /** Maximum bid for empty book classification (cents) */
  EMPTY_BID_CENTS: DEAD_BOOK_THRESHOLDS.EMPTY_BID_CENTS,
  /** Minimum ask for empty book classification (cents) */
  EMPTY_ASK_CENTS: DEAD_BOOK_THRESHOLDS.EMPTY_ASK_CENTS,
  /** Default maximum spread (cents) for healthy book */
  DEFAULT_MAX_SPREAD_CENTS,
  /** Maximum ask price (cents) to consider healthy */
  MAX_ASK_CENTS: 95,
} as const;
