/**
 * V2 Positions - Fetch positions from Polymarket API
 * 
 * IMPORTANT: This module fetches FRESH data from the API on every call.
 * Position data should never be stale in a trading bot - caching can cause
 * serious issues like showing positions that have already been liquidated.
 * 
 * The cache is ONLY used as a fallback when the API call fails.
 */

import axios from "axios";
import { POLYMARKET_API } from "./constants";
import type { Position } from "./types";

// Cache is ONLY used as fallback when API fails - not for normal operation
let fallbackCache: Position[] = [];

/**
 * Fetch positions for wallet - ALWAYS fetches fresh data from API
 * 
 * @param address - Wallet address to fetch positions for
 * @param _force - Deprecated parameter, kept for backwards compatibility. 
 *                 Positions are always fetched fresh now.
 */
export async function getPositions(address: string, _force = false): Promise<Position[]> {
  try {
    const url = `${POLYMARKET_API.DATA}/positions?user=${address}&limit=500`;
    const { data } = await axios.get(url, { timeout: 10000 });

    if (!Array.isArray(data)) return fallbackCache;

    const positions = data
      .filter((p: any) => Number(p.size) > 0 && !p.redeemable)
      .map((p: any) => {
        const size = Number(p.size) || 0;
        const avgPrice = Number(p.avgPrice) || 0;
        const curPrice = Number(p.curPrice) || 0;
        const value = size * curPrice;
        const cost = size * avgPrice;
        const pnlUsd = value - cost;
        const pnlPct = cost > 0 ? (pnlUsd / cost) * 100 : 0;

        return {
          tokenId: p.asset,
          conditionId: p.conditionId,
          marketId: p.marketId,
          outcome: p.outcome || "YES",
          size,
          avgPrice,
          curPrice,
          pnlPct,
          pnlUsd,
          gainCents: (curPrice - avgPrice) * 100,
          value,
        };
      });

    // Update fallback cache with fresh data
    fallbackCache = positions;
    return positions;
  } catch {
    // Only use cache as fallback when API fails
    return fallbackCache;
  }
}

/**
 * Invalidate cache - clears the fallback cache
 * Call this after any trade action to ensure stale data isn't used as fallback
 */
export function invalidatePositions(): void {
  fallbackCache = [];
}

/**
 * Get cached positions (fallback data only)
 * WARNING: This returns potentially stale data. Use getPositions() for fresh data.
 */
export function getCachedPositions(): Position[] {
  return fallbackCache;
}
