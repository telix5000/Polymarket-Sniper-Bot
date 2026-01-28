/**
 * MarketCache - Consolidated cache for market token pairs
 *
 * This wraps the existing market caching logic from lib/market.ts
 * with a consistent Store interface, health checks, and metrics.
 *
 * Features:
 * - Caches market data by token ID and condition ID
 * - TTL-based expiration (default: 1 hour)
 * - LRU eviction for memory protection
 * - Health checks and metrics
 */

import { BaseStore, type BaseStoreMetrics } from "./base-store";
import type { HealthStatus } from "./types";

// ============================================================================
// Types
// ============================================================================

/** Market token pair data */
export interface MarketTokenPair {
  yesTokenId: string;
  noTokenId: string;
  conditionId: string;
  marketId: string;
  question?: string;
  endDate?: string;
  active?: boolean;
}

/** Extended metrics for MarketCache */
export interface MarketCacheMetrics extends BaseStoreMetrics {
  /** Number of unique markets cached */
  marketCount: number;

  /** Number of token ID lookups */
  tokenLookups: number;

  /** Number of condition ID lookups */
  conditionLookups: number;
}

// ============================================================================
// MarketCache Implementation
// ============================================================================

/**
 * Cache for market token pairs with multi-key indexing
 *
 * Stores markets indexed by both token IDs and condition ID for fast lookups.
 */
export class MarketCache extends BaseStore<string, MarketTokenPair> {
  // Secondary index: condition ID -> market
  private conditionIndex = new Map<string, MarketTokenPair>();

  // Additional metrics
  private tokenLookups = 0;
  private conditionLookups = 0;

  constructor(options?: { maxEntries?: number; ttlMs?: number }) {
    super("MarketCache", {
      maxEntries: options?.maxEntries ?? 2000, // 2000 markets (4000 token entries)
      ttlMs: options?.ttlMs ?? 60 * 60 * 1000, // 1 hour TTL
      trackMetrics: true,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Market-Specific Operations
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Cache a market with both token IDs as keys
   */
  cacheMarket(market: MarketTokenPair): void {
    // Store by YES token ID
    this.set(market.yesTokenId, market);

    // Store by NO token ID (duplicate reference is fine, same TTL)
    this.set(market.noTokenId, market);

    // Store in condition index
    this.conditionIndex.set(market.conditionId, market);
  }

  /**
   * Get market by token ID (YES or NO)
   */
  getByTokenId(tokenId: string): MarketTokenPair | null {
    this.tokenLookups++;
    return this.get(tokenId);
  }

  /**
   * Get market by condition ID
   */
  getByConditionId(conditionId: string): MarketTokenPair | null {
    this.conditionLookups++;

    const market = this.conditionIndex.get(conditionId);
    if (!market) return null;

    // Check if still in main store (handles TTL)
    if (!this.has(market.yesTokenId)) {
      this.conditionIndex.delete(conditionId);
      return null;
    }

    return market;
  }

  /**
   * Check if a market is cached (by token ID)
   */
  hasToken(tokenId: string): boolean {
    return this.has(tokenId);
  }

  /**
   * Check if a market is cached (by condition ID)
   */
  hasCondition(conditionId: string): boolean {
    return (
      this.conditionIndex.has(conditionId) &&
      this.has(this.conditionIndex.get(conditionId)!.yesTokenId)
    );
  }

  /**
   * Get the opposite token ID for a given token
   * Returns null if token not found in cache
   */
  getOppositeTokenId(tokenId: string): string | null {
    const market = this.get(tokenId);
    if (!market) return null;

    if (market.yesTokenId === tokenId) {
      return market.noTokenId;
    } else if (market.noTokenId === tokenId) {
      return market.yesTokenId;
    }

    return null;
  }

  /**
   * Determine if a token is YES or NO
   */
  getTokenOutcome(tokenId: string): "YES" | "NO" | null {
    const market = this.get(tokenId);
    if (!market) return null;

    if (market.yesTokenId === tokenId) return "YES";
    if (market.noTokenId === tokenId) return "NO";
    return null;
  }

  /**
   * Get count of unique markets (not token entries)
   */
  getMarketCount(): number {
    // Count unique condition IDs
    const conditions = new Set<string>();
    for (const key of this.keys()) {
      const market = this.get(key);
      if (market) {
        conditions.add(market.conditionId);
      }
    }
    return conditions.size;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Override Base Methods
  // ═══════════════════════════════════════════════════════════════════════════

  override clear(): void {
    super.clear();
    this.conditionIndex.clear();
    this.tokenLookups = 0;
    this.conditionLookups = 0;
  }

  override getMetrics(): MarketCacheMetrics {
    const base = super.getMetrics();
    return {
      ...base,
      marketCount: this.getMarketCount(),
      tokenLookups: this.tokenLookups,
      conditionLookups: this.conditionLookups,
    };
  }

  override resetMetrics(): void {
    super.resetMetrics();
    this.tokenLookups = 0;
    this.conditionLookups = 0;
  }

  override healthCheck(): HealthStatus {
    const base = super.healthCheck();
    const metrics = this.getMetrics();

    return {
      ...base,
      message: `${this.name}: ${metrics.marketCount} markets cached, ${(metrics.hitRatio * 100).toFixed(1)}% hit rate`,
      details: {
        ...base.details,
        marketCount: metrics.marketCount,
        tokenLookups: metrics.tokenLookups,
        conditionLookups: metrics.conditionLookups,
      },
    };
  }
}

// ============================================================================
// Singleton Management
// ============================================================================

let globalMarketCache: MarketCache | null = null;

/**
 * Get the global MarketCache instance
 */
export function getMarketCache(): MarketCache {
  if (!globalMarketCache) {
    globalMarketCache = new MarketCache();
  }
  return globalMarketCache;
}

/**
 * Initialize a new global MarketCache (for testing or reset)
 */
export function initMarketCache(options?: {
  maxEntries?: number;
  ttlMs?: number;
}): MarketCache {
  globalMarketCache = new MarketCache(options);
  return globalMarketCache;
}

/**
 * Clear the global MarketCache (for testing)
 */
export function clearMarketCache(): void {
  if (globalMarketCache) {
    globalMarketCache.clear();
  }
}

/**
 * Get cache stats (for debugging/compatibility)
 */
export function getMarketCacheStats(): { size: number; validEntries: number } {
  const cache = getMarketCache();
  const metrics = cache.getMetrics();
  return {
    size: metrics.entryCount,
    validEntries: metrics.entryCount, // All entries are valid (TTL checked on access)
  };
}
