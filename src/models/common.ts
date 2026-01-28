/**
 * Common Models - Shared types used across the application
 *
 * These are fundamental types that don't belong to a specific domain
 * but are used throughout the application.
 */

/**
 * Trading preset levels for risk management
 */
export type Preset = "conservative" | "balanced" | "aggressive";

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
 * Generic result type for operations that can succeed or fail
 */
export interface Result<T> {
  /** Whether the operation succeeded */
  success: boolean;

  /** The result data (if successful) */
  data?: T;

  /** Error message (if failed) */
  error?: string;
}

/**
 * Wallet balance information
 */
export interface WalletBalance {
  /** USDC balance in USD */
  usdcBalance: number;

  /** POL balance (for gas) */
  polBalance: number;

  /** Effective bankroll (USDC - reserves) */
  effectiveBankroll: number;

  /** Reserved amount in USD */
  reserveUsd: number;
}

/**
 * System metrics for monitoring
 */
export interface SystemMetrics {
  /** Bot uptime in seconds */
  uptime: number;

  /** Timestamp of last whale signal */
  lastWhaleSignal: number;

  /** API latency in milliseconds */
  apiLatencyMs: number;

  /** Whether WebSocket is connected */
  wsConnected: boolean;
}
