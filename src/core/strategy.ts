/**
 * Strategy Interface
 *
 * Defines the contract for trading strategies.
 * Strategies make decisions about when and how to trade based on market signals.
 */

import type { Position, TradeSignal } from "../models";

/**
 * Decision made by a strategy about whether to enter a position
 */
export interface EntryDecision {
  /** Whether entry is allowed */
  allowed: boolean;

  /** Reason for the decision */
  reason: string;

  /** Size factor (0-1) to scale the trade size */
  sizeFactor: number;

  /** Suggested price adjustment (if any) */
  priceAdjustment?: number;
}

/**
 * Decision made by a strategy about whether to exit a position
 */
export interface ExitDecision {
  /** Whether exit is recommended */
  shouldExit: boolean;

  /** Reason for the decision */
  reason: string;

  /** Exit type (take profit, stop loss, hedge, etc.) */
  exitType: "TAKE_PROFIT" | "STOP_LOSS" | "HEDGE" | "TIME_EXIT" | "MANUAL";

  /** Urgency level (0-1, higher = more urgent) */
  urgency: number;
}

/**
 * Market context for strategy decisions
 */
export interface MarketContext {
  /** Current price (0-1 decimal) */
  price: number;

  /** Bid-ask spread in cents */
  spreadCents: number;

  /** Available liquidity at current price (USD) */
  liquidityUsd: number;

  /** Recent price volatility */
  volatility?: number;

  /** Bias direction from whale flow */
  biasDirection?: "BULLISH" | "BEARISH" | "NEUTRAL";
}

/**
 * Strategy interface for making trading decisions
 */
export interface Strategy {
  /** Strategy name for logging */
  readonly name: string;

  /**
   * Decide whether to enter a position based on a trade signal
   */
  shouldEnter(
    signal: TradeSignal,
    context: MarketContext,
    currentPositions: Position[],
  ): EntryDecision;

  /**
   * Decide whether to exit an existing position
   */
  shouldExit(position: Position, context: MarketContext): ExitDecision;

  /**
   * Calculate the optimal trade size given constraints
   */
  calculateTradeSize(
    signal: TradeSignal,
    availableBankroll: number,
    maxTradeUsd: number,
  ): number;
}

/**
 * Configuration for the default EV-based strategy
 */
export interface EvStrategyConfig {
  /** Take profit target in cents */
  tpCents: number;

  /** Hedge trigger in cents of adverse movement */
  hedgeTriggerCents: number;

  /** Maximum adverse movement in cents (hard stop) */
  maxAdverseCents: number;

  /** Maximum hold time in seconds */
  maxHoldSeconds: number;

  /** Minimum entry price in cents */
  minEntryPriceCents: number;

  /** Maximum entry price in cents */
  maxEntryPriceCents: number;

  /** Minimum spread in cents */
  minSpreadCents: number;

  /** Minimum liquidity at exit price */
  minDepthUsdAtExit: number;
}
