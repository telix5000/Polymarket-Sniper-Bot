/**
 * Logging Infrastructure
 *
 * Provides a consistent logging interface and utilities for the application.
 * This module defines the Logger interface and provides additional
 * logging utilities for structured output.
 */

/**
 * Logger interface for consistent logging across the application
 */
export interface Logger {
  /** Log informational message */
  info(msg: string): void;

  /** Log warning message */
  warn(msg: string): void;

  /** Log error message */
  error(msg: string): void;

  /** Log debug message (optional) */
  debug?(msg: string): void;
}

/**
 * Log levels for filtering output
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Log level priority for filtering
 */
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Configuration for creating a logger
 */
export interface LoggerConfig {
  /** Minimum log level to output */
  level?: LogLevel;

  /** Prefix for all log messages */
  prefix?: string;

  /** Whether to include timestamps */
  includeTimestamp?: boolean;
}

/**
 * Create a console-based logger with optional configuration
 *
 * @param config - Logger configuration
 * @returns Logger instance
 */
export function createLogger(config: LoggerConfig = {}): Logger {
  const { level = "info", prefix = "", includeTimestamp = false } = config;

  const minPriority = LOG_LEVEL_PRIORITY[level];

  const formatMessage = (msg: string): string => {
    const parts: string[] = [];

    if (includeTimestamp) {
      parts.push(new Date().toISOString());
    }

    if (prefix) {
      parts.push(`[${prefix}]`);
    }

    parts.push(msg);
    return parts.join(" ");
  };

  const shouldLog = (msgLevel: LogLevel): boolean => {
    return LOG_LEVEL_PRIORITY[msgLevel] >= minPriority;
  };

  return {
    debug(msg: string): void {
      if (shouldLog("debug")) {
        console.log(formatMessage(`🔍 ${msg}`));
      }
    },

    info(msg: string): void {
      if (shouldLog("info")) {
        console.log(formatMessage(msg));
      }
    },

    warn(msg: string): void {
      if (shouldLog("warn")) {
        console.warn(formatMessage(`⚠️ ${msg}`));
      }
    },

    error(msg: string): void {
      if (shouldLog("error")) {
        console.error(formatMessage(`❌ ${msg}`));
      }
    },
  };
}

/**
 * Create a no-op logger that discards all output
 * Useful for testing or when logging should be suppressed
 */
export function createNullLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/**
 * Format a duration in milliseconds to a human-readable string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  } else if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  } else if (ms < 3600000) {
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return `${mins}m ${secs}s`;
  } else {
    const hours = Math.floor(ms / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    return `${hours}h ${mins}m`;
  }
}

/**
 * Format uptime from a start timestamp to HH:MM:SS
 */
export function formatUptime(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Format a number as USD currency
 */
export function formatUsd(amount: number): string {
  const sign = amount >= 0 ? "" : "-";
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

/**
 * Format a price in cents (0-1 decimal to XX¢)
 */
export function formatPriceCents(price: number): string {
  return `${(price * 100).toFixed(0)}¢`;
}

/**
 * Format P&L with sign and color indicator
 */
export function formatPnl(pnl: number): string {
  const sign = pnl >= 0 ? "+" : "";
  return `${sign}$${pnl.toFixed(2)}`;
}

/**
 * Truncate a string to a maximum length with ellipsis
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + "...";
}

/**
 * Format a wallet address for display (first 8 chars + ...)
 */
export function formatAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.substring(0, 10)}...`;
}
