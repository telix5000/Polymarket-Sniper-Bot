/**
 * Log Deduplication Middleware
 *
 * Provides centralized log spam prevention across the entire codebase.
 * All log messages are automatically filtered through this middleware
 * to prevent repeated identical messages from flooding the output.
 *
 * Features:
 * - Message normalization (removes dynamic timestamps, addresses, durations)
 * - LRU cache for deduplication keys (configurable max size)
 * - Level-specific TTL defaults
 * - Fingerprint tracking for material changes
 * - Suppressed counter reporting
 * - Safe degradation (never throws from logging)
 */

import crypto from "node:crypto";

export type LogLevel = "error" | "warn" | "info" | "debug";

/**
 * Configuration for log deduplication
 */
export interface LogDedupeConfig {
  /** Enable/disable deduplication (default: true) */
  enabled: boolean;
  /** TTL in ms for DEBUG messages (default: 60000) */
  debugTtlMs: number;
  /** TTL in ms for INFO messages (default: 30000) */
  infoTtlMs: number;
  /** TTL in ms for WARN messages (default: 20000) */
  warnTtlMs: number;
  /** TTL in ms for ERROR messages - rate limit, not suppress (default: 10000) */
  errorTtlMs: number;
  /** Max cache entries before LRU eviction (default: 10000) */
  maxCacheSize: number;
}

/**
 * Internal entry tracking deduplication state
 */
interface DedupeEntry {
  /** Normalized key for deduplication */
  key: string;
  /** Hash of original message for material change detection */
  fingerprint: string;
  /** First time this key was seen in current TTL window */
  firstSeen: number;
  /** Last time this key was seen */
  lastSeen: number;
  /** Count of suppressed repeats */
  suppressedCount: number;
  /** Log level */
  level: LogLevel;
}

/**
 * Result from shouldEmit check
 */
export interface DedupeResult {
  /** Whether to emit the log message */
  emit: boolean;
  /** Optional suffix to append (e.g., "(suppressed X repeats)") */
  suffix?: string;
}

/**
 * Get default configuration from environment variables
 */
function getDefaultConfig(): LogDedupeConfig {
  const parseEnvInt = (key: string, defaultValue: number): number => {
    const value = process.env[key];
    if (!value) return defaultValue;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
  };

  const parseEnvBool = (key: string, defaultValue: boolean): boolean => {
    const value = process.env[key]?.toLowerCase();
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
    return defaultValue;
  };

  return {
    enabled: parseEnvBool("LOG_DEDUPE_ENABLED", true),
    debugTtlMs: parseEnvInt("LOG_DEDUPE_DEBUG_TTL_MS", 60000),
    infoTtlMs: parseEnvInt("LOG_DEDUPE_INFO_TTL_MS", 30000),
    warnTtlMs: parseEnvInt("LOG_DEDUPE_WARN_TTL_MS", 20000),
    errorTtlMs: parseEnvInt("LOG_DEDUPE_ERROR_TTL_MS", 10000),
    maxCacheSize: parseEnvInt("LOG_DEDUPE_MAX_CACHE_SIZE", 10000),
  };
}

/**
 * Normalize a message by replacing dynamic fragments with stable tokens.
 *
 * This ensures that messages differing only in timestamps, durations,
 * counters, or addresses are treated as duplicates.
 */
export function normalizeMessage(message: string): string {
  let normalized = message;

  // Replace ISO timestamps (2024-01-15T10:30:45.123Z or 2024-01-15 10:30:45)
  normalized = normalized.replace(
    /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
    "TIME",
  );

  // Replace Unix timestamps (10+ digit numbers that look like milliseconds or seconds)
  normalized = normalized.replace(/\b\d{10,13}\b/g, "TIMESTAMP");

  // Replace long hex addresses/hashes (0x followed by 16+ hex chars)
  normalized = normalized.replace(/0x[a-fA-F0-9]{16,}/g, "0x…");

  // Replace parenthesized durations like (27min), (5s), (123ms) FIRST
  // (before individual duration replacement)
  normalized = normalized.replace(/\(\d+(?:ms|s|min|h)\)/g, "(Xtime)");

  // Replace "in Xms" patterns like "checked in 1764ms" BEFORE individual duration replacement
  normalized = normalized.replace(/in \d+(?:ms|s)/gi, "in Xtime");

  // Replace "remaining Xs" patterns
  normalized = normalized.replace(
    /remaining \d+(?:ms|s|min|h)/gi,
    "remaining Xtime",
  );

  // Replace durations with units: Xms, Xs, Xmin, Xh (standalone)
  normalized = normalized.replace(/\b\d+ms\b/g, "Xms");
  normalized = normalized.replace(/\b\d+s\b/g, "Xs");
  normalized = normalized.replace(/\b\d+min\b/g, "Xmin");
  normalized = normalized.replace(/\b\d+h\b/g, "Xh");

  // Replace counter patterns like "Checked 17 address(es)" or "processed 5 items"
  normalized = normalized.replace(
    /\b\d+\s*(?:address(?:es)?|item(?:s)?|position(?:s)?|market(?:s)?|order(?:s)?)/gi,
    "N items",
  );

  // Replace percentages like "95.5%" or "100%"
  normalized = normalized.replace(/\b\d+(?:\.\d+)?%/g, "X%");

  // Replace currency amounts like "$123.45" or "1234.56 USDC"
  normalized = normalized.replace(/\$\d+(?:\.\d+)?/g, "$X");
  normalized = normalized.replace(
    /\b\d+(?:\.\d+)?\s*(?:USDC|USD|ETH|MATIC|POLY)/gi,
    "X CURRENCY",
  );

  // Replace large numeric IDs (8+ digits)
  normalized = normalized.replace(/\b\d{8,}\b/g, "…");

  // Replace block numbers like "block 12345678"
  normalized = normalized.replace(/block\s+\d+/gi, "block N");

  // Replace gas prices like "30 gwei" or "30gwei"
  normalized = normalized.replace(/\b\d+(?:\.\d+)?\s*gwei/gi, "X gwei");

  return normalized;
}

/**
 * Extract module tag from message prefix like [ScalpTakeProfit] or [AutoRedeem]
 */
export function extractModuleTag(message: string): string {
  const match = message.match(/^\[([^\]]+)\]/);
  return match ? match[1] : "GLOBAL";
}

/**
 * Create a fingerprint (hash) of the normalized message for material change detection.
 *
 * We use the normalized message so that messages differing only in dynamic
 * values (timestamps, counters, etc.) produce the same fingerprint and are
 * treated as duplicates. Only truly different message content will trigger
 * a material change.
 */
export function createFingerprint(message: string): string {
  const normalized = normalizeMessage(message);
  return crypto
    .createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Log Deduplication Middleware
 *
 * Call shouldEmit() before logging to determine if a message should be emitted.
 * The middleware handles all deduplication logic including:
 * - Checking if message is a repeat within TTL window
 * - Detecting material changes via fingerprint
 * - Tracking suppression counts
 * - LRU cache management
 */
export class LogDedupeMiddleware {
  private cache: Map<string, DedupeEntry>;
  private config: LogDedupeConfig;
  private accessOrder: string[]; // For LRU tracking

  constructor(config?: Partial<LogDedupeConfig>) {
    const defaultConfig = getDefaultConfig();
    this.config = { ...defaultConfig, ...config };
    this.cache = new Map();
    this.accessOrder = [];
  }

  /**
   * Get TTL for a specific log level
   */
  private getTtl(level: LogLevel): number {
    switch (level) {
      case "debug":
        return this.config.debugTtlMs;
      case "info":
        return this.config.infoTtlMs;
      case "warn":
        return this.config.warnTtlMs;
      case "error":
        return this.config.errorTtlMs;
      default:
        return this.config.infoTtlMs;
    }
  }

  /**
   * Create deduplication key from level, module tag, and normalized message
   */
  private createKey(level: LogLevel, message: string): string {
    const moduleTag = extractModuleTag(message);
    const normalized = normalizeMessage(message);
    return `${level}:${moduleTag}:${normalized}`;
  }

  /**
   * Update LRU access order
   */
  private updateAccessOrder(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
    this.accessOrder.push(key);
  }

  /**
   * Evict oldest entries if cache exceeds max size
   */
  private evictIfNeeded(): void {
    while (
      this.cache.size >= this.config.maxCacheSize &&
      this.accessOrder.length > 0
    ) {
      const oldestKey = this.accessOrder.shift();
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }
  }

  /**
   * Check if a log message should be emitted
   *
   * @param level - Log level (error, warn, info, debug)
   * @param message - Original log message
   * @returns DedupeResult with emit flag and optional suffix
   */
  shouldEmit(level: LogLevel, message: string): DedupeResult {
    // If deduplication is disabled, always emit
    if (!this.config.enabled) {
      return { emit: true };
    }

    try {
      const now = Date.now();
      const key = this.createKey(level, message);
      const fingerprint = createFingerprint(message);
      const ttl = this.getTtl(level);

      const existing = this.cache.get(key);

      if (!existing) {
        // First time seeing this key
        this.evictIfNeeded();
        this.cache.set(key, {
          key,
          fingerprint,
          firstSeen: now,
          lastSeen: now,
          suppressedCount: 0,
          level,
        });
        this.updateAccessOrder(key);
        return { emit: true };
      }

      // Check if TTL has expired
      const ttlExpired = now - existing.firstSeen >= ttl;

      // Check if content has materially changed (different fingerprint)
      const materialChange = existing.fingerprint !== fingerprint;

      if (ttlExpired || materialChange) {
        // TTL expired or content changed - emit with suppression count if any
        const suppressedCount = existing.suppressedCount;
        const suffix =
          suppressedCount > 0
            ? `(suppressed ${suppressedCount} repeats)`
            : undefined;

        // Reset entry
        existing.fingerprint = fingerprint;
        existing.firstSeen = now;
        existing.lastSeen = now;
        existing.suppressedCount = 0;

        this.updateAccessOrder(key);
        return { emit: true, suffix };
      }

      // Within TTL and same content - suppress
      existing.lastSeen = now;
      existing.suppressedCount++;
      this.updateAccessOrder(key);

      return { emit: false };
    } catch {
      // Safety: never throw from logger, degrade to allowing the log
      return { emit: true };
    }
  }

  /**
   * Get current cache size (for testing/monitoring)
   */
  getCacheSize(): number {
    return this.cache.size;
  }

  /**
   * Clear the cache (for testing)
   */
  clearCache(): void {
    this.cache.clear();
    this.accessOrder = [];
  }

  /**
   * Get current configuration (for testing)
   */
  getConfig(): Readonly<LogDedupeConfig> {
    return { ...this.config };
  }

  /**
   * Update configuration dynamically
   */
  updateConfig(config: Partial<LogDedupeConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// Global singleton instance
let globalDedupeInstance: LogDedupeMiddleware | null = null;

/**
 * Get or create the global LogDedupeMiddleware instance
 */
export function getLogDedupe(): LogDedupeMiddleware {
  if (!globalDedupeInstance) {
    globalDedupeInstance = new LogDedupeMiddleware();
  }
  return globalDedupeInstance;
}

/**
 * Reset the global LogDedupeMiddleware instance (for testing)
 */
export function resetLogDedupe(): void {
  if (globalDedupeInstance) {
    globalDedupeInstance.clearCache();
  }
  globalDedupeInstance = null;
}
