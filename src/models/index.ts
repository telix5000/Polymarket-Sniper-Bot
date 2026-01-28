/**
 * Models Index - Re-exports all domain model types
 *
 * This module provides a clean API for importing domain types used
 * throughout the application. All types are organized by domain:
 *
 * - Position: Trading position types
 * - Order: Order execution types
 * - Trade: Trade signal and execution types
 * - Whale: Whale activity tracking types
 * - Common: Shared types (Logger, Preset, etc.)
 */

// Position types
export type { Position, PositionSummary } from "./position";

// Order types
export type {
  OrderSide,
  OrderOutcome,
  OrderResult,
  OrderType,
  OrderParams,
} from "./order";

// Trade types
export type {
  TradeSignal,
  TradeStatus,
  ExecutedTrade,
  TradingMetrics,
} from "./trade";

// Whale types
export type {
  WhaleActivity,
  WhaleProfile,
  BiasDirection,
  BiasState,
} from "./whale";

// Common types
export type {
  Preset,
  Logger,
  Result,
  WalletBalance,
  SystemMetrics,
} from "./common";
