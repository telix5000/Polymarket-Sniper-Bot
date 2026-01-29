// ═══════════════════════════════════════════════════════════════════════════
// MARKET DATA FETCH RESULT TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** Reason codes for market data fetch failures */
export type MarketDataFailureReason =
  | "NO_ORDERBOOK" // Market closed/settled, no orderbook exists
  | "NOT_FOUND" // Token ID not found in system
  | "RATE_LIMIT" // API rate limit hit
  | "NETWORK_ERROR" // Network/connection failure
  | "PARSE_ERROR" // Response parsing failed
  | "INVALID_LIQUIDITY" // Spread too wide (permanent market condition)
  | "DUST_BOOK" // 1¢/99¢ spreads - no room to trade (permanent)
  | "INVALID_PRICES"; // Missing/zero/NaN prices (permanent)

/** Check if failure reason warrants long cooldown (market legitimately inactive) */
export function shouldApplyLongCooldown(
  reason: MarketDataFailureReason,
): boolean {
  return reason === "NO_ORDERBOOK" || reason === "NOT_FOUND";
}

// ═══════════════════════════════════════════════════════════════════════════
// MARKET DATA COOLDOWN MANAGER - Exponential backoff for inactive markets
// ═══════════════════════════════════════════════════════════════════════════

export interface CooldownEntry {
  strikes: number; // Consecutive failures
  nextEligibleTime: number; // Timestamp when retry is allowed
  lastReason: MarketDataFailureReason;
}

export interface CooldownStats {
  cooldownHits: number; // Total times a token was blocked by cooldown
  totalTokensCooledDown: number; // Total times tokens have been put into cooldown since start (may count the same token multiple times)
  resolvedLaterCount: number; // Tokens that succeeded after being in cooldown
}

export class MarketDataCooldownManager {
  // Backoff schedule: 10m, 30m, 2h, 24h cap
  private static readonly BACKOFF_SCHEDULE_MS = [
    10 * 60 * 1000, // 10 minutes
    30 * 60 * 1000, // 30 minutes
    2 * 60 * 60 * 1000, // 2 hours
    24 * 60 * 60 * 1000, // 24 hours (cap)
  ];

  private cooldowns = new Map<string, CooldownEntry>();
  private stats: CooldownStats = {
    cooldownHits: 0,
    totalTokensCooledDown: 0,
    resolvedLaterCount: 0,
  };

  /**
   * Check if a token is currently on cooldown
   * @returns true if blocked, false if eligible for retry
   */
  isOnCooldown(tokenId: string): boolean {
    const entry = this.cooldowns.get(tokenId);
    if (!entry) return false;

    const now = Date.now();
    if (now >= entry.nextEligibleTime) {
      return false; // Cooldown expired, eligible for retry
    }

    this.stats.cooldownHits++;
    return true;
  }

  /**
   * Record a failure and apply exponential backoff
   * Only applies long cooldown for NO_ORDERBOOK/NOT_FOUND
   * Transient errors (RATE_LIMIT, NETWORK_ERROR, PARSE_ERROR) use short cooldown
   * but don't reset existing strikes from long-cooldown failures
   */
  recordFailure(tokenId: string, reason: MarketDataFailureReason): number {
    const now = Date.now();
    const existing = this.cooldowns.get(tokenId);

    // For transient errors (RATE_LIMIT, NETWORK_ERROR, PARSE_ERROR), use short 30s cooldown
    // Preserve existing strikes only if they came from long-cooldown failures (strikes > 1)
    if (!shouldApplyLongCooldown(reason)) {
      const shortCooldownMs = 30 * 1000; // 30 seconds
      // If we have strikes > 1, it means previous long-cooldown failures occurred - preserve them
      // Otherwise, keep strikes at 1 (no accumulation for transient errors)
      const preservedStrikes =
        existing && existing.strikes > 1 ? existing.strikes : 1;
      this.cooldowns.set(tokenId, {
        strikes: preservedStrikes,
        nextEligibleTime: now + shortCooldownMs,
        lastReason: reason,
      });
      return shortCooldownMs;
    }

    // For NO_ORDERBOOK/NOT_FOUND, apply exponential backoff
    // Increment strikes only if:
    // 1. strikes > 1 (we have accumulated long-cooldown failures), OR
    // 2. The previous failure was a long-cooldown type (meaning we're at strike 1 from that)
    // This ensures transient-only tokens start fresh when they first get a long-cooldown failure
    const shouldIncrement =
      existing &&
      (existing.strikes > 1 || shouldApplyLongCooldown(existing.lastReason));
    const strikes = shouldIncrement ? existing.strikes + 1 : 1;
    const backoffIndex = Math.min(
      strikes - 1,
      MarketDataCooldownManager.BACKOFF_SCHEDULE_MS.length - 1,
    );
    const cooldownMs =
      MarketDataCooldownManager.BACKOFF_SCHEDULE_MS[backoffIndex];

    const wasNew = !this.cooldowns.has(tokenId);
    this.cooldowns.set(tokenId, {
      strikes,
      nextEligibleTime: now + cooldownMs,
      lastReason: reason,
    });

    if (wasNew) {
      this.stats.totalTokensCooledDown++;
    }

    return cooldownMs;
  }

  /**
   * Record a successful fetch - reset backoff for the token
   */
  recordSuccess(tokenId: string): void {
    if (this.cooldowns.has(tokenId)) {
      this.stats.resolvedLaterCount++;
      this.cooldowns.delete(tokenId);
    }
  }

  /**
   * Get cooldown info for a token (for logging)
   */
  getCooldownInfo(tokenId: string): {
    strikes: number;
    nextEligibleTime: number;
    lastReason: MarketDataFailureReason;
  } | null {
    return this.cooldowns.get(tokenId) || null;
  }

  /**
   * Get current stats
   */
  getStats(): CooldownStats {
    return { ...this.stats };
  }

  /**
   * Get count of tokens currently on cooldown
   */
  getActiveCooldownCount(): number {
    const now = Date.now();
    let count = 0;
    for (const entry of this.cooldowns.values()) {
      if (now < entry.nextEligibleTime) count++;
    }
    return count;
  }

  /**
   * Clean up expired cooldowns (call periodically)
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [tokenId, entry] of this.cooldowns.entries()) {
      // Remove entries that have been expired for more than 1 hour
      if (now > entry.nextEligibleTime + 60 * 60 * 1000) {
        this.cooldowns.delete(tokenId);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Format cooldown duration for logging
   */
  static formatDuration(ms: number): string {
    if (ms < 60 * 1000) return `${Math.round(ms / 1000)}s`;
    if (ms < 60 * 60 * 1000) return `${Math.round(ms / 60 / 1000)}m`;
    return `${(ms / 60 / 60 / 1000).toFixed(1)}h`;
  }
}
