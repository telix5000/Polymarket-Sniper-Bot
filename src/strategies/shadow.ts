/**
 * APEX SHADOW - Copy Trading Strategy
 * 
 * Mirrors trades from successful traders with intelligent filtering
 */

import axios from "axios";
import { POLYMARKET_API } from "../lib/constants";
import type { TradeSignal } from "../lib/types";

const seenTrades = new Set<string>();

export interface ShadowConfig {
  targetAddresses: string[];
  minTradeSize: number;
  maxTradeSize: number;
  onlyBuys: boolean;
  timeWindowSeconds: number;
}

export const DEFAULT_SHADOW_CONFIG: ShadowConfig = {
  targetAddresses: [],
  minTradeSize: 10,
  maxTradeSize: 1000,
  onlyBuys: true,
  timeWindowSeconds: 60,
};

/**
 * Fetch recent trades from target addresses
 */
export async function fetchShadowTrades(
  addresses: string[],
  config: Partial<ShadowConfig> = {},
): Promise<TradeSignal[]> {
  const cfg = { ...DEFAULT_SHADOW_CONFIG, ...config };
  const trades: TradeSignal[] = [];
  const now = Date.now();
  const timeWindow = cfg.timeWindowSeconds * 1000;

  for (const addr of addresses.slice(0, 10)) {
    try {
      const url = `${POLYMARKET_API.DATA}/trades?user=${addr}&limit=5`;
      const { data } = await axios.get(url, { timeout: 5000 });

      if (!Array.isArray(data)) continue;

      for (const t of data) {
        const key = `${t.id || t.timestamp}-${addr}`;
        if (seenTrades.has(key)) continue;

        const ts = new Date(t.timestamp || t.createdAt).getTime();
        if (now - ts > timeWindow) continue;

        const side = t.side?.toUpperCase() === "SELL" ? "SELL" : "BUY";
        if (cfg.onlyBuys && side === "SELL") continue;

        const sizeUsd = Number(t.size) * Number(t.price) || 0;
        if (sizeUsd < cfg.minTradeSize || sizeUsd > cfg.maxTradeSize) continue;

        seenTrades.add(key);
        trades.push({
          tokenId: t.asset || t.tokenId,
          conditionId: t.conditionId,
          marketId: t.marketId,
          outcome: t.outcome || "YES",
          side,
          sizeUsd,
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
 * Filter trades for quality
 */
export function filterQualityTrades(
  trades: TradeSignal[],
  minConfidence: number = 0.3,
): TradeSignal[] {
  return trades.filter((trade) => {
    // Skip extreme prices (likely arbitrage or mistakes)
    if (trade.price < 0.1 || trade.price > 0.9) return false;

    // Skip very small trades
    if (trade.sizeUsd < 10) return false;

    return true;
  });
}

/**
 * Get trader performance summary
 */
export interface TraderStats {
  address: string;
  totalTrades: number;
  recentTrades: number;
  avgTradeSize: number;
}

export function getTraderStats(trades: TradeSignal[]): TraderStats[] {
  const statsByTrader = new Map<string, TraderStats>();

  for (const trade of trades) {
    const stats = statsByTrader.get(trade.trader) || {
      address: trade.trader,
      totalTrades: 0,
      recentTrades: 0,
      avgTradeSize: 0,
    };

    stats.totalTrades++;
    const recentCutoff = Date.now() - 60 * 60 * 1000; // Last hour
    if (trade.timestamp > recentCutoff) {
      stats.recentTrades++;
    }

    // Update rolling average
    stats.avgTradeSize =
      (stats.avgTradeSize * (stats.totalTrades - 1) + trade.sizeUsd) / stats.totalTrades;

    statsByTrader.set(trade.trader, stats);
  }

  return Array.from(statsByTrader.values());
}

/**
 * Clear seen trades (for testing)
 */
export function clearSeenTrades(): void {
  seenTrades.clear();
}
