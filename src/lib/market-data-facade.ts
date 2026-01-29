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
import { POLYMARKET_WS, POLYMARKET_API } from "./constants";
import {
  getMarketDataStore,
  type TokenMarketData,
  type OrderbookLevel,
  type MarketDataMode,
} from "./market-data-store";
import { isDeadBook } from "./price-safety";
import {
  sortBidsDescending,
  sortAsksAscending,
  quickPriceCheck,
  type QuickPriceCheck,
} from "./orderbook-utils";

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

/**
 * REST orderbook fetch diagnostic log (for debugging dust book false positives)
 * All prices in decimal format (0-1 scale) for consistency
 */
export interface RestFetchDiagnostic {
  tokenId: string;
  requestUrl: string; // URL with secrets redacted
  httpStatus: number | null;
  latencyMs: number;
  bidsLen: number;
  asksLen: number;
  /** First 3 bid levels [price, size] */
  topBids: Array<{ price: number; size: number }>;
  /** First 3 ask levels [price, size] */
  topAsks: Array<{ price: number; size: number }>;
  /** Computed best bid (decimal) */
  computedBestBid: number | null;
  /** Computed best ask (decimal) */
  computedBestAsk: number | null;
  /** Whether this looks like a dust book (bid<=0.02, ask>=0.98) */
  isDustBook: boolean;
  /** Error message if fetch failed */
  error?: string;
  /** Parse failure details if applicable */
  parseFailure?: string;
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

  // Fast-path metrics (API-level filtering)
  private fastPathChecks = 0;
  private fastPathRejects = 0;
  private fastPathPasses = 0;
  private fastPathErrors = 0;
  private fastPathTotalLatencyMs = 0;
  private fastPathSavedFullFetches = 0;
  private fastPathRejectReasons = new Map<string, number>();

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
  // Public API - Fast-Path Price Check (API-level filtering)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Fast-path price check using lightweight /price endpoint
   * 
   * Use this BEFORE fetching full orderbook to quickly reject markets that:
   * - Have dust book prices (bid <= 2¢, ask >= 98¢)
   * - Have spreads too wide for trading
   * - Are outside our price range
   * 
   * This saves API resources by avoiding full orderbook fetches for bad markets.
   * 
   * @param tokenId - The token ID to check
   * @param maxSpreadCents - Maximum acceptable spread in cents (default: 50)
   * @returns Quick price check result with pass/fail and reason
   */
  async fastPathCheck(
    tokenId: string,
    maxSpreadCents: number = 50,
  ): Promise<{
    passes: boolean;
    reason?: string;
    bestBidCents: number;
    bestAskCents: number;
    spreadCents: number;
    latencyMs: number;
  }> {
    this.fastPathChecks++;
    const startTime = Date.now();

    try {
      const check = await quickPriceCheck(
        POLYMARKET_API.CLOB,
        tokenId,
        maxSpreadCents,
      );

      this.fastPathTotalLatencyMs += check.latencyMs;

      if (check.bestBid === null || check.bestAsk === null) {
        this.fastPathErrors++;
        console.log(
          `⚡ [FAST_PATH] ${tokenId.slice(0, 12)}... | ❌ NO_PRICE_DATA | latency=${check.latencyMs}ms`,
        );
        return {
          passes: false,
          reason: "NO_PRICE_DATA",
          bestBidCents: 0,
          bestAskCents: 0,
          spreadCents: 0,
          latencyMs: check.latencyMs,
        };
      }

      // Check for rejection conditions
      if (check.isDustBook) {
        this.fastPathRejects++;
        this.fastPathSavedFullFetches++;
        this.incrementRejectReason("DUST_BOOK");
        console.log(
          `⚡ [FAST_PATH] ${tokenId.slice(0, 12)}... | ❌ DUST_BOOK | ` +
            `bid=${check.bestBidCents.toFixed(1)}¢ ask=${check.bestAskCents.toFixed(1)}¢ | ` +
            `latency=${check.latencyMs}ms | SAVED full book fetch`,
        );
        return {
          passes: false,
          reason: "DUST_BOOK",
          bestBidCents: check.bestBidCents,
          bestAskCents: check.bestAskCents,
          spreadCents: check.spreadCents,
          latencyMs: check.latencyMs,
        };
      }

      if (!check.isValidSpread) {
        this.fastPathRejects++;
        this.fastPathSavedFullFetches++;
        const reason = `WIDE_SPREAD_${check.spreadCents.toFixed(0)}c`;
        this.incrementRejectReason(reason);
        console.log(
          `⚡ [FAST_PATH] ${tokenId.slice(0, 12)}... | ❌ ${reason} | ` +
            `bid=${check.bestBidCents.toFixed(1)}¢ ask=${check.bestAskCents.toFixed(1)}¢ spread=${check.spreadCents.toFixed(1)}¢ | ` +
            `latency=${check.latencyMs}ms | SAVED full book fetch`,
        );
        return {
          passes: false,
          reason,
          bestBidCents: check.bestBidCents,
          bestAskCents: check.bestAskCents,
          spreadCents: check.spreadCents,
          latencyMs: check.latencyMs,
        };
      }

      // Passed fast-path checks
      this.fastPathPasses++;
      console.log(
        `⚡ [FAST_PATH] ${tokenId.slice(0, 12)}... | ✅ PASS | ` +
          `bid=${check.bestBidCents.toFixed(1)}¢ ask=${check.bestAskCents.toFixed(1)}¢ spread=${check.spreadCents.toFixed(1)}¢ | ` +
          `latency=${check.latencyMs}ms | proceeding to full book fetch`,
      );

      return {
        passes: true,
        bestBidCents: check.bestBidCents,
        bestAskCents: check.bestAskCents,
        spreadCents: check.spreadCents,
        latencyMs: check.latencyMs,
      };
    } catch (error) {
      this.fastPathErrors++;
      const latencyMs = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(
        `⚡ [FAST_PATH] ${tokenId.slice(0, 12)}... | ❌ ERROR: ${errorMsg.slice(0, 50)} | latency=${latencyMs}ms`,
      );
      return {
        passes: false,
        reason: `ERROR: ${errorMsg.slice(0, 30)}`,
        bestBidCents: 0,
        bestAskCents: 0,
        spreadCents: 0,
        latencyMs,
      };
    }
  }

  /**
   * Get orderbook state with optional fast-path pre-check
   * 
   * If useFastPath is true, will first check /price endpoint to reject bad markets
   * before fetching the full orderbook. This saves API resources.
   */
  async getOrderbookStateWithFastPath(
    tokenId: string,
    options?: {
      useFastPath?: boolean;
      maxSpreadCents?: number;
    },
  ): Promise<OrderbookState | null> {
    const useFastPath = options?.useFastPath ?? true;
    const maxSpreadCents = options?.maxSpreadCents ?? 50;

    // Fast-path check (optional but recommended)
    if (useFastPath) {
      const fastCheck = await this.fastPathCheck(tokenId, maxSpreadCents);
      if (!fastCheck.passes) {
        // Return null - market rejected at API level
        return null;
      }
    }

    // Passed fast-path, fetch full orderbook
    return this.getOrderbookState(tokenId);
  }

  private incrementRejectReason(reason: string): void {
    const current = this.fastPathRejectReasons.get(reason) ?? 0;
    this.fastPathRejectReasons.set(reason, current + 1);
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
   * Get fast-path metrics for monitoring effectiveness
   */
  getFastPathMetrics(): {
    totalChecks: number;
    rejects: number;
    passes: number;
    errors: number;
    savedFetches: number;
    rejectRate: number;
    avgLatencyMs: number;
    rejectReasons: Record<string, number>;
  } {
    const rejectRate = this.fastPathChecks > 0
      ? (this.fastPathRejects / this.fastPathChecks) * 100
      : 0;
    const avgLatencyMs = this.fastPathChecks > 0
      ? this.fastPathTotalLatencyMs / this.fastPathChecks
      : 0;

    return {
      totalChecks: this.fastPathChecks,
      rejects: this.fastPathRejects,
      passes: this.fastPathPasses,
      errors: this.fastPathErrors,
      savedFetches: this.fastPathSavedFullFetches,
      rejectRate,
      avgLatencyMs,
      rejectReasons: Object.fromEntries(this.fastPathRejectReasons),
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

  /**
   * Log fast-path metrics for debugging API-level filtering effectiveness
   */
  logFastPathMetrics(prefix: string = "[FastPath]"): void {
    const fp = this.getFastPathMetrics();

    if (fp.totalChecks === 0) {
      console.log(`${prefix} No fast-path checks performed yet`);
      return;
    }

    console.log(
      `${prefix} ⚡ Fast-Path Stats:\n` +
        `  Total checks: ${fp.totalChecks}\n` +
        `  ✅ Passed: ${fp.passes} (${((fp.passes / fp.totalChecks) * 100).toFixed(1)}%)\n` +
        `  ❌ Rejected: ${fp.rejects} (${fp.rejectRate.toFixed(1)}%)\n` +
        `  ⚠️ Errors: ${fp.errors}\n` +
        `  💰 Saved full fetches: ${fp.savedFetches}\n` +
        `  ⏱️ Avg latency: ${fp.avgLatencyMs.toFixed(1)}ms`,
    );

    // Log reject reasons breakdown
    if (Object.keys(fp.rejectReasons).length > 0) {
      console.log(`${prefix} Reject reasons:`);
      for (const [reason, count] of Object.entries(fp.rejectReasons)) {
        const pct = ((count / fp.rejects) * 100).toFixed(1);
        console.log(`    ${reason}: ${count} (${pct}%)`);
      }
    }
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
   *
   * ENHANCED: Includes detailed instrumentation for debugging DUST_BOOK false positives
   * - Logs request URL, HTTP status, latency
   * - Logs bid/ask array lengths and top 3 levels
   * - Logs computed bestBid/bestAsk
   * - Cross-checks with WS cache when dust book is detected
   * - NEVER defaults to 0.01/0.99 silently
   */
  private async fetchFromRest(tokenId: string): Promise<OrderbookState | null> {
    const startTime = Date.now();
    const redactedUrl = `${POLYMARKET_API.CLOB}/book?token_id=${tokenId.slice(0, 12)}...`;

    // Initialize diagnostic object
    const diagnostic: RestFetchDiagnostic = {
      tokenId,
      requestUrl: redactedUrl,
      httpStatus: null,
      latencyMs: 0,
      bidsLen: 0,
      asksLen: 0,
      topBids: [],
      topAsks: [],
      computedBestBid: null,
      computedBestAsk: null,
      isDustBook: false,
    };

    try {
      const orderbook = await this.client.getOrderBook(tokenId);
      diagnostic.latencyMs = Date.now() - startTime;
      diagnostic.httpStatus = 200; // If we get here, request succeeded

      // Check for empty orderbook - DO NOT default to 0.01/0.99
      if (!orderbook?.bids?.length || !orderbook?.asks?.length) {
        diagnostic.bidsLen = orderbook?.bids?.length ?? 0;
        diagnostic.asksLen = orderbook?.asks?.length ?? 0;
        diagnostic.parseFailure = "Empty bids or asks array from API";

        console.log(
          `📊 [REST_FETCH_EMPTY] ${tokenId.slice(0, 12)}... | ` +
            `latency=${diagnostic.latencyMs}ms | bidsLen=${diagnostic.bidsLen} asksLen=${diagnostic.asksLen} | ` +
            `EMPTY_BOOK - NO defaults applied`,
        );
        this.logDiagnostic(diagnostic);
        return null;
      }

      diagnostic.bidsLen = orderbook.bids.length;
      diagnostic.asksLen = orderbook.asks.length;

      // Parse levels from raw API response
      const rawBids: OrderbookLevel[] = orderbook.bids
        .map((l: any) => ({
          price: parseFloat(l.price),
          size: parseFloat(l.size),
        }))
        .filter(
          (l: OrderbookLevel) =>
            !isNaN(l.price) && !isNaN(l.size) && l.size > 0,
        );

      const rawAsks: OrderbookLevel[] = orderbook.asks
        .map((l: any) => ({
          price: parseFloat(l.price),
          size: parseFloat(l.size),
        }))
        .filter(
          (l: OrderbookLevel) =>
            !isNaN(l.price) && !isNaN(l.size) && l.size > 0,
        );

      // CRITICAL: Sort levels so best prices are at index 0
      // REST API returns levels sorted away from mid (worst prices first)
      // We need: bids descending (best/highest first), asks ascending (best/lowest first)
      const bids = sortBidsDescending(rawBids);
      const asks = sortAsksAscending(rawAsks);

      // Capture top 3 levels for diagnostics (now properly sorted)
      diagnostic.topBids = bids.slice(0, 3).map((l) => ({
        price: l.price,
        size: l.size,
      }));
      diagnostic.topAsks = asks.slice(0, 3).map((l) => ({
        price: l.price,
        size: l.size,
      }));

      // Check for parsing failures - DO NOT default to 0.01/0.99
      if (bids.length === 0 || asks.length === 0) {
        diagnostic.parseFailure = `Parsing filtered all levels: rawBids=${orderbook.bids.length} validBids=${bids.length} rawAsks=${orderbook.asks.length} validAsks=${asks.length}`;

        console.log(
          `📊 [REST_FETCH_PARSE_FAIL] ${tokenId.slice(0, 12)}... | ` +
            `latency=${diagnostic.latencyMs}ms | ${diagnostic.parseFailure} | ` +
            `PARSE_FAIL - NO defaults applied`,
        );
        this.logDiagnostic(diagnostic);
        return null;
      }

      // Update store with SORTED levels
      const store = getMarketDataStore();
      store.updateFromRest(tokenId, bids, asks);

      // Compute best prices (now correctly at index 0 after sorting)
      const bestBid = bids[0].price;
      const bestAsk = asks[0].price;
      diagnostic.computedBestBid = bestBid;
      diagnostic.computedBestAsk = bestAsk;

      // Check for dust book condition
      diagnostic.isDustBook = isDeadBook(bestBid, bestAsk);

      // Compute depth for top 5 levels
      let bidDepth = 0,
        askDepth = 0;
      for (const level of bids.slice(0, 5)) {
        bidDepth += level.size * level.price;
      }
      for (const level of asks.slice(0, 5)) {
        askDepth += level.size * level.price;
      }

      const mid = (bestBid + bestAsk) / 2;

      // Cross-check with WS cache if dust book detected
      if (diagnostic.isDustBook) {
        const wsData = store.get(tokenId);
        const wsOrderbook = store.getOrderbook(tokenId);

        console.log(
          `⚠️ [DUST_CONFIRM] ${tokenId.slice(0, 12)}... | ` +
            `REST: bid=${(bestBid * 100).toFixed(1)}¢ ask=${(bestAsk * 100).toFixed(1)}¢ | ` +
            `WS_CACHE: ${wsData ? `bid=${(wsData.bestBid * 100).toFixed(1)}¢ ask=${(wsData.bestAsk * 100).toFixed(1)}¢ source=${wsData.source} age=${Date.now() - wsData.updatedAt}ms` : "NO_CACHE"} | ` +
            `bidsLen=${bids.length} asksLen=${asks.length}`,
        );

        // Log detailed level comparison if WS cache exists
        if (wsOrderbook && wsOrderbook.bids.length > 0) {
          const wsBestBid = wsOrderbook.bids[0].price;
          const wsBestAsk =
            wsOrderbook.asks.length > 0 ? wsOrderbook.asks[0].price : 0;
          console.log(
            `🔍 [DUST_CROSS_CHECK] REST_bid=${(bestBid * 100).toFixed(1)}¢ vs WS_bid=${(wsBestBid * 100).toFixed(1)}¢ | ` +
              `REST_ask=${(bestAsk * 100).toFixed(1)}¢ vs WS_ask=${(wsBestAsk * 100).toFixed(1)}¢ | ` +
              `match=${Math.abs(bestBid - wsBestBid) < 0.001 && Math.abs(bestAsk - wsBestAsk) < 0.001 ? "YES" : "NO"}`,
          );
        }
      }

      // Log successful fetch with diagnostic info
      this.logDiagnostic(diagnostic);

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
      diagnostic.latencyMs = Date.now() - startTime;
      const msg = err instanceof Error ? err.message : String(err);
      diagnostic.error = msg;

      // Extract HTTP status from error if available
      if (msg.includes("404")) {
        diagnostic.httpStatus = 404;
      } else if (msg.includes("429")) {
        diagnostic.httpStatus = 429;
      } else if (msg.includes("500")) {
        diagnostic.httpStatus = 500;
      }

      // Don't log 404s (market closed) as errors
      if (!msg.includes("404") && !msg.includes("No orderbook")) {
        console.log(
          `📊 [REST_FETCH_ERROR] ${tokenId.slice(0, 12)}... | ` +
            `latency=${diagnostic.latencyMs}ms | status=${diagnostic.httpStatus ?? "unknown"} | ` +
            `error=${msg.slice(0, 100)}`,
        );
      }

      this.logDiagnostic(diagnostic);
      return null;
    }
  }

  /**
   * Log REST fetch diagnostic in structured JSON format
   */
  private logDiagnostic(diagnostic: RestFetchDiagnostic): void {
    // Only log detailed diagnostics for dust books or errors
    if (diagnostic.isDustBook || diagnostic.error || diagnostic.parseFailure) {
      console.log(
        JSON.stringify({
          event: "REST_ORDERBOOK_DIAGNOSTIC",
          timestamp: new Date().toISOString(),
          ...diagnostic,
          // Format prices in cents for readability
          computedBestBidCents: diagnostic.computedBestBid
            ? (diagnostic.computedBestBid * 100).toFixed(2)
            : null,
          computedBestAskCents: diagnostic.computedBestAsk
            ? (diagnostic.computedBestAsk * 100).toFixed(2)
            : null,
        }),
      );
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
