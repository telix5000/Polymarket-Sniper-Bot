/**
 * Market Snapshot Module
 *
 * Provides immutable market snapshots for execution attempts.
 * Ensures that once a snapshot is created for an attempt, the same snapshot
 * is used throughout pricing and order placement - preventing bugs where
 * the book changes mid-execution.
 *
 * Key features:
 * - Immutable snapshots with unique attemptId for correlation
 * - Cache safety: dust/empty books don't overwrite healthy cached data
 * - Correlation logging for debugging snapshot-related issues
 */

import type { ClobClient } from "@polymarket/clob-client";
import { getMarketDataStore, type OrderbookLevel } from "./market-data-store";
import {
  type MarketSnapshot,
  type MarketSnapshotStatus,
  BOOK_THRESHOLDS,
} from "../book/types";

// ============================================================================
// Constants
// ============================================================================

/** Counter for generating monotonic attempt IDs */
let attemptCounter = 0;

/** Threshold for dust bid in decimal (0.02 = 2 cents) */
const DUST_BID_DECIMAL = BOOK_THRESHOLDS.DUST_BID_CENTS / 100;

/** Threshold for dust ask in decimal (0.98 = 98 cents) */
const DUST_ASK_DECIMAL = BOOK_THRESHOLDS.DUST_ASK_CENTS / 100;

/** Threshold for empty bid in decimal (0.01 = 1 cent) */
const EMPTY_BID_DECIMAL = BOOK_THRESHOLDS.EMPTY_BID_CENTS / 100;

/** Threshold for empty ask in decimal (0.99 = 99 cents) */
const EMPTY_ASK_DECIMAL = BOOK_THRESHOLDS.EMPTY_ASK_CENTS / 100;

// ============================================================================
// Attempt ID Generation
// ============================================================================

/**
 * Generate a unique attempt ID for correlation logging.
 * Format: "attempt-{timestamp}-{counter}" for easy sorting and debugging.
 */
export function generateAttemptId(): string {
  attemptCounter++;
  return `attempt-${Date.now()}-${attemptCounter}`;
}

/**
 * Reset the attempt counter (for testing only)
 */
export function _resetAttemptCounter(): void {
  attemptCounter = 0;
}

// ============================================================================
// Book Status Classification
// ============================================================================

/**
 * Classify the health status of a book based on bid/ask prices.
 * This is the single source of truth for determining if a book is tradeable.
 */
export function classifyBookStatus(
  bestBid: number | undefined | null,
  bestAsk: number | undefined | null,
  maxSpreadCents: number = BOOK_THRESHOLDS.DEFAULT_MAX_SPREAD_CENTS,
): { status: MarketSnapshotStatus; reason?: string } {
  // Check for missing/invalid data
  if (
    bestBid === undefined ||
    bestBid === null ||
    bestAsk === undefined ||
    bestAsk === null ||
    !Number.isFinite(bestBid) ||
    !Number.isFinite(bestAsk)
  ) {
    return {
      status: "INVALID_BOOK",
      reason: "Missing or invalid bid/ask prices",
    };
  }

  // Check for crossed book (bid > ask)
  if (bestBid > bestAsk) {
    return {
      status: "CROSSED_BOOK",
      reason: `Crossed book: bid ${(bestBid * 100).toFixed(1)}¢ > ask ${(bestAsk * 100).toFixed(1)}¢`,
    };
  }

  // Check for empty book (strictest - 1¢/99¢)
  if (bestBid <= EMPTY_BID_DECIMAL && bestAsk >= EMPTY_ASK_DECIMAL) {
    return {
      status: "EMPTY_BOOK",
      reason: `Empty book: bid ${(bestBid * 100).toFixed(1)}¢ <= ${BOOK_THRESHOLDS.EMPTY_BID_CENTS}¢ AND ask ${(bestAsk * 100).toFixed(1)}¢ >= ${BOOK_THRESHOLDS.EMPTY_ASK_CENTS}¢`,
    };
  }

  // Check for dust book (2¢/98¢)
  if (bestBid <= DUST_BID_DECIMAL && bestAsk >= DUST_ASK_DECIMAL) {
    return {
      status: "DUST_BOOK",
      reason: `Dust book: bid ${(bestBid * 100).toFixed(1)}¢ <= ${BOOK_THRESHOLDS.DUST_BID_CENTS}¢ AND ask ${(bestAsk * 100).toFixed(1)}¢ >= ${BOOK_THRESHOLDS.DUST_ASK_CENTS}¢`,
    };
  }

  // Check for ask too high
  if (bestAsk * 100 > BOOK_THRESHOLDS.MAX_ASK_CENTS) {
    return {
      status: "ASK_TOO_HIGH",
      reason: `Ask ${(bestAsk * 100).toFixed(1)}¢ > max ${BOOK_THRESHOLDS.MAX_ASK_CENTS}¢`,
    };
  }

  // Check for wide spread
  const spreadCents = (bestAsk - bestBid) * 100;
  if (spreadCents > maxSpreadCents) {
    return {
      status: "WIDE_SPREAD",
      reason: `Spread ${spreadCents.toFixed(1)}¢ > max ${maxSpreadCents}¢`,
    };
  }

  return { status: "HEALTHY" };
}

/**
 * Check if a book status indicates dust/empty/dead (unhealthy for caching)
 */
export function isDustOrEmptyStatus(status: MarketSnapshotStatus): boolean {
  return (
    status === "DUST_BOOK" || status === "EMPTY_BOOK" || status === "DEAD_BOOK"
  );
}

// ============================================================================
// Snapshot Creation
// ============================================================================

/**
 * Create an immutable MarketSnapshot from raw book data.
 *
 * @param params - Parameters for creating the snapshot
 * @returns Frozen (immutable) MarketSnapshot
 */
export function createMarketSnapshot(params: {
  tokenId: string;
  marketId?: string;
  bestBid: number;
  bestAsk: number;
  source: MarketSnapshot["source"];
  attemptId?: string;
  maxSpreadCents?: number;
}): MarketSnapshot {
  const {
    tokenId,
    marketId,
    bestBid,
    bestAsk,
    source,
    attemptId = generateAttemptId(),
    maxSpreadCents,
  } = params;

  const mid = (bestBid + bestAsk) / 2;
  const spreadCents = (bestAsk - bestBid) * 100;
  const { status, reason } = classifyBookStatus(
    bestBid,
    bestAsk,
    maxSpreadCents,
  );

  const snapshot: MarketSnapshot = {
    tokenId,
    marketId,
    bestBid,
    bestAsk,
    mid,
    spreadCents,
    bookStatus: status,
    source,
    fetchedAtMs: Date.now(),
    attemptId,
    unhealthyReason: status !== "HEALTHY" ? reason : undefined,
  };

  // Freeze the snapshot to make it truly immutable
  return Object.freeze(snapshot);
}

// ============================================================================
// Snapshot Fetching
// ============================================================================

/**
 * Fetch a fresh market snapshot for an execution attempt.
 *
 * This function fetches from the CLOB API (REST) and creates an immutable snapshot.
 * The snapshot is frozen and should be used throughout the entire execution attempt.
 *
 * @param client - CLOB client for API calls
 * @param tokenId - Token ID to fetch
 * @param marketId - Optional market ID for logging
 * @param attemptId - Optional attempt ID (generated if not provided)
 * @returns MarketSnapshot (frozen/immutable)
 */
export async function fetchMarketSnapshot(
  client: ClobClient,
  tokenId: string,
  marketId?: string,
  attemptId?: string,
): Promise<MarketSnapshot> {
  const resolvedAttemptId = attemptId ?? generateAttemptId();
  const startTime = Date.now();

  // Try WS cache first
  const store = getMarketDataStore();
  const cached = store.get(tokenId);
  const cachedOrderbook = store.getOrderbook(tokenId);

  if (cached && cachedOrderbook && !store.isStale(tokenId)) {
    const bids = cachedOrderbook.bids;
    const asks = cachedOrderbook.asks;

    if (bids.length > 0 && asks.length > 0) {
      const snapshot = createMarketSnapshot({
        tokenId,
        marketId,
        bestBid: bids[0].price,
        bestAsk: asks[0].price,
        source: "WS_CACHE",
        attemptId: resolvedAttemptId,
      });

      logBookSnapshotSelected(snapshot, Date.now() - startTime);
      return snapshot;
    }
  }

  // Fetch from REST
  try {
    const orderbook = await client.getOrderBook(tokenId);
    const latencyMs = Date.now() - startTime;

    if (!orderbook?.bids?.length || !orderbook?.asks?.length) {
      // Empty response - create snapshot with no data
      const snapshot = createMarketSnapshot({
        tokenId,
        marketId,
        bestBid: 0.01, // Placeholder for logging only
        bestAsk: 0.99, // Placeholder for logging only
        source: "REST",
        attemptId: resolvedAttemptId,
      });

      logBookSnapshotSelected(snapshot, latencyMs);
      return snapshot;
    }

    // Parse best bid and ask
    const bestBid = parseFloat(orderbook.bids[0].price);
    const bestAsk = parseFloat(orderbook.asks[0].price);

    const snapshot = createMarketSnapshot({
      tokenId,
      marketId,
      bestBid,
      bestAsk,
      source: "REST",
      attemptId: resolvedAttemptId,
    });

    // Update cache ONLY if not dust/empty (cache safety rule)
    updateCacheWithSafety(
      tokenId,
      orderbook.bids,
      orderbook.asks,
      snapshot.bookStatus,
    );

    logBookSnapshotSelected(snapshot, latencyMs);
    return snapshot;
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);

    console.log(
      JSON.stringify({
        event: "BOOK_SNAPSHOT_FETCH_ERROR",
        attemptId: resolvedAttemptId,
        tokenIdPrefix: tokenId.slice(0, 12),
        error: errorMsg.slice(0, 100),
        latencyMs,
        timestamp: new Date().toISOString(),
      }),
    );

    // Return a snapshot indicating no data
    return createMarketSnapshot({
      tokenId,
      marketId,
      bestBid: 0.01,
      bestAsk: 0.99,
      source: "REST",
      attemptId: resolvedAttemptId,
    });
  }
}

// ============================================================================
// Cache Safety
// ============================================================================

/**
 * Update cache with safety checks - dust/empty snapshots don't overwrite healthy data.
 *
 * This implements the "doNotCacheDust" rule: if we fetch a dust or empty book from REST,
 * we should NOT overwrite an existing healthy cache entry. This prevents the scenario
 * where a healthy WS cache is replaced by a stale/dust REST response.
 */
export function updateCacheWithSafety(
  tokenId: string,
  bids: Array<{ price: string; size: string }>,
  asks: Array<{ price: string; size: string }>,
  newStatus: MarketSnapshotStatus,
): boolean {
  const store = getMarketDataStore();
  const existing = store.get(tokenId);

  // If the new data is dust/empty
  if (isDustOrEmptyStatus(newStatus)) {
    // Check if we have existing healthy data
    if (existing) {
      const existingStatus = classifyBookStatus(
        existing.bestBid,
        existing.bestAsk,
      );

      if (existingStatus.status === "HEALTHY") {
        // DO NOT overwrite healthy cache with dust/empty
        console.log(
          JSON.stringify({
            event: "CACHE_DUST_REJECTED",
            tokenIdPrefix: tokenId.slice(0, 12),
            newStatus,
            existingBid: (existing.bestBid * 100).toFixed(1),
            existingAsk: (existing.bestAsk * 100).toFixed(1),
            message:
              "Dust/empty REST response NOT cached - existing healthy data preserved",
            timestamp: new Date().toISOString(),
          }),
        );
        return false;
      }
    }
  }

  // Safe to update cache
  const normalizedBids: OrderbookLevel[] = bids.map((b) => ({
    price: parseFloat(b.price),
    size: parseFloat(b.size),
  }));
  const normalizedAsks: OrderbookLevel[] = asks.map((a) => ({
    price: parseFloat(a.price),
    size: parseFloat(a.size),
  }));

  store.updateFromRest(tokenId, normalizedBids, normalizedAsks);
  return true;
}

// ============================================================================
// Correlation Logging
// ============================================================================

/**
 * Log when a book snapshot is selected for an execution attempt.
 * This provides correlation between the snapshot and subsequent operations.
 */
export function logBookSnapshotSelected(
  snapshot: MarketSnapshot,
  latencyMs: number,
): void {
  console.log(
    JSON.stringify({
      event: "BOOK_SNAPSHOT_SELECTED",
      attemptId: snapshot.attemptId,
      tokenIdPrefix: snapshot.tokenId.slice(0, 12),
      bidCents: (snapshot.bestBid * 100).toFixed(2),
      askCents: (snapshot.bestAsk * 100).toFixed(2),
      spreadCents: snapshot.spreadCents.toFixed(2),
      source: snapshot.source,
      bookStatus: snapshot.bookStatus,
      fetchedAtMs: snapshot.fetchedAtMs,
      latencyMs,
      timestamp: new Date().toISOString(),
    }),
  );
}

/**
 * Check if the current book matches the snapshot and log a bug if it doesn't.
 * This is a safety check to detect if the book changed during an execution attempt.
 *
 * @param snapshot - The original snapshot for this attempt
 * @param currentBid - Current best bid being used
 * @param currentAsk - Current best ask being used
 * @param location - Description of where in the code this check is happening
 * @returns true if book matches, false if mismatch detected (bug!)
 */
export function assertSnapshotIntegrity(
  snapshot: MarketSnapshot,
  currentBid: number,
  currentAsk: number,
  location: string,
): boolean {
  // Allow small floating point differences (0.0001 = 0.01 cents)
  const epsilon = 0.0001;

  const bidMatch = Math.abs(snapshot.bestBid - currentBid) < epsilon;
  const askMatch = Math.abs(snapshot.bestAsk - currentAsk) < epsilon;

  if (!bidMatch || !askMatch) {
    console.error(
      JSON.stringify({
        event: "BUG_BOOK_CHANGED_DURING_ATTEMPT",
        severity: "CRITICAL",
        attemptId: snapshot.attemptId,
        tokenIdPrefix: snapshot.tokenId.slice(0, 12),
        location,
        snapshotBid: (snapshot.bestBid * 100).toFixed(2),
        snapshotAsk: (snapshot.bestAsk * 100).toFixed(2),
        currentBid: (currentBid * 100).toFixed(2),
        currentAsk: (currentAsk * 100).toFixed(2),
        snapshotFetchedAt: snapshot.fetchedAtMs,
        timeSinceSnapshotMs: Date.now() - snapshot.fetchedAtMs,
        message:
          "CRITICAL BUG: Book data changed during execution attempt! Failing fast.",
        timestamp: new Date().toISOString(),
      }),
    );
    return false;
  }

  return true;
}

/**
 * Check if a snapshot is healthy for execution.
 */
export function isSnapshotHealthy(snapshot: MarketSnapshot): boolean {
  return snapshot.bookStatus === "HEALTHY";
}

// ============================================================================
// Exports
// ============================================================================

export type { MarketSnapshot };
