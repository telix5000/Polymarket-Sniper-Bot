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
import { POLYMARKET_API } from "../lib/constants";
import {
  type NormalizedLevel,
  type OrderBookSnapshot,
  type BookHealth,
  type BookHealthStatus,
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
   * Resolve a healthy orderbook for a token
   *
   * This is the MAIN method both WHALE and SCAN flows should use.
   * It handles fetching, validation, and cross-checking in a unified way.
   */
  async resolveHealthyBook(params: ResolveBookParams): Promise<ResolveBookResult> {
    const { tokenId, flow, maxSpreadCents = BOOK_THRESHOLDS.DEFAULT_MAX_SPREAD_CENTS } = params;
    const startTime = Date.now();

    // Try primary source first (WS cache, then REST)
    const primarySnapshot = await this.fetchBook(tokenId, "primary");
    const primaryHealth = this.evaluateHealth(primarySnapshot, maxSpreadCents);

    // Log the initial book check
    this.logBookCheck({
      flow,
      tokenIdPrefix: tokenId.slice(0, 12),
      primarySource: primarySnapshot.source,
      bidsLen: primarySnapshot.bids.length,
      asksLen: primarySnapshot.asks.length,
      bestBid: primarySnapshot.bestBid,
      bestAsk: primarySnapshot.bestAsk,
      health: primaryHealth,
      latencyMs: Date.now() - startTime,
    });

    // If healthy, return immediately
    if (primaryHealth.healthy) {
      return {
        success: true,
        snapshot: primarySnapshot,
        health: primaryHealth,
        crossChecked: false,
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
      );

      // If cross-check found healthy book, use that
      if (crossCheckResult.success && crossCheckResult.snapshot) {
        return crossCheckResult;
      }

      // Both sources confirm dust/empty
      return {
        success: false,
        snapshot: primarySnapshot,
        health: primaryHealth,
        crossChecked: true,
        crossCheckSource: crossCheckResult.crossCheckSource,
        crossCheckHealth: crossCheckResult.crossCheckHealth,
      };
    }

    // Other unhealthy statuses (wide spread, ask too high, etc.)
    return {
      success: false,
      snapshot: primarySnapshot,
      health: primaryHealth,
      crossChecked: false,
    };
  }

  /**
   * Fetch orderbook from a specific source
   */
  private async fetchBook(
    tokenId: string,
    mode: "primary" | "ws_only" | "rest_only",
  ): Promise<OrderBookSnapshot> {
    const store = getMarketDataStore();

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
        };
      }

      // If ws_only mode and no cache, return empty
      if (mode === "ws_only") {
        return {
          source: "WS_CACHE",
          tokenId,
          bids: [],
          asks: [],
          parsedOk: false,
          rawShape: "no_cache",
          error: "No WS cache available",
        };
      }
    }

    // Fetch from REST
    return this.fetchFromRest(tokenId);
  }

  /**
   * Fetch orderbook from REST API with detailed diagnostics
   */
  private async fetchFromRest(tokenId: string): Promise<OrderBookSnapshot> {
    const startTime = Date.now();
    const redactedUrl = `${POLYMARKET_API.CLOB}/book?token_id=${tokenId.slice(0, 12)}...`;

    try {
      const orderbook = await this.client.getOrderBook(tokenId);
      const latencyMs = Date.now() - startTime;

      // Check for empty response - DO NOT default to 0.01/0.99
      if (!orderbook?.bids?.length || !orderbook?.asks?.length) {
        const rawBidsLen = orderbook?.bids?.length ?? 0;
        const rawAsksLen = orderbook?.asks?.length ?? 0;

        console.log(
          `📊 [BOOK_FETCH_EMPTY] flow=REST | ${tokenId.slice(0, 12)}... | ` +
            `latency=${latencyMs}ms | bidsLen=${rawBidsLen} asksLen=${rawAsksLen} | ` +
            `EMPTY - NO defaults applied`,
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
        };
      }

      // Parse and normalize levels
      const bids = this.parseLevels(orderbook.bids);
      const asks = this.parseLevels(orderbook.asks);

      // Check for parsing failures - DO NOT default
      if (bids.length === 0 || asks.length === 0) {
        console.log(
          `📊 [BOOK_FETCH_PARSE_FAIL] flow=REST | ${tokenId.slice(0, 12)}... | ` +
            `latency=${latencyMs}ms | raw=${orderbook.bids.length}/${orderbook.asks.length} valid=${bids.length}/${asks.length} | ` +
            `PARSE_FAIL - NO defaults applied`,
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
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const msg = err instanceof Error ? err.message : String(err);

      // Extract HTTP status from error
      let httpStatus: number | undefined;
      if (msg.includes("404")) httpStatus = 404;
      else if (msg.includes("429")) httpStatus = 429;
      else if (msg.includes("500")) httpStatus = 500;

      // Don't log 404s (market closed) as errors
      if (!msg.includes("404") && !msg.includes("No orderbook")) {
        console.log(
          `📊 [BOOK_FETCH_ERROR] flow=REST | ${tokenId.slice(0, 12)}... | ` +
            `latency=${latencyMs}ms | status=${httpStatus ?? "unknown"} | ` +
            `error=${msg.slice(0, 100)}`,
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
      };
    }
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
  ): Promise<ResolveBookResult> {
    // Try WS cache if primary was REST
    if (primarySnapshot.source === "REST") {
      const wsSnapshot = await this.fetchBook(tokenId, "ws_only");

      if (wsSnapshot.parsedOk && wsSnapshot.bids.length > 0) {
        const wsHealth = this.evaluateHealth(wsSnapshot, maxSpreadCents);

        console.log(
          `🔍 [DUST_CROSS_CHECK] flow=${flow} | ${tokenId.slice(0, 12)}... | ` +
            `PRIMARY(${primarySnapshot.source}): bid=${(primaryHealth.bestBidCents).toFixed(1)}¢ ask=${(primaryHealth.bestAskCents).toFixed(1)}¢ | ` +
            `CONFIRM(WS_CACHE): bid=${(wsHealth.bestBidCents).toFixed(1)}¢ ask=${(wsHealth.bestAskCents).toFixed(1)}¢ | ` +
            `match=${primaryHealth.status === wsHealth.status ? "YES" : "NO"}`,
        );

        // If WS shows healthy book, use that
        if (wsHealth.healthy) {
          console.log(
            `✅ [BOOK_RECOVERED] flow=${flow} | ${tokenId.slice(0, 12)}... | ` +
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
      const restSnapshot = await this.fetchFromRest(tokenId);
      const restHealth = this.evaluateHealth(restSnapshot, maxSpreadCents);

      console.log(
        `🔍 [DUST_CROSS_CHECK] flow=${flow} | ${tokenId.slice(0, 12)}... | ` +
          `PRIMARY(${primarySnapshot.source}): bid=${(primaryHealth.bestBidCents).toFixed(1)}¢ ask=${(primaryHealth.bestAskCents).toFixed(1)}¢ | ` +
          `CONFIRM(REST): bid=${(restHealth.bestBidCents).toFixed(1)}¢ ask=${(restHealth.bestAskCents).toFixed(1)}¢ | ` +
          `match=${primaryHealth.status === restHealth.status ? "YES" : "NO"}`,
      );

      // If REST shows healthy book, use that
      if (restHealth.healthy) {
        console.log(
          `✅ [BOOK_RECOVERED] flow=${flow} | ${tokenId.slice(0, 12)}... | ` +
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
      `⚠️ [DUST_NO_CROSS_CHECK] flow=${flow} | ${tokenId.slice(0, 12)}... | ` +
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
   */
  evaluateHealth(snapshot: OrderBookSnapshot, maxSpreadCents: number = BOOK_THRESHOLDS.DEFAULT_MAX_SPREAD_CENTS): BookHealth {
    // No data
    if (!snapshot.parsedOk || snapshot.bids.length === 0 || snapshot.asks.length === 0) {
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
        (l: NormalizedLevel) =>
          !isNaN(l.price) && !isNaN(l.size) && l.size > 0,
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
   * Log book check in structured format
   */
  private logBookCheck(params: {
    flow: string;
    tokenIdPrefix: string;
    primarySource: string;
    bidsLen: number;
    asksLen: number;
    bestBid?: number;
    bestAsk?: number;
    health: BookHealth;
    latencyMs: number;
  }): void {
    const {
      flow,
      tokenIdPrefix,
      primarySource,
      bidsLen,
      asksLen,
      bestBid,
      bestAsk,
      health,
      latencyMs,
    } = params;

    // Structured JSON log for diagnostics
    console.log(
      JSON.stringify({
        event: "BOOK_CHECK",
        timestamp: new Date().toISOString(),
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

    // Human-readable summary
    const emoji = health.healthy ? "✅" : "⚠️";
    console.log(
      `${emoji} [BOOK_CHECK] flow=${flow} | ${tokenIdPrefix}... | ` +
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
      throw new Error("BookResolver requires ClobClient on first initialization");
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
