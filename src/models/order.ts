/**
 * Order Model - Represents trading orders and their results
 *
 * Orders are instructions to buy or sell outcome tokens at specified prices.
 * This module defines the types for order parameters and execution results.
 */

/**
 * Order side - whether buying or selling
 */
export type OrderSide = "BUY" | "SELL";

/**
 * Order outcome - the market outcome being traded
 * @deprecated For new code, use outcomeLabel (string) to support non-YES/NO markets
 */
export type OrderOutcome = "YES" | "NO";

/**
 * Outcome label - supports any 2-outcome market (YES/NO, team names, etc.)
 */
export type OutcomeLabel = string;

/**
 * Result of an order execution attempt
 */
export interface OrderResult {
  /** Whether the order was successfully executed */
  success: boolean;

  /** Reason for failure (if success is false) */
  reason?: string;

  /** Amount filled in USD (for partial fills) */
  filledUsd?: number;

  /** Average fill price achieved */
  avgPrice?: number;

  /** Order ID from the exchange (if placed successfully) */
  orderId?: string;
}

/**
 * Order type for execution strategy
 */
export type OrderType = "FOK" | "GTC";

/**
 * Parameters for placing an order
 */
export interface OrderParams {
  /** Token ID to trade */
  tokenId: string;

  /** Side of the order */
  side: OrderSide;

  /** Size in USD */
  sizeUsd: number;

  /** Target price (0-1) */
  price: number;

  /** Order type (Fill-Or-Kill or Good-Til-Cancelled) */
  orderType?: OrderType;

  /** Slippage tolerance as percentage */
  slippagePct?: number;

  /** Expiration in seconds (for GTC orders) */
  expirationSeconds?: number;
}
