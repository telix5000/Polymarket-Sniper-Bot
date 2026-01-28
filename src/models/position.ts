/**
 * Position Model - Represents a trading position in a market
 *
 * A position tracks the user's holdings in a specific market outcome token,
 * including entry price, current value, and profit/loss metrics.
 */

/**
 * Represents a trading position in a Polymarket outcome token
 */
export interface Position {
  /** The ERC1155 token ID for this position */
  tokenId: string;

  /** The condition ID from the CTF contract */
  conditionId: string;

  /** The market ID from Polymarket's API (optional) */
  marketId?: string;

  /** The outcome this position represents (e.g., "YES" or "NO") */
  outcome: string;

  /** Size of the position in shares */
  size: number;

  /** Average entry price as a decimal (0-1, where 0.50 = 50 cents) */
  avgPrice: number;

  /** Current market price as a decimal (0-1, where 0.50 = 50 cents) */
  curPrice: number;

  /** Profit/loss as a percentage */
  pnlPct: number;

  /** Profit/loss in USD */
  pnlUsd: number;

  /** Gain in cents (curPrice - avgPrice) * 100 */
  gainCents: number;

  /** Current position value in USD (size * curPrice) */
  value: number;

  /** Unix timestamp of when the position was entered (optional) */
  entryTime?: number;

  /** Last recorded price (for tracking price movement) */
  lastPrice?: number;

  /** Historical price data for the position */
  priceHistory?: number[];

  /** Unix timestamp of when the market ends (optional) */
  marketEndTime?: number;
}

/**
 * Position summary for tracking deployed capital
 */
export interface PositionSummary {
  /** Total number of open positions */
  openPositions: number;

  /** Maximum allowed positions */
  maxPositions: number;

  /** Total USD deployed across all positions */
  deployedUsd: number;

  /** Percentage of bankroll deployed */
  deployedPercent: number;
}
