/**
 * Auth Failure Rate Limiter
 *
 * De-duplicates and rate-limits repeated auth failure logs:
 * - Log full details the first time
 * - Suppress for a cooldown window (default: 5 minutes)
 * - Emit a single-line summary during suppression
 * - Track suppression counts in memory
 */

export interface AuthFailureKey {
  endpoint: string;
  status: number;
  signerAddress: string;
  signatureType: number;
}

interface RateLimitEntry {
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  suppressUntil: number;
  lastLoggedAt: number;
}

export interface RateLimitConfig {
  /** Initial cooldown window in milliseconds (default: 5 minutes) */
  initialCooldownMs?: number;
  /** Maximum cooldown window in milliseconds (default: 15 minutes) */
  maxCooldownMs?: number;
  /** Cooldown multiplier for repeated failures (default: 2) */
  cooldownMultiplier?: number;
}

const DEFAULT_CONFIG: Required<RateLimitConfig> = {
  initialCooldownMs: 5 * 60 * 1000, // 5 minutes
  maxCooldownMs: 15 * 60 * 1000, // 15 minutes
  cooldownMultiplier: 2,
};

/**
 * Result of checking if a failure should be logged
 */
export interface ShouldLogResult {
  /** Whether to log the full failure details */
  shouldLogFull: boolean;
  /** Whether to log a summary line (during suppression) */
  shouldLogSummary: boolean;
  /** Number of suppressed repeats */
  suppressedCount: number;
  /** Time until next full log (in minutes) */
  nextFullLogMinutes: number;
  /** Current cooldown period (in minutes) */
  cooldownMinutes: number;
}

/**
 * Rate limiter for auth failures
 */
export class AuthFailureRateLimiter {
  private entries: Map<string, RateLimitEntry> = new Map();
  private config: Required<RateLimitConfig>;

  constructor(config: RateLimitConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Create a unique key for this failure type
   */
  private createKey(failure: AuthFailureKey): string {
    return `${failure.endpoint}:${failure.status}:${failure.signerAddress}:${failure.signatureType}`;
  }

  /**
   * Check if a failure should be logged
   */
  shouldLog(failure: AuthFailureKey): ShouldLogResult {
    const key = this.createKey(failure);
    const now = Date.now();
    const entry = this.entries.get(key);

    if (!entry) {
      // First time seeing this failure - log full details
      this.entries.set(key, {
        firstSeenAt: now,
        lastSeenAt: now,
        count: 1,
        suppressUntil: now + this.config.initialCooldownMs,
        lastLoggedAt: now,
      });
      return {
        shouldLogFull: true,
        shouldLogSummary: false,
        suppressedCount: 0,
        nextFullLogMinutes: this.config.initialCooldownMs / 60000,
        cooldownMinutes: this.config.initialCooldownMs / 60000,
      };
    }

    // Update entry
    entry.lastSeenAt = now;
    entry.count++;

    // Check if still in suppression window
    if (now < entry.suppressUntil) {
      const nextFullLogMinutes = Math.ceil(
        (entry.suppressUntil - now) / 60000,
      );
      const cooldownMinutes = Math.ceil(
        (entry.suppressUntil - entry.lastLoggedAt) / 60000,
      );
      return {
        shouldLogFull: false,
        shouldLogSummary: true,
        suppressedCount: entry.count - 1,
        nextFullLogMinutes,
        cooldownMinutes,
      };
    }

    // Suppression window expired - log full details again
    const previousCooldown = entry.suppressUntil - entry.lastLoggedAt;
    const nextCooldown = Math.min(
      previousCooldown * this.config.cooldownMultiplier,
      this.config.maxCooldownMs,
    );

    entry.lastLoggedAt = now;
    entry.suppressUntil = now + nextCooldown;
    // Reset count after logging full details
    const suppressedCount = entry.count - 1;
    entry.count = 1;

    return {
      shouldLogFull: true,
      shouldLogSummary: false,
      suppressedCount,
      nextFullLogMinutes: nextCooldown / 60000,
      cooldownMinutes: nextCooldown / 60000,
    };
  }

  /**
   * Get suppression summary for a failure
   */
  getSummary(failure: AuthFailureKey): string {
    const result = this.shouldLog(failure);
    if (result.shouldLogFull) {
      return ""; // No suppression
    }
    return `Auth still failing (${failure.status} Invalid api key) — suppressed ${result.suppressedCount} repeats (next full log in ${result.nextFullLogMinutes}m)`;
  }

  /**
   * Reset the rate limiter (useful for testing)
   */
  reset(): void {
    this.entries.clear();
  }

  /**
   * Get the count of tracked entries
   */
  getEntryCount(): number {
    return this.entries.size;
  }
}

// Global singleton instance
let globalRateLimiter: AuthFailureRateLimiter | null = null;

/**
 * Get or create the global auth failure rate limiter
 */
export function getAuthFailureRateLimiter(): AuthFailureRateLimiter {
  if (!globalRateLimiter) {
    globalRateLimiter = new AuthFailureRateLimiter();
  }
  return globalRateLimiter;
}

/**
 * Reset the global rate limiter (for testing)
 */
export function resetAuthFailureRateLimiter(): void {
  if (globalRateLimiter) {
    globalRateLimiter.reset();
  }
  globalRateLimiter = null;
}
