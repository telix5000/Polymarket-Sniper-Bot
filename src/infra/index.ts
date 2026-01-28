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

// Error handling utilities (moved from /lib for better architecture)
export {
  ErrorCode,
  isCloudflareBlock,
  parseError,
  formatErrorForLog,
  isRateLimited,
  detectCloudflareBlock,
  ghErrorAnnotation,
  ghWarningAnnotation,
  setVpnStatusGetter,
  emitCloudflareBlockEvent,
  mapErrorToDiagReason,
} from "./error-handling";

export type {
  ParsedError,
  CloudflareBlockInfo,
  CloudflareBlockEvent,
} from "./error-handling";

// Latency monitoring (moved from /lib for better architecture)
export {
  LatencyMonitor,
  getLatencyMonitor,
  initLatencyMonitor,
} from "./latency-monitor";

export type {
  LatencyMeasurement,
  LatencyStats,
  NetworkHealth,
  LatencyMonitorConfig,
} from "./latency-monitor";

// GitHub error reporter (moved from /lib for better architecture)
export {
  GitHubReporter,
  getGitHubReporter,
  initGitHubReporter,
  reportError,
  writeDiagTraceEvent,
  getDiagTracePath,
  writeDiagWorkflowTrace,
} from "./github-reporter";

export type {
  ErrorSeverity,
  ErrorReport,
  GitHubReporterConfig,
} from "./github-reporter";
