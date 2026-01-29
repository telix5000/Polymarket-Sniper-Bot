/**
 * Orderbook Normalization Utilities
 *
 * Polymarket APIs return orderbook data in various sort orders:
 * - REST /book: bids ascending (worst first), asks descending (worst first)
 * - WebSocket L2: bids ascending (worst first), asks ascending (best first)
 *
 * This module normalizes all orderbook data to a consistent format:
 * - Bids: sorted DESCENDING (best/highest price first at index 0)
 * - Asks: sorted ASCENDING (best/lowest price first at index 0)
 *
 * After normalization, `bids[0]` is always the best bid and `asks[0]` is always the best ask.
 */

import type { OrderbookLevel } from "./market-data-store";

/**
 * Sort bids in descending order (best/highest price first)
 * After sorting, bids[0] is the best bid
 */
export function sortBidsDescending(bids: OrderbookLevel[]): OrderbookLevel[] {
  return [...bids].sort((a, b) => b.price - a.price);
}

/**
 * Sort asks in ascending order (best/lowest price first)
 * After sorting, asks[0] is the best ask
 */
export function sortAsksAscending(asks: OrderbookLevel[]): OrderbookLevel[] {
  return [...asks].sort((a, b) => a.price - b.price);
}

/**
 * Normalize orderbook levels to standard format
 * - Bids: descending (best first)
 * - Asks: ascending (best first)
 *
 * @param bids - Raw bid levels (any order)
 * @param asks - Raw ask levels (any order)
 * @returns Normalized { bids, asks } with best prices at index 0
 */
export function normalizeOrderbook(
  bids: OrderbookLevel[],
  asks: OrderbookLevel[],
): { bids: OrderbookLevel[]; asks: OrderbookLevel[] } {
  return {
    bids: sortBidsDescending(bids),
    asks: sortAsksAscending(asks),
  };
}

/**
 * Parse raw orderbook levels from API response
 * Handles string prices/sizes and filters invalid entries
 *
 * @param rawLevels - Raw levels from API (price/size as strings)
 * @returns Parsed OrderbookLevel array (not yet sorted)
 */
export function parseRawLevels(
  rawLevels: Array<{ price: string; size: string }> | undefined,
): OrderbookLevel[] {
  if (!rawLevels || !Array.isArray(rawLevels)) {
    return [];
  }

  return rawLevels
    .map((l) => ({
      price: parseFloat(l.price),
      size: parseFloat(l.size),
    }))
    .filter((l) => !isNaN(l.price) && !isNaN(l.size) && l.size > 0);
}

/**
 * Parse and normalize orderbook from REST API response
 *
 * REST /book returns:
 * - bids: ascending (worst first) - e.g., [0.001, 0.002, ..., 0.682]
 * - asks: descending (worst first) - e.g., [0.999, 0.998, ..., 0.684]
 *
 * This function normalizes to:
 * - bids: descending (best first) - e.g., [0.682, ..., 0.002, 0.001]
 * - asks: ascending (best first) - e.g., [0.684, ..., 0.998, 0.999]
 */
export function normalizeRestOrderbook(orderbook: {
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
}): { bids: OrderbookLevel[]; asks: OrderbookLevel[] } {
  const rawBids = parseRawLevels(orderbook.bids);
  const rawAsks = parseRawLevels(orderbook.asks);

  return normalizeOrderbook(rawBids, rawAsks);
}

/**
 * Parse and normalize orderbook from WebSocket L2 message
 *
 * WebSocket book message returns:
 * - bids: ascending (worst first) - e.g., [0.48, 0.49, 0.50]
 * - asks: ascending (best first) - e.g., [0.52, 0.53, 0.54]
 *
 * This function normalizes to:
 * - bids: descending (best first) - e.g., [0.50, 0.49, 0.48]
 * - asks: ascending (best first) - e.g., [0.52, 0.53, 0.54] (already correct)
 */
export function normalizeWsOrderbook(message: {
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
}): { bids: OrderbookLevel[]; asks: OrderbookLevel[] } {
  const rawBids = parseRawLevels(message.bids);
  const rawAsks = parseRawLevels(message.asks);

  return normalizeOrderbook(rawBids, rawAsks);
}

/**
 * Get best bid and ask from normalized orderbook
 * Assumes orderbook is already normalized (bids desc, asks asc)
 */
export function getBestPrices(
  bids: OrderbookLevel[],
  asks: OrderbookLevel[],
): { bestBid: number | null; bestAsk: number | null } {
  return {
    bestBid: bids.length > 0 ? bids[0].price : null,
    bestAsk: asks.length > 0 ? asks[0].price : null,
  };
}

/**
 * Get best bid and ask from a RAW orderbook response (not normalized)
 * This handles the Polymarket API's unusual sorting where worst prices are first.
 *
 * USE THIS when you have a raw orderbook from client.getOrderBook() and need best prices.
 * It sorts internally and returns the correct best prices.
 *
 * @param orderbook - Raw orderbook from Polymarket API
 * @returns Best bid and ask prices, or null if not available
 */
export function getBestPricesFromRaw(orderbook: {
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
}): {
  bestBid: number | null;
  bestAsk: number | null;
  bestBidCents: number;
  bestAskCents: number;
} {
  const { bids, asks } = normalizeRestOrderbook(orderbook);

  const bestBid = bids.length > 0 ? bids[0].price : null;
  const bestAsk = asks.length > 0 ? asks[0].price : null;

  return {
    bestBid,
    bestAsk,
    bestBidCents: bestBid ? bestBid * 100 : 0,
    bestAskCents: bestAsk ? bestAsk * 100 : 0,
  };
}

/**
 * Log orderbook diagnostic info (first 3 levels each side)
 */
export function logOrderbookDiagnostic(
  source: string,
  tokenId: string,
  bids: OrderbookLevel[],
  asks: OrderbookLevel[],
): void {
  const bidPreview = bids
    .slice(0, 3)
    .map((l) => `${(l.price * 100).toFixed(1)}¢`)
    .join(", ");
  const askPreview = asks
    .slice(0, 3)
    .map((l) => `${(l.price * 100).toFixed(1)}¢`)
    .join(", ");
  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;

  console.log(
    `📊 [BOOK_NORMALIZED] source=${source} | ${tokenId.slice(0, 12)}... | ` +
      `bestBid=${(bestBid * 100).toFixed(1)}¢ bestAsk=${(bestAsk * 100).toFixed(1)}¢ | ` +
      `bids[${bids.length}]: [${bidPreview}] | asks[${asks.length}]: [${askPreview}]`,
  );
}

// ============================================================================
// Fast-Path Price Check (API-level filtering)
// ============================================================================

/**
 * Quick price check result from /price endpoint
 */
export interface QuickPriceCheck {
  bestBid: number | null;
  bestAsk: number | null;
  bestBidCents: number;
  bestAskCents: number;
  spreadCents: number;
  midCents: number;
  isDustBook: boolean;
  isValidSpread: boolean;
  latencyMs: number;
}

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
 * @param clobBaseUrl - Base URL for CLOB API (e.g., "https://clob.polymarket.com")
 * @param tokenId - The token ID to check
 * @param maxSpreadCents - Maximum acceptable spread in cents (default: 50)
 * @returns Quick price check result
 */
export async function quickPriceCheck(
  clobBaseUrl: string,
  tokenId: string,
  maxSpreadCents: number = 50,
): Promise<QuickPriceCheck> {
  const startTime = Date.now();

  try {
    // Fetch best bid and ask prices in parallel (very lightweight calls)
    const [bidResponse, askResponse] = await Promise.all([
      fetch(`${clobBaseUrl}/price?token_id=${tokenId}&side=sell`),
      fetch(`${clobBaseUrl}/price?token_id=${tokenId}&side=buy`),
    ]);

    const latencyMs = Date.now() - startTime;

    if (!bidResponse.ok || !askResponse.ok) {
      return {
        bestBid: null,
        bestAsk: null,
        bestBidCents: 0,
        bestAskCents: 0,
        spreadCents: 0,
        midCents: 0,
        isDustBook: true,
        isValidSpread: false,
        latencyMs,
      };
    }

    const bidData = await bidResponse.json();
    const askData = await askResponse.json();

    const bestBid = parseFloat(bidData.price);
    const bestAsk = parseFloat(askData.price);

    if (isNaN(bestBid) || isNaN(bestAsk)) {
      return {
        bestBid: null,
        bestAsk: null,
        bestBidCents: 0,
        bestAskCents: 0,
        spreadCents: 0,
        midCents: 0,
        isDustBook: true,
        isValidSpread: false,
        latencyMs,
      };
    }

    const bestBidCents = bestBid * 100;
    const bestAskCents = bestAsk * 100;
    const spreadCents = bestAskCents - bestBidCents;
    const midCents = (bestBidCents + bestAskCents) / 2;

    // Check for dust book (bid <= 2¢ AND ask >= 98¢)
    const isDustBook = bestBidCents <= 2 && bestAskCents >= 98;

    // Check for valid spread
    const isValidSpread = spreadCents <= maxSpreadCents && spreadCents >= 0;

    return {
      bestBid,
      bestAsk,
      bestBidCents,
      bestAskCents,
      spreadCents,
      midCents,
      isDustBook,
      isValidSpread,
      latencyMs,
    };
  } catch (error) {
    return {
      bestBid: null,
      bestAsk: null,
      bestBidCents: 0,
      bestAskCents: 0,
      spreadCents: 0,
      midCents: 0,
      isDustBook: true,
      isValidSpread: false,
      latencyMs: Date.now() - startTime,
    };
  }
}

/**
 * Check if a market passes basic price filters using fast-path
 *
 * @param clobBaseUrl - Base URL for CLOB API
 * @param tokenId - Token ID to check
 * @param minPriceCents - Minimum acceptable price (default: 5¢)
 * @param maxPriceCents - Maximum acceptable price (default: 95¢)
 * @param maxSpreadCents - Maximum acceptable spread (default: 50¢)
 * @returns true if market passes filters, false otherwise
 */
export async function quickFilterCheck(
  clobBaseUrl: string,
  tokenId: string,
  minPriceCents: number = 5,
  maxPriceCents: number = 95,
  maxSpreadCents: number = 50,
): Promise<{ passes: boolean; reason?: string; check: QuickPriceCheck }> {
  const check = await quickPriceCheck(clobBaseUrl, tokenId, maxSpreadCents);

  if (check.bestBid === null || check.bestAsk === null) {
    return { passes: false, reason: "NO_PRICE_DATA", check };
  }

  if (check.isDustBook) {
    return { passes: false, reason: "DUST_BOOK", check };
  }

  if (!check.isValidSpread) {
    return {
      passes: false,
      reason: `WIDE_SPREAD_${check.spreadCents.toFixed(0)}c`,
      check,
    };
  }

  if (check.bestAskCents < minPriceCents) {
    return {
      passes: false,
      reason: `PRICE_TOO_LOW_${check.bestAskCents.toFixed(0)}c`,
      check,
    };
  }

  if (check.bestAskCents > maxPriceCents) {
    return {
      passes: false,
      reason: `PRICE_TOO_HIGH_${check.bestAskCents.toFixed(0)}c`,
      check,
    };
  }

  return { passes: true, check };
}
