/**
 * V2 Positions API
 * Fetch and manage positions from Polymarket Data API
 */

import axios from "axios";
import { POLYMARKET_API, TIMING } from "./constants";

export interface Position {
  tokenId: string;
  conditionId: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  pnlPct: number;
  pnlUsd: number;
  gainCents: number;
  value: number;
  entryTime?: number;
}

// Cache for positions
let positionsCache: Position[] = [];
let lastFetch = 0;

/**
 * Fetch positions for a wallet address
 */
export async function getPositions(
  walletAddress: string,
  forceRefresh = false,
): Promise<Position[]> {
  const now = Date.now();

  // Return cached if fresh
  if (!forceRefresh && now - lastFetch < TIMING.POSITION_CACHE_TTL_MS && positionsCache.length > 0) {
    return positionsCache;
  }

  try {
    const url = `${POLYMARKET_API.DATA_API}/positions?user=${walletAddress}&limit=500`;
    const { data } = await axios.get(url, { timeout: 10000 });

    if (!Array.isArray(data)) {
      return positionsCache;
    }

    positionsCache = data
      .filter((p: any) => {
        const size = Number(p.size) || 0;
        return size > 0 && !p.redeemable;
      })
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

    lastFetch = now;
    return positionsCache;
  } catch (err) {
    console.error(`[Positions] Fetch error: ${err}`);
    return positionsCache;
  }
}

/**
 * Invalidate position cache
 */
export function invalidatePositionCache(): void {
  lastFetch = 0;
}

/**
 * Get cached positions (without fetching)
 */
export function getCachedPositions(): Position[] {
  return positionsCache;
}
