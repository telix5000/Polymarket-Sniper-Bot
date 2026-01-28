/**
 * Trade Model - Represents trade signals and executed trades
 *
 * Trade signals are detected opportunities from whale activity or market events.
 * Executed trades are the actual transactions made by the bot.
 */

import type { OrderSide } from "./order";

/**
 * A trade signal detected from whale activity or market events
 */
export interface TradeSignal {
  /** The token ID being traded */
  tokenId: string;

  /** The condition ID from the CTF contract */
  conditionId: string;

  /** The market ID from Polymarket's API (optional) */
  marketId?: string;

  /** The outcome being traded (e.g., "YES" or "NO") */
  outcome: string;

  /** The side of the trade (BUY or SELL) */
  side: OrderSide;

  /** The size of the trade in USD */
  sizeUsd: number;

  /** The price of the trade (0-1) */
  price: number;

  /** The trader address that made the trade */
  trader: string;

  /** Unix timestamp of when the trade occurred */
  timestamp: number;
}

/**
 * Status of an executed trade
 */
export type TradeStatus = "success" | "failed" | "pending";

/**
 * Record of an executed trade for logging/display
 */
export interface ExecutedTrade {
  /** Timestamp string (HH:MM:SS format) */
  time: string;

  /** Market name/question */
  market: string;

  /** Trade side */
  side: OrderSide;

  /** Size in USD */
  size: number;

  /** Execution price (0-1) */
  price: number;

  /** Trade execution status */
  status: TradeStatus;
}

/**
 * Trading metrics summary
 */
export interface TradingMetrics {
  /** Total number of trades executed */
  totalTrades: number;

  /** Win rate as a decimal (0-1) */
  winRate: number;

  /** Total profit/loss in USD */
  totalPnl: number;

  /** Expected value in cents */
  evCents: number;
}
