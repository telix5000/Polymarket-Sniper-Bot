/**
 * Configuration Index - Re-exports all configuration utilities and types
 *
 * This module provides a clean API for configuration management:
 *
 * - env.ts: Environment variable parsing helpers
 * - schema.ts: Configuration type definitions
 *
 * Usage:
 *   import { envNum, envBool, envStr } from './config';
 *   import type { AppConfig, TradingConfig } from './config';
 */

// Environment variable parsing helpers
export {
  envNum,
  envBool,
  envStr,
  envEnum,
  envRequired,
  envList,
  parseOptionalFloatWithDefault,
} from "./env";

// Configuration schema types
export type {
  // Top-level config
  AppConfig,
  ConfigValidationError,

  // Sub-configs
  TradingConfig,
  PriceBandsConfig,
  HedgeConfig,
  LiquidityConfig,
  EvConfig,
  BiasConfig,
  ReserveConfig,
  PolReserveConfig,
  LiquidationConfig,
  ScannerConfig,
  OnChainConfig,
  WhaleFilterConfig,
  AuthConfig,
  TelegramConfig,
  PollingConfig,

  // Enums
  InfuraTier,
  LiquidationMode,
  LogLevel,
  BiasMode,
} from "./schema";
