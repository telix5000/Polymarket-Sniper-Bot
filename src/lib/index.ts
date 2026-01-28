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
export * from "./scavenger";
export * from "./ethers-compat";
export * from "./error-handling";
export * from "./smart-sell";

// On-chain monitoring
export * from "./onchain-monitor";

// Market utilities
export * from "./market";
export * from "./github-reporter";
export * from "./latency-monitor";

// WebSocket market data layer
export * from "./market-data-store";
export * from "./ws-market-client";
export * from "./ws-user-client";
export * from "./market-data-facade";

// Market scanner (simplified discovery)
export * from "./market-scanner";

// Dynamic EV and hedging
export * from "./dynamic-ev-engine";
export * from "./dynamic-hedge-policy";
