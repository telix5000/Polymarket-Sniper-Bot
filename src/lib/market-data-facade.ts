/**
 * MarketDataFacade - Unified interface for orderbook data
 *
 * This is the SINGLE entry point for all market data in the system.
 * It reads from MarketDataStore first, falls back to REST if stale,
 * and handles rate limiting for REST fallback.
 *
 * Usage:
 *   const facade = getMarketDataFacade(clobClient);
 *   const state = await facade.getOrderbookState(tokenId);
 *
 * All code that previously called client.getOrderBook() should now
 * use this facade instead.
 */

import type { ClobClient } from "@polymarket/clob-client";
import { POLYMARKET_WS } from "./constants";
import {
  getMarketDataStore,
  type TokenMarketData,
  type OrderbookLevel,
  type MarketDataMode,
} from "./market-data-store";

// ============================================================================
// Types
// ============================================================================

/** Book source indicating where the data came from */
export type BookSource = "WS" | "REST" | "STALE_CACHE";

/** Orderbook state returned to callers (matches existing OrderbookState interface) */
export interface OrderbookState {
  bestBidCents: number;
  bestAskCents: number;
  bidDepthUsd: number;
  askDepthUsd: number;
  spreadCents: number;
  midPriceCents: number;
  /** Source of the orderbook data (WS = WebSocket, REST = REST API, STALE_CACHE = stale cached data) */
  source?: BookSource;
}

/** Detailed orderbook with levels */
export interface DetailedOrderbook {
  tokenId: string;
  state: OrderbookState;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  source: "WS" | "REST";
  ageMs: number;
}

/** Facade metrics */
export interface FacadeMetrics {
  wsHits: number;
  restFallbacks: number;
  rateLimitHits: number;
  mode: MarketDataMode;
  avgResponseTimeMs: number;
}

// ============================================================================
// Rate Limiter for REST fallback
// ============================================================================

class RateLimiter {
  private lastCallTime = new Map<string, number>();
  private globalLastCall = 0;
  private readonly minIntervalMs: number;
  private readonly globalMinIntervalMs: number;
  private hits = 0;
  // Track in-flight requests to prevent thundering herd
  // Map tokenId -> acquireTime for timeout-based cleanup
  private inFlight = new Map<string, number>();
  // Lock timeout to prevent permanent deadlocks (10 seconds)
  private readonly lockTimeoutMs = 10000;
  // Cleanup interval for old entries (1 hour)
  private readonly cleanupIntervalMs = 60 * 60 * 1000;
  private lastCleanupTime = Date.now();

  constructor(minIntervalMs: number, globalMinIntervalMs: number = 100) {
    this.minIntervalMs = minIntervalMs;
    this.globalMinIntervalMs = globalMinIntervalMs;
  }

  /**
   * Try to acquire permission for a REST call (atomic check-and-record)
   * Returns true if allowed, false if rate-limited
   * Automatically records the call if allowed
   */
  tryAcquire(tokenId: string): boolean {
    const now = Date.now();

    // Periodic cleanup of old entries to prevent memory growth
    this.maybeCleanup(now);

    // Check if already in-flight for this token (prevents thundering herd)
    // Also check for stale locks (timeout-based cleanup)
    const acquireTime = this.inFlight.get(tokenId);
    if (acquireTime !== undefined) {
      // Check if lock is stale (exceeded timeout)
      if (now - acquireTime > this.lockTimeoutMs) {
        // Auto-release stale lock
        this.inFlight.delete(tokenId);
        console.warn(
          `[RateLimiter] Auto-released stale lock for ${tokenId.slice(0, 12)}... (held for ${now - acquireTime}ms)`,
        );
      } else {
        this.hits++;
        return false;
      }
    }

    // Global rate limit
    if (now - this.globalLastCall < this.globalMinIntervalMs) {
      this.hits++;
      return false;
    }

    // Per-token rate limit
    const lastCall = this.lastCallTime.get(tokenId) ?? 0;
    if (now - lastCall < this.minIntervalMs) {
      this.hits++;
      return false;
    }

    // Atomically acquire: record timestamps and mark in-flight with acquire time
    this.lastCallTime.set(tokenId, now);
    this.globalLastCall = now;
    this.inFlight.set(tokenId, now);

    return true;
  }

  /**
   * Release the in-flight lock for a token (call after REST request completes)
   */
  release(tokenId: string): void {
    this.inFlight.delete(tokenId);
  }

  /**
   * Get rate limit hits count
   */
  getHits(): number {
    return this.hits;
  }

  /**
   * Periodic cleanup of old entries to prevent memory growth
   */
  private maybeCleanup(now: number): void {
    if (now - this.lastCleanupTime < this.cleanupIntervalMs) {
      return;
    }

    this.lastCleanupTime = now;
    const cutoff = now - this.cleanupIntervalMs;

    // Clean old lastCallTime entries
    for (const [tokenId, time] of this.lastCallTime.entries()) {
      if (time < cutoff) {
        this.lastCallTime.delete(tokenId);
      }
    }

    // Clean stale in-flight locks (should already be handled in tryAcquire, but belt-and-suspenders)
    for (const [tokenId, time] of this.inFlight.entries()) {
      if (now - time > this.lockTimeoutMs) {
        this.inFlight.delete(tokenId);
      }
    }
  }

  /**
   * Clear state (for testing)
   */
  clear(): void {
    this.lastCallTime.clear();
    this.globalLastCall = 0;
    this.hits = 0;
    this.inFlight.clear();
  }
}

// ============================================================================
// MarketDataFacade Implementation
// ============================================================================

export class MarketDataFacade {
  private readonly client: ClobClient;
  private readonly rateLimiter: RateLimiter;
  private readonly staleMs: number;

  // Metrics
  private wsHits = 0;
  private restFallbacks = 0;
  private totalResponseTime = 0;
  private totalCalls = 0;

  constructor(
    client: ClobClient,
    options?: {
      staleMs?: number;
      restMinIntervalMs?: number;
    },
  ) {
    this.client = client;
    this.staleMs = options?.staleMs ?? POLYMARKET_WS.STALE_MS;
    this.rateLimiter = new RateLimiter(
      options?.restMinIntervalMs ?? POLYMARKET_WS.REST_FALLBACK_MIN_INTERVAL_MS,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Public API - Primary Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get orderbook state for a token
   *
   * This is the main method that should replace all direct getOrderBook calls.
   * It reads from the WebSocket-updated store first, falls back to REST if stale.
   *
   * @returns OrderbookState or null if unavailable
   */
  async getOrderbookState(tokenId: string): Promise<OrderbookState | null> {
    const startTime = Date.now();

    try {
      const store = getMarketDataStore();
      const cached = store.get(tokenId);

      // Check if we have fresh data from WebSocket
      if (cached && !store.isStale(tokenId)) {
        this.wsHits++;
        this.recordResponseTime(startTime);
        return this.toOrderbookState(
          cached,
          cached.source === "WS" ? "WS" : "REST",
        );
      }

      // Data is stale or missing - try REST fallback with atomic rate limiter
      if (!this.rateLimiter.tryAcquire(tokenId)) {
        // Rate limited or in-flight - return stale data if available
        if (cached) {
          this.wsHits++;
          this.recordResponseTime(startTime);
          // Mark as STALE_CACHE since we couldn't refresh
          return this.toOrderbookState(cached, "STALE_CACHE");
        }
        return null;
      }

      // Fetch from REST (rate limiter acquired, will release after)
      try {
        const restData = await this.fetchFromRest(tokenId);
        this.recordResponseTime(startTime);

        if (restData) {
          this.restFallbacks++;
          return restData; // fetchFromRest already sets source to "REST"
        }

        // REST failed - return stale data if available
        if (cached) {
          return this.toOrderbookState(cached, "STALE_CACHE");
        }

        return null;
      } finally {
        // Always release the rate limiter lock
        this.rateLimiter.release(tokenId);
      }
    } catch (err) {
      this.recordResponseTime(startTime);
      console.warn(
        `[MarketData] Error getting orderbook for ${tokenId.slice(0, 12)}...: ${err}`,
      );

      // Try to return cached data on error
      const store = getMarketDataStore();
      const cached = store.get(tokenId);
      if (cached) {
        return this.toOrderbookState(cached, "STALE_CACHE");
      }

      return null;
    }
  }

  /**
   * Get detailed orderbook with full levels
   */
  async getDetailedOrderbook(
    tokenId: string,
  ): Promise<DetailedOrderbook | null> {
    const store = getMarketDataStore();

    // First ensure we have fresh data
    const state = await this.getOrderbookState(tokenId);
    if (!state) return null;

    // Get full orderbook from store
    const orderbook = store.getOrderbook(tokenId);
    const cached = store.get(tokenId);

    if (!orderbook || !cached) return null;

    return {
      tokenId,
      state,
      bids: orderbook.bids,
      asks: orderbook.asks,
      source: cached.source,
      ageMs: store.getAge(tokenId),
    };
  }

  /**
   * Get best bid price for a token (convenience method)
   */
  async getBestBid(tokenId: string): Promise<number | null> {
    const state = await this.getOrderbookState(tokenId);
    if (!state) return null;
    return state.bestBidCents / 100; // Return as decimal
  }

  /**
   * Get best ask price for a token (convenience method)
   */
  async getBestAsk(tokenId: string): Promise<number | null> {
    const state = await this.getOrderbookState(tokenId);
    if (!state) return null;
    return state.bestAskCents / 100; // Return as decimal
  }

  /**
   * Get mid price for a token (convenience method)
   */
  async getMidPrice(tokenId: string): Promise<number | null> {
    const state = await this.getOrderbookState(tokenId);
    if (!state) return null;
    return state.midPriceCents / 100; // Return as decimal
  }

  /**
   * Check if data for a token is fresh
   */
  isFresh(tokenId: string): boolean {
    const store = getMarketDataStore();
    return store.has(tokenId) && !store.isStale(tokenId);
  }

  /**
   * Get current market data mode
   */
  getMode(): MarketDataMode {
    return getMarketDataStore().getMode();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Public API - Bulk Operations
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get orderbook states for multiple tokens
   * Fetches in parallel with REST fallback for stale data
   */
  async getOrderbookStates(
    tokenIds: string[],
  ): Promise<Map<string, OrderbookState>> {
    const results = new Map<string, OrderbookState>();

    const promises = tokenIds.map(async (tokenId) => {
      const state = await this.getOrderbookState(tokenId);
      if (state) {
        results.set(tokenId, state);
      }
    });

    await Promise.all(promises);
    return results;
  }

  /**
   * Pre-warm the cache by subscribing to tokens via WebSocket
   * This should be called with the WebSocketMarketClient
   */
  ensureSubscribed(tokenIds: string[]): void {
    // This method is a no-op in the facade - the caller should use
    // WebSocketMarketClient.subscribe() directly
    // Included here for API completeness
    console.log(
      `[MarketData] Ensure subscribed called for ${tokenIds.length} tokens`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Public API - Metrics
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get facade metrics
   */
  getMetrics(): FacadeMetrics {
    return {
      wsHits: this.wsHits,
      restFallbacks: this.restFallbacks,
      rateLimitHits: this.rateLimiter.getHits(),
      mode: this.getMode(),
      avgResponseTimeMs:
        this.totalCalls > 0 ? this.totalResponseTime / this.totalCalls : 0,
    };
  }

  /**
   * Log current metrics
   */
  logMetrics(prefix: string = "[MarketDataFacade]"): void {
    const m = this.getMetrics();
    const hitRate =
      this.wsHits + this.restFallbacks > 0
        ? ((this.wsHits / (this.wsHits + this.restFallbacks)) * 100).toFixed(1)
        : "0";

    console.log(
      `${prefix} Mode: ${m.mode} | ` +
        `WS hits: ${m.wsHits} (${hitRate}%) | ` +
        `REST fallbacks: ${m.restFallbacks} | ` +
        `Rate limited: ${m.rateLimitHits} | ` +
        `Avg latency: ${m.avgResponseTimeMs.toFixed(1)}ms`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Convert TokenMarketData to OrderbookState
   */
  private toOrderbookState(
    data: TokenMarketData,
    source?: BookSource,
  ): OrderbookState {
    return {
      bestBidCents: data.bestBid * 100,
      bestAskCents: data.bestAsk * 100,
      bidDepthUsd: data.bidDepthUsd,
      askDepthUsd: data.askDepthUsd,
      spreadCents: data.spreadCents,
      midPriceCents: data.mid * 100,
      source: source ?? (data.source === "WS" ? "WS" : "REST"),
    };
  }

  /**
   * Fetch orderbook from REST API and update store
   * Note: Rate limiting is handled by the caller via tryAcquire/release
   */
  private async fetchFromRest(tokenId: string): Promise<OrderbookState | null> {
    try {
      const orderbook = await this.client.getOrderBook(tokenId);

      if (!orderbook?.bids?.length || !orderbook?.asks?.length) {
        return null;
      }

      // Parse levels
      const bids: OrderbookLevel[] = orderbook.bids
        .map((l: any) => ({
          price: parseFloat(l.price),
          size: parseFloat(l.size),
        }))
        .filter(
          (l: OrderbookLevel) =>
            !isNaN(l.price) && !isNaN(l.size) && l.size > 0,
        );

      const asks: OrderbookLevel[] = orderbook.asks
        .map((l: any) => ({
          price: parseFloat(l.price),
          size: parseFloat(l.size),
        }))
        .filter(
          (l: OrderbookLevel) =>
            !isNaN(l.price) && !isNaN(l.size) && l.size > 0,
        );

      if (bids.length === 0 || asks.length === 0) {
        return null;
      }

      // Update store
      const store = getMarketDataStore();
      store.updateFromRest(tokenId, bids, asks);

      // Return state
      const bestBid = bids[0].price;
      const bestAsk = asks[0].price;
      const mid = (bestBid + bestAsk) / 2;

      let bidDepth = 0,
        askDepth = 0;
      for (const level of bids.slice(0, 5)) {
        bidDepth += level.size * level.price;
      }
      for (const level of asks.slice(0, 5)) {
        askDepth += level.size * level.price;
      }

      return {
        bestBidCents: bestBid * 100,
        bestAskCents: bestAsk * 100,
        bidDepthUsd: bidDepth,
        askDepthUsd: askDepth,
        spreadCents: (bestAsk - bestBid) * 100,
        midPriceCents: mid * 100,
        source: "REST",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Don't log 404s (market closed) as errors
      if (!msg.includes("404") && !msg.includes("No orderbook")) {
        console.warn(
          `[MarketData] REST fallback failed for ${tokenId.slice(0, 12)}...: ${msg}`,
        );
      }
      return null;
    }
  }

  /**
   * Record response time for metrics
   */
  private recordResponseTime(startTime: number): void {
    this.totalResponseTime += Date.now() - startTime;
    this.totalCalls++;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalFacade: MarketDataFacade | null = null;

/**
 * Get or create the global MarketDataFacade instance
 * @param client - CLOB client (required on first call)
 */
export function getMarketDataFacade(client?: ClobClient): MarketDataFacade {
  if (!globalFacade) {
    if (!client) {
      throw new Error(
        "MarketDataFacade requires ClobClient on first initialization",
      );
    }
    globalFacade = new MarketDataFacade(client);
  }
  return globalFacade;
}

/**
 * Initialize a new global MarketDataFacade
 */
export function initMarketDataFacade(
  client: ClobClient,
  options?: {
    staleMs?: number;
    restMinIntervalMs?: number;
  },
): MarketDataFacade {
  globalFacade = new MarketDataFacade(client, options);
  return globalFacade;
}

/**
 * Check if facade is initialized
 */
export function isMarketDataFacadeInitialized(): boolean {
  return globalFacade !== null;
}
