/**
 * Persistence Types - Common interfaces for all storage implementations
 *
 * These interfaces define a consistent API for:
 * - Storing and retrieving data
 * - Health checks and metrics
 * - Lifecycle management
 */

// ============================================================================
// Health Check Types
// ============================================================================

/** Result of a health check */
export interface HealthStatus {
  /** Whether the store is healthy */
  healthy: boolean;

  /** Human-readable status message */
  message: string;

  /** Optional additional details */
  details?: Record<string, unknown>;

  /** Timestamp of the check */
  checkedAt: number;
}

/** Interface for components that support health checks */
export interface HealthCheckable {
  /** Perform a health check */
  healthCheck(): HealthStatus;

  /** Get the name of this component (for logging) */
  getName(): string;
}

// ============================================================================
// Metrics Types
// ============================================================================

/** Common metrics that all stores should report */
export interface StoreMetricsBase {
  /** Number of entries in the store */
  entryCount: number;

  /** Number of cache hits */
  hits: number;

  /** Number of cache misses */
  misses: number;

  /** Hit ratio (0-1) */
  hitRatio: number;

  /** Timestamp of last update */
  lastUpdateAt: number;
}

/** Interface for components that report metrics */
export interface MetricsReportable<
  T extends StoreMetricsBase = StoreMetricsBase,
> {
  /** Get current metrics */
  getMetrics(): T;

  /** Reset metrics counters */
  resetMetrics(): void;
}

// ============================================================================
// Store Types
// ============================================================================

/** Options for store operations */
export interface StoreOptions {
  /** Maximum number of entries (for memory protection) */
  maxEntries?: number;

  /** TTL for entries in milliseconds */
  ttlMs?: number;

  /** Whether to track metrics */
  trackMetrics?: boolean;
}

/** Base interface for all stores */
export interface Store<K, V> extends HealthCheckable {
  /** Get a value by key */
  get(key: K): V | null;

  /** Check if a key exists */
  has(key: K): boolean;

  /** Set a value */
  set(key: K, value: V): void;

  /** Delete a value */
  delete(key: K): boolean;

  /** Clear all entries */
  clear(): void;

  /** Get all keys */
  keys(): K[];

  /** Get the number of entries */
  size(): number;
}

// ============================================================================
// Logging Context Types
// ============================================================================

/** Standard fields for structured logging */
export interface LogContext {
  /** Component/module name */
  component: string;

  /** Operation being performed */
  operation?: string;

  /** Duration of operation in ms */
  durationMs?: number;

  /** Whether operation succeeded */
  success?: boolean;

  /** Error message if failed */
  error?: string;

  /** Additional context fields */
  [key: string]: unknown;
}

/** Creates a log context with standard fields */
export function createLogContext(
  component: string,
  operation?: string,
  extra?: Record<string, unknown>,
): LogContext {
  return {
    component,
    operation,
    ...extra,
  };
}

/** Format a log context for console output */
export function formatLogContext(ctx: LogContext): string {
  const parts: string[] = [`[${ctx.component}]`];

  if (ctx.operation) {
    parts.push(ctx.operation);
  }

  if (ctx.durationMs !== undefined) {
    parts.push(`(${ctx.durationMs}ms)`);
  }

  if (ctx.success !== undefined) {
    parts.push(ctx.success ? "✓" : "✗");
  }

  if (ctx.error) {
    parts.push(`- ${ctx.error}`);
  }

  return parts.join(" ");
}
