/**
 * V2 Types - All type definitions in one place
 *
 * BACKWARD COMPATIBILITY: These types are now defined in src/models/
 * and re-exported here for backward compatibility with existing code.
 *
 * For new code, prefer importing directly from '../models':
 *   import type { Position, OrderSide } from '../models';
 */

// Re-export all types from the models module for backward compatibility
export type {
  // Position types
  Position,
  PositionSummary,

  // Order types
  OrderSide,
  OrderOutcome,
  OrderResult,
  OrderType,
  OrderParams,

  // Trade types
  TradeSignal,
  TradeStatus,
  ExecutedTrade,
  TradingMetrics,

  // Whale types
  WhaleActivity,
  WhaleProfile,
  BiasDirection,
  BiasState,

  // Common types
  Preset,
  Logger,
  Result,
  WalletBalance,
  SystemMetrics,
} from "../models";
