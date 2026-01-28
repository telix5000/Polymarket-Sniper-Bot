/**
 * Infrastructure Index - Re-exports all infrastructure utilities
 *
 * Infrastructure modules provide cross-cutting concerns:
 *
 * - logging/: Structured logging and formatting utilities
 *
 * Future modules:
 * - persistence/: Data storage and caching
 * - telemetry/: Metrics and monitoring
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
