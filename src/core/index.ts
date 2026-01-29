/**
 * Core Module Index
 *
 * Core trading logic including strategy interface and risk management.
 * This module is the "brain" of the trading bot.
 *
 * Available exports:
 * - Strategy interface and types (strategy.ts)
 * - Risk management utilities (risk.ts)
 * - Decision engine for trade evaluation (decision-engine.ts)
 * - EV tracker for performance monitoring (ev-tracker.ts)
 */

// Strategy interface and types
export {
  type Strategy,
  type EntryDecision as StrategyEntryDecision,
  type ExitDecision as StrategyExitDecision,
  type MarketContext,
  type EvStrategyConfig,
} from "./strategy";

// Risk management utilities
export {
  type RiskParams,
  calculateEffectiveBankroll,
  calculateTradeSize,
  checkPositionLimits,
  calculateDeployedCapital,
  checkDeploymentLimits,
} from "./risk";

// Decision engine types and class
export {
  type OrderbookState,
  type MarketActivity,
  type BiasDirection,
  type PositionState,
  type ExitReason,
  type HedgeLeg,
  type StateTransition,
  type ManagedPosition,
  type EvMetrics,
  type EntryDecision,
  type ExitDecision,
  type DecisionEngineConfig,
  DecisionEngine,
} from "./decision-engine";

// EV tracker types and class
export {
  type TradeResult,
  type EvTrackerConfig,
  DEFAULT_EV_TRACKER_CONFIG,
  calculatePnlCents,
  calculatePnlUsd,
  createTradeResult,
  EvTracker,
} from "./ev-tracker";

// Smart sell - intelligent sell order execution (moved from /lib)
export {
  analyzeLiquidity,
  calculateOptimalSlippage,
  determineOrderType,
  smartSell,
  checkSellProfitability,
  getSellRecommendation,
} from "./smart-sell";

export type {
  OrderBookLevel,
  LiquidityAnalysis,
  SmartSellConfig,
  SmartSellResult,
} from "./smart-sell";

// Dynamic EV Engine - adaptive expected value calculation (moved from /lib)
export {
  EV_DEFAULTS,
  DEFAULT_DYNAMIC_EV_CONFIG,
  DynamicEvEngine,
  createDynamicEvEngine,
} from "./dynamic-ev-engine";

export type {
  DynamicEvConfig,
  TradeOutcome,
  ChurnObservation,
  DynamicEvMetrics,
  EntryDecisionResult,
  OperationalCheck,
} from "./dynamic-ev-engine";

// Dynamic Hedge Policy - adaptive hedge parameter management (moved from /lib)
export {
  HEDGE_DEFAULTS,
  DEFAULT_DYNAMIC_HEDGE_CONFIG,
  DynamicHedgePolicy,
  createDynamicHedgePolicy,
} from "./dynamic-hedge-policy";

export type {
  DynamicHedgeConfig,
  PriceObservation,
  AdverseMoveObservation,
  HedgeOutcome,
  DynamicHedgeParameters,
  HedgeDecision,
} from "./dynamic-hedge-policy";

// Execution Engine - order execution for entries and exits (extracted from start.ts)
export {
  ExecutionEngine,
  type ExecutionResult,
  type TokenMarketData,
  type ChurnLogger,
  type ExecutionEngineConfig,
  type BiasAccumulatorInterface,
  type PositionManagerInterface,
} from "./execution-engine";

// Position Manager - position lifecycle tracking (extracted from start.ts)
export {
  PositionManager,
  type PositionManagerConfig,
} from "./position-manager";

// Reserve Manager - dynamic reserve management (extracted from start.ts)
export {
  DynamicReserveManager,
  type ReserveManagerConfig,
  type MissedOpportunity,
  type DynamicReserveState,
} from "./reserve-manager";

// ChurnEngine - main trading orchestrator (extracted from start.ts)
export {
  ChurnEngine,
  SimpleLogger,
  type ChurnConfig,
  type ChurnEngineDeps,
} from "./churn-engine";
