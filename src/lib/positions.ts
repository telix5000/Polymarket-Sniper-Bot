/**
 * V2 Positions - Fetch positions from Polymarket API
 */

import axios from "axios";
import { POLYMARKET_API, TIMING } from "./constants";
import type { Position } from "./types";

let cache: Position[] = [];
let lastFetch = 0;

/**
 * Fetch positions for wallet
 */
export async function getPositions(address: string, force = false): Promise<Position[]> {
  const now = Date.now();
  if (!force && now - lastFetch < TIMING.POSITION_CACHE_MS && cache.length > 0) {
    return cache;
  }

  try {
    const url = `${POLYMARKET_API.DATA}/positions?user=${address}&limit=500`;
    const { data } = await axios.get(url, { timeout: 10000 });

    if (!Array.isArray(data)) return cache;

    cache = data
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

    lastFetch = now;
    return cache;
  } catch {
    return cache;
  }
}

/**
 * Invalidate cache
 */
export function invalidatePositions(): void {
  lastFetch = 0;
}

/**
 * Get cached positions
 */
export function getCachedPositions(): Position[] {
  return cache;
}
