/**
 * V2 Library - All exports
 *
 * This is the main entry point for the library. It re-exports all modules
 * for backward compatibility with existing code.
 *
 * NEW CODE should prefer importing directly from specific modules:
 *   import type { Position } from '../models';
 *   import { envNum } from '../config';
 *   import { createLogger } from '../infra';
 *   import { createClobClient } from '../services/polymarket';
 *   import type { Strategy } from '../core';
 */

// Types (now re-exported from models)
export * from "./types";

// Environment variable helpers from config module
// (Only export helpers that don't conflict with existing lib exports)
export {
  envNum,
  envBool,
  envStr,
  envEnum,
  envRequired,
  envList,
  parseOptionalFloatWithDefault,
} from "../config";

// Logging utilities from infra module
// (Only export utilities that don't conflict)
export {
  createLogger,
  createNullLogger,
  formatDuration,
  formatUptime,
  formatUsd,
  formatPriceCents,
  formatPnl,
  truncate,
  formatAddress,
} from "../infra";

// Core trading logic (strategy and risk management)
export {
  type Strategy,
  type EntryDecision,
  type ExitDecision,
  type MarketContext,
  type EvStrategyConfig,
  type RiskParams,
  calculateEffectiveBankroll,
  calculateTradeSize,
  checkPositionLimits,
  calculateDeployedCapital,
  checkDeploymentLimits,
} from "../core";

// Constants and presets
export * from "./constants";
export * from "./presets";

// Auth and balance
export * from "./auth";
export * from "./balance";
export * from "./positions";

// Order execution
export * from "./order";

// Notifications
export * from "./telegram";

// Targets and redemption
export * from "./targets";
export * from "./redeem";
export * from "./copy";

// VPN support
export * from "./vpn";

// POL reserve management
export * from "./pol-reserve";

// Utilities
export * from "./ethers-compat";
// Error handling is now in /infra (re-export for backward compatibility)
export * from "../infra/error-handling";
// Smart sell is now in /core (re-export for backward compatibility)
export * from "../core/smart-sell";

// On-chain monitoring
export * from "./onchain-monitor";

// Market utilities
export * from "./market";
// GitHub reporter is now in /infra (re-export for backward compatibility)
export * from "../infra/github-reporter";
// Latency monitor is now in /infra.
// NOTE: This is a BREAKING CHANGE for any deep imports of `src/lib/latency-monitor`.
// Consumers should now import from the barrel (`src/lib`) or from `../infra/latency-monitor`.
export * from "../infra/latency-monitor";

// WebSocket market data layer
export * from "./market-data-store";
export * from "./ws-market-client";
export * from "./ws-user-client";
export * from "./market-data-facade";

// Market scanner (simplified discovery)
export * from "./market-scanner";

// Dynamic EV and hedging (now in /core, re-export for backward compatibility)
export * from "../core/dynamic-ev-engine";
export * from "../core/dynamic-hedge-policy";

// Diagnostic mode
export * from "./diag-mode";
export * from "./diag-workflow";

// Price safety
export * from "./price-safety";
