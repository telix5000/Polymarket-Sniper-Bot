/**
 * Churn Engine - Main Module
 *
 * Exports all churn engine components.
 * This is a deterministic, math-driven trading system.
 *
 * Core Philosophy:
 * - We do NOT predict outcomes
 * - We only trade when EV is positive
 * - Losses are capped, no exceptions
 * - If edge disappears, bot pauses itself
 */

// Configuration
export {
  type ChurnConfig,
  type ValidationError,
  loadConfig,
  validateConfig,
  logConfig,
  calculateEffectiveBankroll,
  calculateTradeSize,
} from "./config";

// EV Metrics
export {
  type TradeResult,
  type EvMetrics,
  EvTracker,
  calculatePnlCents,
  calculatePnlUsd,
  createTradeResult,
} from "./ev-metrics";

// Bias Accumulator
export {
  type BiasDirection,
  type LeaderboardTrade,
  type TokenBias,
  type BiasChangeEvent,
  BiasAccumulator,
} from "./bias";

// State Machine
export {
  type PositionState,
  type ExitReason,
  type HedgeLeg,
  type StateTransition,
  type ManagedPosition,
  type PositionManagerConfig,
  PositionManager,
} from "./state-machine";

// Decision Engine
export {
  type OrderbookState,
  type MarketActivity,
  type EntryDecision,
  type ExitDecision,
  DecisionEngine,
} from "./decision-engine";

// Execution Engine
export {
  type ExecutionResult,
  type TokenMarketData,
  type ChurnLogger,
  SimpleLogger,
  ExecutionEngine,
} from "./execution";
