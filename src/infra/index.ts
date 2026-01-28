/**
 * Infrastructure Index - Re-exports all infrastructure utilities
 *
 * Infrastructure modules provide cross-cutting concerns:
 *
 * - logging/: Structured logging and formatting utilities
 * - persistence/: Data storage and caching with health checks
 */

// Logging utilities
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
} from "./logging";

export type { LogLevel, LoggerConfig, Logger } from "./logging";

// Persistence utilities
export {
  // Types
  createLogContext,
  formatLogContext,
  // Base store
  BaseStore,
  // Market cache
  MarketCache,
  getMarketCache,
  initMarketCache,
  clearMarketCache,
  getMarketCacheStats,
  // Position store
  PositionStore,
  getPositionStore,
  initPositionStore,
  // Store registry
  StoreRegistry,
  getStoreRegistry,
  initStoreRegistry,
} from "./persistence";

export type {
  // Types
  HealthStatus,
  HealthCheckable,
  StoreMetricsBase,
  MetricsReportable,
  Store,
  StoreOptions,
  LogContext,
  // Base store
  BaseStoreMetrics,
  // Market cache
  MarketTokenPair,
  MarketCacheMetrics,
  // Position store
  StoredPosition,
  PositionStoreMetrics,
  // Store registry
  AggregatedHealthStatus,
  AggregatedMetrics,
} from "./persistence";
