/**
 * V2 Copy Trading - Monitor and copy trades
 */

import axios from "axios";
import { POLYMARKET_API } from "./constants";
import type { TradeSignal } from "./types";

const seenTrades = new Set<string>();

/**
 * Fetch recent trades from addresses
 */
export async function fetchRecentTrades(addresses: string[]): Promise<TradeSignal[]> {
  const trades: TradeSignal[] = [];
  const now = Date.now();

  for (const addr of addresses.slice(0, 10)) {
    try {
      const url = `${POLYMARKET_API.DATA}/trades?user=${addr}&limit=5`;
      const { data } = await axios.get(url, { timeout: 5000 });

      if (!Array.isArray(data)) continue;

      for (const t of data) {
        const key = `${t.id || t.timestamp}-${addr}`;
        if (seenTrades.has(key)) continue;

        const ts = new Date(t.timestamp || t.createdAt).getTime();
        if (now - ts > 60000) continue; // Only last 60s

        seenTrades.add(key);
        trades.push({
          tokenId: t.asset || t.tokenId,
          conditionId: t.conditionId,
          marketId: t.marketId,
          outcome: t.outcome || "YES",
          side: t.side?.toUpperCase() === "SELL" ? "SELL" : "BUY",
          sizeUsd: Number(t.size) * Number(t.price) || 0,
          price: Number(t.price) || 0,
          trader: addr,
          timestamp: ts,
        });
      }
    } catch {
      // Continue on error
    }
  }

  // Prune old seen trades
  if (seenTrades.size > 10000) {
    const arr = Array.from(seenTrades);
    arr.slice(0, 5000).forEach((k) => seenTrades.delete(k));
  }

  return trades;
}

/**
 * Clear seen trades (for testing)
 */
export function clearSeenTrades(): void {
  seenTrades.clear();
}
