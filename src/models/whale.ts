/**
 * Whale Model - Represents whale trader activity
 *
 * Whale activity tracking is used to detect large trades from successful traders
 * that the bot may want to copy or use as signals.
 */

import type { OrderSide } from "./order";

/**
 * A whale activity event detected from monitoring
 */
export interface WhaleActivity {
  /** Timestamp string (HH:MM:SS format) */
  time: string;

  /** The whale trader's wallet address */
  wallet: string;

  /** Market name/question */
  market: string;

  /** Trade side */
  side: OrderSide;

  /** Size in USD */
  size: number;

  /** Whether this activity was copied by the bot */
  copied: boolean;
}

/**
 * Whale trader profile for leaderboard tracking
 */
export interface WhaleProfile {
  /** Wallet address */
  address: string;

  /** Total volume traded in USD */
  totalVolume: number;

  /** Profit/loss in USD */
  pnl: number;

  /** Win rate as a decimal (0-1) */
  winRate: number;

  /** Number of trades */
  tradeCount: number;

  /** Last activity timestamp */
  lastActive: number;
}

/**
 * Bias direction from whale flow analysis
 */
export type BiasDirection = "BULLISH" | "BEARISH" | "NEUTRAL";

/**
 * Bias state from leaderboard flow analysis
 */
export interface BiasState {
  /** Current bias direction */
  direction: BiasDirection;

  /** Net USD flow (positive = buying, negative = selling) */
  netUsd: number;

  /** Number of trades contributing to the bias */
  tradeCount: number;

  /** Whether the bias is stale (older than threshold) */
  isStale: boolean;

  /** Timestamp of last update */
  lastUpdate: number;
}
