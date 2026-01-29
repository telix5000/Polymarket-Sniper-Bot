/**
 * BookResolver - Unified orderbook resolution and health checking
 *
 * This module provides a SINGLE entry point for both WHALE and SCAN flows
 * to fetch and validate orderbook data. It:
 *
 * 1. Resolves the correct token identifier
 * 2. Fetches from primary source (WS cache or REST)
 * 3. Validates without silent fallbacks (no default 0.01/0.99)
 * 4. Cross-checks dust/empty via alternate source before rejection
 * 5. Returns normalized OrderBookSnapshot + BookHealth decision
 *
 * Usage:
 *   const resolver = getBookResolver(clobClient);
 *   const result = await resolver.resolveHealthyBook({
 *     tokenId: "...",
 *     flow: "whale", // or "scan"
 *   });
 */

import type { ClobClient } from "@polymarket/clob-client";
import {
  getMarketDataStore,
  type OrderbookLevel,
} from "../lib/market-data-store";
import { sortBidsDescending, sortAsksAscending } from "../lib/orderbook-utils";
import {
  type NormalizedLevel,
  type OrderBookSnapshot,
  type BookHealth,
  type ResolveBookParams,
  type ResolveBookResult,
  BOOK_THRESHOLDS,
} from "./types";

// Re-export types for convenience
export * from "./types";

// ============================================================================
// BookResolver Implementation
// ============================================================================

export class BookResolver {
  private readonly client: ClobClient;

  constructor(client: ClobClient) {
    this.client = client;
  }

  /**
   * Generate a unique attempt ID for correlation
   */
  private generateAttemptId(): string {
    return `ATT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Resolve a healthy orderbook for a token
   *
   * This is the MAIN method both WHALE and SCAN flows should use.
   * It handles fetching, validation, and cross-checking in a unified way.
   *
   * SINGLE-SNAPSHOT INVARIANT: The book is fetched ONCE and passed through
   * the entire attempt. The same snapshot is used for health check, pricing,
   * and order placement. No hidden re-fetches occur.
   *
   * BOOK_FETCH_FAILED vs EMPTY_BOOK: If the fetch throws/times-out/returns
   * invalid shape, we classify as BOOK_FETCH_FAILED (not EMPTY_BOOK) and
   * retry once before skipping. EMPTY_BOOK is reserved for valid responses
   * that genuinely have bid<=1¢ AND ask>=99¢.
   */
  async resolveHealthyBook(
    params: ResolveBookParams,
  ): Promise<ResolveBookResult> {
    const {
      tokenId,
      flow,
      maxSpreadCents = BOOK_THRESHOLDS.DEFAULT_MAX_SPREAD_CENTS,
    } = params;
    const attemptId = params.attemptId || this.generateAttemptId();
    const startTime = Date.now();

    // Try primary source first (WS cache, then REST)
    let primarySnapshot = await this.fetchBook(tokenId, "primary", attemptId);

    // If fetch failed, retry once with REST-only before giving up
    if (primarySnapshot.fetchFailed) {
      console.log(
        `🔄 [BOOK_FETCH_RETRY] attemptId=${attemptId} | flow=${flow} | ${tokenId.slice(0, 12)}... | ` +
          `Primary fetch failed (${primarySnapshot.error?.slice(0, 50) || "unknown"}), retrying REST...`,
      );
      const retrySnapshot = await this.fetchFromRestWithRetry(
        tokenId,
        attemptId,
      );

      if (!retrySnapshot.fetchFailed) {
        // Retry succeeded - use the retry snapshot
        primarySnapshot = retrySnapshot;
        console.log(
          `✅ [BOOK_FETCH_RETRY_SUCCESS] attemptId=${attemptId} | flow=${flow} | ${tokenId.slice(0, 12)}... | ` +
            `bid=${(retrySnapshot.bestBid! * 100).toFixed(1)}¢ ask=${(retrySnapshot.bestAsk! * 100).toFixed(1)}¢`,
        );
      } else {
        // Retry also failed - return BOOK_FETCH_FAILED
        console.log(
          `❌ [BOOK_FETCH_RETRY_FAILED] attemptId=${attemptId} | flow=${flow} | ${tokenId.slice(0, 12)}... | ` +
            `Both primary and retry failed - classifying as BOOK_FETCH_FAILED`,
        );
        return {
          success: false,
          snapshot: primarySnapshot,
          health: {
            healthy: false,
            status: "BOOK_FETCH_FAILED",
            reason: `Fetch failed: ${primarySnapshot.error || "unknown error"}`,
            bestBidCents: 0,
            bestAskCents: 0,
            spreadCents: 0,
            bidsLen: 0,
            asksLen: 0,
          },
          crossChecked: false,
          attemptId,
        };
      }
    }

    const primaryHealth = this.evaluateHealth(primarySnapshot, maxSpreadCents);

    // Log the initial book check with attemptId
    this.logBookCheck({
      attemptId,
      flow,
      tokenIdPrefix: tokenId.slice(0, 12),
      primarySource: primarySnapshot.source,
      bidsLen: primarySnapshot.bids.length,
      asksLen: primarySnapshot.asks.length,
      bestBid: primarySnapshot.bestBid,
      bestAsk: primarySnapshot.bestAsk,
      health: primaryHealth,
      latencyMs: Date.now() - startTime,
      fetchedAtMs: primarySnapshot.fetchedAtMs,
    });

    // If healthy, return immediately
    if (primaryHealth.healthy) {
      return {
        success: true,
        snapshot: primarySnapshot,
        health: primaryHealth,
        crossChecked: false,
        attemptId,
      };
    }

    // If dust/empty, perform cross-check before rejecting
    if (
      primaryHealth.status === "DUST_BOOK" ||
      primaryHealth.status === "EMPTY_BOOK"
    ) {
      const crossCheckResult = await this.crossCheckDustBook(
        tokenId,
        primarySnapshot,
        primaryHealth,
        flow,
        maxSpreadCents,
        attemptId,
      );

      // If cross-check found healthy book, use that
      if (crossCheckResult.success && crossCheckResult.snapshot) {
        return { ...crossCheckResult, attemptId };
      }

      // Both sources confirm dust/empty
      return {
        success: false,
        snapshot: primarySnapshot,
        health: primaryHealth,
        crossChecked: true,
        crossCheckSource: crossCheckResult.crossCheckSource,
        crossCheckHealth: crossCheckResult.crossCheckHealth,
        attemptId,
      };
    }

    // Other unhealthy statuses (wide spread, ask too high, etc.)
    return {
      success: false,
      snapshot: primarySnapshot,
      health: primaryHealth,
      crossChecked: false,
      attemptId,
    };
  }

  /**
   * Fetch orderbook from a specific source
   */
  private async fetchBook(
    tokenId: string,
    mode: "primary" | "ws_only" | "rest_only",
    attemptId?: string,
  ): Promise<OrderBookSnapshot> {
    const store = getMarketDataStore();
    const fetchedAtMs = Date.now();

    // Try WS cache first if not forcing REST
    if (mode === "primary" || mode === "ws_only") {
      const cached = store.get(tokenId);
      const cachedOrderbook = store.getOrderbook(tokenId);

      if (cached && cachedOrderbook && !store.isStale(tokenId)) {
        const bids = this.normalizeLevels(cachedOrderbook.bids);
        const asks = this.normalizeLevels(cachedOrderbook.asks);

        return {
          source: "WS_CACHE",
          tokenId,
          bids,
          asks,
          bestBid: bids.length > 0 ? bids[0].price : undefined,
          bestAsk: asks.length > 0 ? asks[0].price : undefined,
          parsedOk: bids.length > 0 && asks.length > 0,
          rawShape: `bids:${cachedOrderbook.bids.length},asks:${cachedOrderbook.asks.length}`,
          latencyMs: 0,
          fetchedAtMs,
          attemptId,
          fetchFailed: false,
        };
      }

      // If ws_only mode and no cache, return empty (NOT a fetch failure)
      if (mode === "ws_only") {
        return {
          source: "WS_CACHE",
          tokenId,
          bids: [],
          asks: [],
          parsedOk: false,
          rawShape: "no_cache",
          error: "No WS cache available",
          fetchedAtMs,
          attemptId,
          fetchFailed: false, // This is not a fetch failure, just no cache
        };
      }
    }

    // Fetch from REST
    return this.fetchFromRest(tokenId, attemptId);
  }

  /**
   * Fetch orderbook from REST API with detailed diagnostics
   *
   * IMPORTANT: This method distinguishes between:
   * - fetchFailed=true: The HTTP request threw/timed-out/returned error status
   * - parsedOk=false with fetchFailed=false: Got a valid response but book is empty/invalid
   *
   * This distinction is critical for proper EMPTY_BOOK vs BOOK_FETCH_FAILED classification.
   */
  private async fetchFromRest(
    tokenId: string,
    attemptId?: string,
  ): Promise<OrderBookSnapshot> {
    const startTime = Date.now();
    const fetchedAtMs = startTime;

    try {
      const orderbook = await this.client.getOrderBook(tokenId);
      const latencyMs = Date.now() - startTime;

      // Check for empty response - this is a VALID response with empty book
      // NOT a fetch failure - the fetch succeeded, the book is just empty
      if (!orderbook?.bids?.length || !orderbook?.asks?.length) {
        const rawBidsLen = orderbook?.bids?.length ?? 0;
        const rawAsksLen = orderbook?.asks?.length ?? 0;

        console.log(
          `📊 [BOOK_FETCH_EMPTY] attemptId=${attemptId || "none"} | flow=REST | ${tokenId.slice(0, 12)}... | ` +
            `latency=${latencyMs}ms | bidsLen=${rawBidsLen} asksLen=${rawAsksLen} | ` +
            `EMPTY_RESPONSE - NO defaults applied (fetchFailed=false)`,
        );

        return {
          source: "REST",
          tokenId,
          bids: [],
          asks: [],
          httpStatus: 200,
          latencyMs,
          parsedOk: false,
          rawShape: `bids:${rawBidsLen},asks:${rawAsksLen}`,
          error: "Empty bids or asks array from API",
          fetchedAtMs,
          attemptId,
          fetchFailed: false, // Got a valid response, book just happens to be empty
        };
      }

      // Parse and normalize levels
      // CRITICAL: Sort bids descending (best first), asks ascending (best first)
      const rawBids = this.parseLevels(orderbook.bids);
      const rawAsks = this.parseLevels(orderbook.asks);
      const bids = sortBidsDescending(rawBids);
      const asks = sortAsksAscending(rawAsks);

      // Check for parsing failures - got data but it's invalid
      // NOT a fetch failure - the fetch succeeded, data is just unparseable
      if (bids.length === 0 || asks.length === 0) {
        console.log(
          `📊 [BOOK_FETCH_PARSE_FAIL] attemptId=${attemptId || "none"} | flow=REST | ${tokenId.slice(0, 12)}... | ` +
            `latency=${latencyMs}ms | raw=${orderbook.bids.length}/${orderbook.asks.length} valid=${bids.length}/${asks.length} | ` +
            `PARSE_FAIL - NO defaults applied (fetchFailed=false)`,
        );

        return {
          source: "REST",
          tokenId,
          bids,
          asks,
          httpStatus: 200,
          latencyMs,
          parsedOk: false,
          rawShape: `raw:${orderbook.bids.length}/${orderbook.asks.length},valid:${bids.length}/${asks.length}`,
          error: "Parsing filtered all levels",
          fetchedAtMs,
          attemptId,
          fetchFailed: false, // Got data, just couldn't parse it all
        };
      }

      // Update the market data store with fresh REST data
      const store = getMarketDataStore();
      store.updateFromRest(tokenId, bids, asks);

      return {
        source: "REST",
        tokenId,
        bids,
        asks,
        bestBid: bids[0].price,
        bestAsk: asks[0].price,
        httpStatus: 200,
        latencyMs,
        parsedOk: true,
        rawShape: `bids:${bids.length},asks:${asks.length}`,
        fetchedAtMs,
        attemptId,
        fetchFailed: false,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const msg = err instanceof Error ? err.message : String(err);

      // Extract HTTP status from error
      let httpStatus: number | undefined;
      if (msg.includes("404")) httpStatus = 404;
      else if (msg.includes("429")) httpStatus = 429;
      else if (msg.includes("500")) httpStatus = 500;

      // Log fetch failure with attemptId - this IS a fetch failure (threw/errored)
      if (!msg.includes("404") && !msg.includes("No orderbook")) {
        console.log(
          `📊 [BOOK_FETCH_ERROR] attemptId=${attemptId || "none"} | flow=REST | ${tokenId.slice(0, 12)}... | ` +
            `latency=${latencyMs}ms | status=${httpStatus ?? "unknown"} | ` +
            `error=${msg.slice(0, 100)} | fetchFailed=true`,
        );
      }

      return {
        source: "REST",
        tokenId,
        bids: [],
        asks: [],
        httpStatus,
        latencyMs,
        parsedOk: false,
        error: msg.slice(0, 200),
        fetchedAtMs,
        attemptId,
        fetchFailed: true, // This is a true fetch failure - threw/errored
      };
    }
  }

  /**
   * Fetch from REST with a single retry on failure
   * Uses a shorter timeout for the retry to avoid blocking too long
   */
  private async fetchFromRestWithRetry(
    tokenId: string,
    attemptId?: string,
  ): Promise<OrderBookSnapshot> {
    // Short delay before retry to give transient issues time to resolve
    await new Promise((resolve) => setTimeout(resolve, 100));
    return this.fetchFromRest(tokenId, attemptId);
  }

  /**
   * Cross-check a dust/empty book with alternate source
   */
  private async crossCheckDustBook(
    tokenId: string,
    primarySnapshot: OrderBookSnapshot,
    primaryHealth: BookHealth,
    flow: string,
    maxSpreadCents: number,
    attemptId?: string,
  ): Promise<ResolveBookResult> {
    // Try WS cache if primary was REST
    if (primarySnapshot.source === "REST") {
      const wsSnapshot = await this.fetchBook(tokenId, "ws_only", attemptId);

      if (wsSnapshot.parsedOk && wsSnapshot.bids.length > 0) {
        const wsHealth = this.evaluateHealth(wsSnapshot, maxSpreadCents);

        console.log(
          `🔍 [DUST_CROSS_CHECK] attemptId=${attemptId || "none"} | flow=${flow} | ${tokenId.slice(0, 12)}... | ` +
            `PRIMARY(${primarySnapshot.source}): bid=${primaryHealth.bestBidCents.toFixed(1)}¢ ask=${primaryHealth.bestAskCents.toFixed(1)}¢ | ` +
            `CONFIRM(WS_CACHE): bid=${wsHealth.bestBidCents.toFixed(1)}¢ ask=${wsHealth.bestAskCents.toFixed(1)}¢ | ` +
            `match=${primaryHealth.status === wsHealth.status ? "YES" : "NO"}`,
        );

        // If WS shows healthy book, use that
        if (wsHealth.healthy) {
          console.log(
            `✅ [BOOK_RECOVERED] attemptId=${attemptId || "none"} | flow=${flow} | ${tokenId.slice(0, 12)}... | ` +
              `WS cache shows valid book, REST was stale`,
          );
          return {
            success: true,
            snapshot: wsSnapshot,
            health: wsHealth,
            crossChecked: true,
            crossCheckSource: "WS_CACHE",
            crossCheckHealth: wsHealth,
          };
        }

        // WS also shows dust/empty
        return {
          success: false,
          snapshot: primarySnapshot,
          health: primaryHealth,
          crossChecked: true,
          crossCheckSource: "WS_CACHE",
          crossCheckHealth: wsHealth,
        };
      }
    }

    // Try REST if primary was WS cache
    if (primarySnapshot.source === "WS_CACHE") {
      const restSnapshot = await this.fetchFromRest(tokenId, attemptId);
      const restHealth = this.evaluateHealth(restSnapshot, maxSpreadCents);

      console.log(
        `🔍 [DUST_CROSS_CHECK] attemptId=${attemptId || "none"} | flow=${flow} | ${tokenId.slice(0, 12)}... | ` +
          `PRIMARY(${primarySnapshot.source}): bid=${primaryHealth.bestBidCents.toFixed(1)}¢ ask=${primaryHealth.bestAskCents.toFixed(1)}¢ | ` +
          `CONFIRM(REST): bid=${restHealth.bestBidCents.toFixed(1)}¢ ask=${restHealth.bestAskCents.toFixed(1)}¢ | ` +
          `match=${primaryHealth.status === restHealth.status ? "YES" : "NO"}`,
      );

      // If REST shows healthy book, use that
      if (restHealth.healthy) {
        console.log(
          `✅ [BOOK_RECOVERED] attemptId=${attemptId || "none"} | flow=${flow} | ${tokenId.slice(0, 12)}... | ` +
            `REST shows valid book, WS cache was stale`,
        );
        return {
          success: true,
          snapshot: restSnapshot,
          health: restHealth,
          crossChecked: true,
          crossCheckSource: "ALT_REST",
          crossCheckHealth: restHealth,
        };
      }

      // REST also shows dust/empty
      return {
        success: false,
        snapshot: primarySnapshot,
        health: primaryHealth,
        crossChecked: true,
        crossCheckSource: "ALT_REST",
        crossCheckHealth: restHealth,
      };
    }

    // No alternate source available - log and return primary
    console.log(
      `⚠️ [DUST_NO_CROSS_CHECK] attemptId=${attemptId || "none"} | flow=${flow} | ${tokenId.slice(0, 12)}... | ` +
        `No alternate source available for cross-check`,
    );

    return {
      success: false,
      snapshot: primarySnapshot,
      health: primaryHealth,
      crossChecked: false,
    };
  }

  /**
   * Evaluate book health using unified thresholds
   *
   * This is the SINGLE source of truth for dust/empty/health classification.
   * Both WHALE and SCAN flows use these same thresholds.
   *
   * IMPORTANT: If snapshot.fetchFailed is true, this returns BOOK_FETCH_FAILED,
   * NOT EMPTY_BOOK. EMPTY_BOOK is reserved for valid responses where the book
   * genuinely has bid<=1¢ AND ask>=99¢.
   */
  evaluateHealth(
    snapshot: OrderBookSnapshot,
    maxSpreadCents: number = BOOK_THRESHOLDS.DEFAULT_MAX_SPREAD_CENTS,
  ): BookHealth {
    // Check for fetch failure FIRST - this takes precedence
    if (snapshot.fetchFailed) {
      return {
        healthy: false,
        status: "BOOK_FETCH_FAILED",
        reason:
          snapshot.error || "Fetch failed (threw/timed-out/invalid response)",
        bestBidCents: 0,
        bestAskCents: 0,
        spreadCents: 0,
        bidsLen: snapshot.bids.length,
        asksLen: snapshot.asks.length,
      };
    }

    // No data (but fetch didn't fail - means empty response or parse error)
    if (
      !snapshot.parsedOk ||
      snapshot.bids.length === 0 ||
      snapshot.asks.length === 0
    ) {
      return {
        healthy: false,
        status: snapshot.error ? "PARSE_ERROR" : "NO_DATA",
        reason: snapshot.error || "No orderbook data available",
        bestBidCents: 0,
        bestAskCents: 0,
        spreadCents: 0,
        bidsLen: snapshot.bids.length,
        asksLen: snapshot.asks.length,
      };
    }

    const bestBid = snapshot.bestBid ?? snapshot.bids[0]?.price ?? 0;
    const bestAsk = snapshot.bestAsk ?? snapshot.asks[0]?.price ?? 0;
    const bestBidCents = bestBid * 100;
    const bestAskCents = bestAsk * 100;
    const spreadCents = bestAskCents - bestBidCents;

    // Check for crossed book (bid > ask) - indicates invalid/corrupted data
    if (bestBidCents > bestAskCents) {
      return {
        healthy: false,
        status: "PARSE_ERROR",
        reason: `Crossed book (bid ${bestBidCents.toFixed(1)}¢ > ask ${bestAskCents.toFixed(1)}¢) - invalid orderbook state`,
        bestBidCents,
        bestAskCents,
        spreadCents,
        bidsLen: snapshot.bids.length,
        asksLen: snapshot.asks.length,
      };
    }

    // Check for empty book (strictest - 1¢/99¢)
    if (
      bestBidCents <= BOOK_THRESHOLDS.EMPTY_BID_CENTS &&
      bestAskCents >= BOOK_THRESHOLDS.EMPTY_ASK_CENTS
    ) {
      return {
        healthy: false,
        status: "EMPTY_BOOK",
        reason: `Empty book: bid ${bestBidCents.toFixed(1)}¢ <= ${BOOK_THRESHOLDS.EMPTY_BID_CENTS}¢ AND ask ${bestAskCents.toFixed(1)}¢ >= ${BOOK_THRESHOLDS.EMPTY_ASK_CENTS}¢`,
        bestBidCents,
        bestAskCents,
        spreadCents,
        bidsLen: snapshot.bids.length,
        asksLen: snapshot.asks.length,
      };
    }

    // Check for dust book (2¢/98¢)
    if (
      bestBidCents <= BOOK_THRESHOLDS.DUST_BID_CENTS &&
      bestAskCents >= BOOK_THRESHOLDS.DUST_ASK_CENTS
    ) {
      return {
        healthy: false,
        status: "DUST_BOOK",
        reason: `Dust book: bid ${bestBidCents.toFixed(1)}¢ <= ${BOOK_THRESHOLDS.DUST_BID_CENTS}¢ AND ask ${bestAskCents.toFixed(1)}¢ >= ${BOOK_THRESHOLDS.DUST_ASK_CENTS}¢`,
        bestBidCents,
        bestAskCents,
        spreadCents,
        bidsLen: snapshot.bids.length,
        asksLen: snapshot.asks.length,
      };
    }

    // Check for ask too high
    if (bestAskCents > BOOK_THRESHOLDS.MAX_ASK_CENTS) {
      return {
        healthy: false,
        status: "ASK_TOO_HIGH",
        reason: `Ask ${bestAskCents.toFixed(1)}¢ > max ${BOOK_THRESHOLDS.MAX_ASK_CENTS}¢`,
        bestBidCents,
        bestAskCents,
        spreadCents,
        bidsLen: snapshot.bids.length,
        asksLen: snapshot.asks.length,
      };
    }

    // Check for wide spread
    if (spreadCents > maxSpreadCents) {
      return {
        healthy: false,
        status: "WIDE_SPREAD",
        reason: `Spread ${spreadCents.toFixed(1)}¢ > max ${maxSpreadCents}¢`,
        bestBidCents,
        bestAskCents,
        spreadCents,
        bidsLen: snapshot.bids.length,
        asksLen: snapshot.asks.length,
      };
    }

    // Healthy book
    return {
      healthy: true,
      status: "OK",
      reason: "Book is healthy",
      bestBidCents,
      bestAskCents,
      spreadCents,
      bidsLen: snapshot.bids.length,
      asksLen: snapshot.asks.length,
    };
  }

  /**
   * Parse raw orderbook levels into normalized format
   */
  private parseLevels(rawLevels: any[]): NormalizedLevel[] {
    return rawLevels
      .map((l: any) => ({
        price: parseFloat(l.price),
        size: parseFloat(l.size),
      }))
      .filter(
        (l: NormalizedLevel) => !isNaN(l.price) && !isNaN(l.size) && l.size > 0,
      );
  }

  /**
   * Normalize OrderbookLevel array to NormalizedLevel array
   */
  private normalizeLevels(levels: OrderbookLevel[]): NormalizedLevel[] {
    return levels.map((l) => ({
      price: l.price,
      size: l.size,
    }));
  }

  /**
   * Log book check in structured format with correlation ID
   */
  private logBookCheck(params: {
    attemptId?: string;
    flow: string;
    tokenIdPrefix: string;
    primarySource: string;
    bidsLen: number;
    asksLen: number;
    bestBid?: number;
    bestAsk?: number;
    health: BookHealth;
    latencyMs: number;
    fetchedAtMs?: number;
  }): void {
    const {
      attemptId,
      flow,
      tokenIdPrefix,
      primarySource,
      bidsLen,
      asksLen,
      bestBid,
      bestAsk,
      health,
      latencyMs,
      fetchedAtMs,
    } = params;

    // Structured JSON log for diagnostics with attemptId for correlation
    console.log(
      JSON.stringify({
        event: "BOOK_CHECK",
        attemptId: attemptId || "none",
        timestamp: new Date().toISOString(),
        fetchedAtMs: fetchedAtMs || null,
        flow,
        tokenIdPrefix,
        primarySource,
        bidsLen,
        asksLen,
        bestBidCents: bestBid ? (bestBid * 100).toFixed(2) : null,
        bestAskCents: bestAsk ? (bestAsk * 100).toFixed(2) : null,
        decision: health.status,
        healthy: health.healthy,
        spreadCents: health.spreadCents.toFixed(2),
        latencyMs,
      }),
    );

    // Human-readable summary with attemptId
    const emoji = health.healthy ? "✅" : "⚠️";
    console.log(
      `${emoji} [BOOK_CHECK] attemptId=${attemptId || "none"} | flow=${flow} | ${tokenIdPrefix}... | ` +
        `source=${primarySource} | bids=${bidsLen} asks=${asksLen} | ` +
        `bid=${health.bestBidCents.toFixed(1)}¢ ask=${health.bestAskCents.toFixed(1)}¢ spread=${health.spreadCents.toFixed(1)}¢ | ` +
        `decision=${health.status}`,
    );
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalResolver: BookResolver | null = null;

/**
 * Get or create the global BookResolver instance
 * @param client - CLOB client (required on first call)
 */
export function getBookResolver(client?: ClobClient): BookResolver {
  if (!globalResolver) {
    if (!client) {
      throw new Error(
        "BookResolver requires ClobClient on first initialization",
      );
    }
    globalResolver = new BookResolver(client);
  }
  return globalResolver;
}

/**
 * Initialize a new global BookResolver
 */
export function initBookResolver(client: ClobClient): BookResolver {
  globalResolver = new BookResolver(client);
  return globalResolver;
}

/**
 * Check if BookResolver is initialized
 */
export function isBookResolverInitialized(): boolean {
  return globalResolver !== null;
}
