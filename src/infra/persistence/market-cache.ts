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
 * - Supports ANY 2-outcome market (not just YES/NO)
 *
 * NOTE: This module provides functions with the same names as lib/market.ts
 * (clearMarketCache, getMarketCacheStats) but for the new persistence layer.
 * The old implementations in lib/market.ts are still in use by existing code.
 * Import from the specific module you need:
 * - `import { clearMarketCache } from '../lib/market'` - Old cache (in use)
 * - `import { clearMarketCache } from '../infra/persistence'` - New cache (for migration)
 *
 * @see lib/market.ts for the currently active cache implementation
 */

import { BaseStore, type BaseStoreMetrics } from "./base-store";
import type { HealthStatus } from "./types";
// Import types from lib/market.ts to ensure consistency
import type { MarketTokenPair, OutcomeToken } from "../../lib/market";

// Re-export for consumers of this module
export type { MarketTokenPair, OutcomeToken };

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
 * Supports any 2-outcome market, not just YES/NO.
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
    // Store by all token IDs from tokens array
    if (market.tokens) {
      for (const token of market.tokens) {
        this.set(token.tokenId, market);
      }
    }

    // Also store by legacy yesTokenId/noTokenId for backward compat
    this.set(market.yesTokenId, market);
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
   * Works with any 2-outcome market
   */
  getOppositeTokenId(tokenId: string): string | null {
    const market = this.get(tokenId);
    if (!market) return null;

    // Use tokens array if available
    if (market.tokens) {
      const opposite = market.tokens.find((t) => t.tokenId !== tokenId);
      return opposite?.tokenId ?? null;
    }

    // Fallback to legacy yesTokenId/noTokenId
    if (market.yesTokenId === tokenId) {
      return market.noTokenId;
    } else if (market.noTokenId === tokenId) {
      return market.yesTokenId;
    }

    return null;
  }

  /**
   * Get token info including outcomeIndex and outcomeLabel
   * Works with any 2-outcome market
   */
  getTokenInfo(tokenId: string): OutcomeToken | null {
    const market = this.get(tokenId);
    if (!market) return null;

    // Use tokens array if available
    if (market.tokens) {
      return market.tokens.find((t) => t.tokenId === tokenId) ?? null;
    }

    // Fallback to legacy - infer outcomeIndex from yesTokenId/noTokenId
    if (market.yesTokenId === tokenId) {
      return { tokenId, outcomeIndex: 1, outcomeLabel: "YES" };
    } else if (market.noTokenId === tokenId) {
      return { tokenId, outcomeIndex: 2, outcomeLabel: "NO" };
    }

    return null;
  }

  /**
   * @deprecated Use getTokenInfo() for full outcomeIndex/label support
   * Determine if a token is YES or NO (returns outcomeLabel for non-YES/NO markets)
   */
  getTokenOutcome(tokenId: string): string | null {
    const market = this.get(tokenId);
    if (!market) return null;

    // Use tokens array if available
    if (market.tokens) {
      const tokenInfo = market.tokens.find((t) => t.tokenId === tokenId);
      return tokenInfo?.outcomeLabel ?? null;
    }

    // Fallback to legacy
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

  /**
   * Delete a market entry and clean up secondary indexes.
   * Ensures that conditionIndex does not retain stale references when
   * markets are deleted or evicted from the primary store.
   */
  override delete(tokenId: string): boolean {
    const market = this.get(tokenId);

    // Delete from the primary store first
    const deleted = super.delete(tokenId);

    if (market) {
      this.cleanupConditionIndex(market);
    }

    return deleted;
  }

  /**
   * Hook called when an entry is evicted due to LRU capacity limits.
   * Cleans up the conditionIndex for evicted markets.
   */
  protected override onEvict(tokenId: string): void {
    const entry = this.store.get(tokenId);
    if (entry?.value) {
      this.cleanupConditionIndex(entry.value);
    }
  }

  /**
   * Clean up conditionIndex when a market's token is removed.
   * Only removes the condition entry when neither token is cached.
   */
  private cleanupConditionIndex(market: MarketTokenPair): void {
    const { yesTokenId, noTokenId, conditionId } = market;

    // Only remove the condition index entry when neither token is cached
    // Note: We check the underlying store directly to avoid TTL side effects
    if (!this.store.has(yesTokenId) && !this.store.has(noTokenId)) {
      this.conditionIndex.delete(conditionId);
    }
  }

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
