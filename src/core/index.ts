/**
 * Core Module Index
 *
 * Core trading logic including strategy interface and risk management.
 * This module is the "brain" of the trading bot.
 */

// Strategy interface and types
export {
  type Strategy,
  type EntryDecision,
  type ExitDecision,
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
