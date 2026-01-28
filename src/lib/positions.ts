/**
 * V2 Positions - Fetch positions from Polymarket API
 *
 * API Reference: https://docs.polymarket.com/developers/misc-endpoints/data-api-get-positions
 *
 * Query Parameters:
 *   - user (required): Wallet address (EOA - the API handles proxy wallet lookup internally)
 *   - sizeThreshold: Minimum position size (default: 1)
 *   - redeemable: Filter for redeemable positions only
 *   - limit: Max results (default: 100, max: 500)
 *
 * Response fields include: proxyWallet, asset, conditionId, size, avgPrice, curPrice, redeemable, etc.
 * Note: The API returns positions for the EOA and includes the proxyWallet field showing where they're held.
 */

import axios from "axios";
import { POLYMARKET_API } from "./constants";
import type { Position } from "./types";

// Cache is ONLY used as fallback when API fails
let cache: Position[] = [];

/**
 * Convert raw API position to our Position type
 */
function mapPosition(p: any): Position {
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
}

/**
 * Fetch positions for wallet
 * Always fetches fresh data from API; cache is only used as fallback on failure
 *
 * Note: Pass the EOA address - the API handles proxy wallet lookup internally
 * and returns all positions regardless of whether they're held in EOA or proxy.
 */
export async function getPositions(
  address: string,
  _force = false,
): Promise<Position[]> {
  try {
    // Use sizeThreshold=0 to get ALL positions including very small ones
    // The API handles proxy wallet lookup internally when you pass the EOA
    const url = `${POLYMARKET_API.DATA}/positions?user=${address}&sizeThreshold=0&limit=500`;
    const { data } = await axios.get(url, { timeout: 15000 });

    if (!Array.isArray(data)) {
      console.warn(`⚠️ Positions API returned non-array: ${typeof data}`);
      return cache;
    }

    if (data.length > 0) {
      console.log(
        `📦 API returned ${data.length} positions for ${address.slice(0, 10)}...`,
      );
    }

    // Filter: keep positions with size > 0 that aren't redeemable
    const filtered = data.filter((p: any) => {
      const size = Number(p.size) || 0;
      const isRedeemable = p.redeemable === true || p.redeemable === "true";
      return size > 0 && !isRedeemable;
    });

    if (data.length > 0 && filtered.length !== data.length) {
      const redeemableCount = data.filter(
        (p: any) => p.redeemable === true || p.redeemable === "true",
      ).length;
      const zeroSizeCount = data.filter((p: any) => Number(p.size) <= 0).length;
      console.log(
        `📊 Filtered: ${filtered.length} active, ${redeemableCount} redeemable, ${zeroSizeCount} zero-size`,
      );
    }

    cache = filtered.map(mapPosition);
    return cache;
  } catch (err) {
    // Log the full error for debugging
    if (axios.isAxiosError(err)) {
      console.warn(`⚠️ Position fetch error: ${err.message}`);
      if (err.response) {
        console.warn(`   Status: ${err.response.status}`);
      }
    } else {
      console.warn(
        `⚠️ Position fetch error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Return cached data as fallback when API fails
    return cache;
  }
}

/**
 * Invalidate cache
 * Note: With fresh-data-first approach, this is a no-op but kept for API compatibility
 */
export function invalidatePositions(): void {
  // No-op: positions are always fetched fresh now
  // Cache is only used as fallback when API fails
}

/**
 * Get cached positions
 */
export function getCachedPositions(): Position[] {
  return cache;
}
