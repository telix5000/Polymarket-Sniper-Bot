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
}): { bestBid: number | null; bestAsk: number | null; bestBidCents: number; bestAskCents: number } {
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
  const bidPreview = bids.slice(0, 3).map((l) => `${(l.price * 100).toFixed(1)}¢`).join(", ");
  const askPreview = asks.slice(0, 3).map((l) => `${(l.price * 100).toFixed(1)}¢`).join(", ");
  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;

  console.log(
    `📊 [BOOK_NORMALIZED] source=${source} | ${tokenId.slice(0, 12)}... | ` +
      `bestBid=${(bestBid * 100).toFixed(1)}¢ bestAsk=${(bestAsk * 100).toFixed(1)}¢ | ` +
      `bids[${bids.length}]: [${bidPreview}] | asks[${asks.length}]: [${askPreview}]`,
  );
}
