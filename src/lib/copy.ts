/**
 * V2 Copy Trading - Monitor and copy whale trades
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHALE DETECTION - CORRECT ARCHITECTURE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * SOURCE OF TRUTH: Polymarket DATA API
 *
 * Flow:
 * 1) Fetch leaderboard → extract proxyWallets (NOT EOAs)
 * 2) Track top ~99 wallets
 * 3) For each proxyWallet, poll /trades endpoint
 * 4) Use timestamp-based cursor to avoid reprocessing
 * 5) Deduplicate using: (transactionHash + conditionId + outcomeIndex + side + size)
 *
 * CRITICAL: Whale trades are SIGNALS, not execution instructions.
 * They inform the bias, which grants PERMISSION to trade.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import axios from "axios";
import { POLYMARKET_API } from "./constants";
import type { TradeSignal } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// DEDUPLICATION - Using correct composite key
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate a unique deduplication key for a trade
 * Uses the composite: transactionHash + conditionId + outcomeIndex + side + size
 *
 * This is more robust than just id or timestamp because:
 * - transactionHash uniquely identifies the on-chain settlement
 * - conditionId + outcomeIndex identifies the specific market outcome
 * - side + size ensures we don't miss partial fills
 */
function generateTradeKey(trade: {
  transactionHash?: string;
  id?: string;
  conditionId?: string;
  outcomeIndex?: number;
  outcome?: string;
  side?: string;
  size?: number;
  price?: number;
  timestamp?: string | number;
  trader?: string;
}): string {
  // Use transactionHash as primary dedup if available, fallback to id
  const txHash = trade.transactionHash || trade.id || "";
  const conditionId = trade.conditionId || "";

  // Normalize outcome to outcomeIndex
  // IMPORTANT: Supports ANY outcome label, not just YES/NO
  let outcomeIndex: number;
  if (typeof trade.outcomeIndex === "number") {
    outcomeIndex = trade.outcomeIndex;
  } else if (trade.outcome) {
    const upperOutcome = trade.outcome.toUpperCase();
    // Map YES/NO to indices for backward compat, but accept any outcome
    if (upperOutcome === "NO") {
      outcomeIndex = 1;
    } else if (upperOutcome === "YES") {
      outcomeIndex = 0;
    } else {
      // Non-YES/NO outcome (e.g., team names) - use hash for unique dedup
      // This ensures different outcomes like "Lakers" vs "Celtics" don't collide
      outcomeIndex = hashString(trade.outcome) % 1000000;
    }
  } else {
    // Both outcomeIndex and outcome missing - use sentinel to indicate incomplete data
    outcomeIndex = -1;
  }

  const side = (trade.side || "BUY").toUpperCase();

  // Use sentinel value (-1) for missing/invalid size to avoid incorrect deduplication
  const parsedSize = Number(trade.size);
  const size = Number.isFinite(parsedSize) ? parsedSize : -1;

  // Use higher precision (6 decimals) to avoid collisions with similar-sized trades
  return `${txHash}:${conditionId}:${outcomeIndex}:${side}:${size.toFixed(6)}`;
}

/**
 * Simple string hash function for non-YES/NO outcomes
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

// Deduplication set with composite keys
const seenTrades = new Set<string>();

// Per-wallet timestamp cursors to avoid reprocessing old trades
const walletCursors = new Map<string, number>();

/**
 * Fetch recent trades from whale addresses using Data API
 *
 * OPTIMIZED FOR 99 WALLETS:
 * - Uses per-wallet timestamp cursors
 * - Processes in parallel batches with rate-limit awareness
 * - Robust deduplication with composite keys
 *
 * @param addresses - Array of proxyWallet addresses to monitor
 * @param options - Configuration options
 */
export async function fetchRecentTrades(
  addresses: string[],
  options: {
    /** Max trades per wallet to fetch (default: 10) */
    limitPerWallet?: number;
    /** Max age of trades to process in ms (default: 60000 = 60s) */
    maxAgeMs?: number;
    /** Parallel batch size (default: 10 for rate limiting) */
    batchSize?: number;
    /** Delay between batches in ms (default: 100ms) */
    batchDelayMs?: number;
  } = {},
): Promise<TradeSignal[]> {
  const {
    limitPerWallet = 10,
    maxAgeMs = 60000,
    batchSize = 10,
    batchDelayMs = 100,
  } = options;

  const trades: TradeSignal[] = [];
  const now = Date.now();

  // Process addresses in parallel batches for efficiency
  for (let i = 0; i < addresses.length; i += batchSize) {
    const batch = addresses.slice(i, i + batchSize);

    const batchPromises = batch.map(async (addr) => {
      const walletTrades: TradeSignal[] = [];

      try {
        // Get cursor for this wallet (timestamp of last seen trade)
        // Note: Using strict < to handle trades with identical timestamps
        const cursor = walletCursors.get(addr.toLowerCase()) || 0;

        const url = `${POLYMARKET_API.DATA}/trades?user=${addr}&limit=${limitPerWallet}`;
        const { data } = await axios.get(url, { timeout: 5000 });

        if (!Array.isArray(data)) return walletTrades;

        let maxTimestamp = cursor;

        for (const t of data) {
          const ts = new Date(t.timestamp || t.createdAt).getTime();

          // Skip if older than max age
          if (now - ts > maxAgeMs) continue;

          // Skip if at or before cursor (already processed)
          // Use strict < to avoid missing trades with the same timestamp
          if (ts < cursor) continue;

          // Generate composite dedup key
          const key = generateTradeKey({
            transactionHash: t.transactionHash,
            id: t.id,
            conditionId: t.conditionId,
            outcomeIndex: t.outcomeIndex,
            outcome: t.outcome,
            side: t.side,
            size: t.size,
            price: t.price,
            timestamp: ts,
            trader: addr,
          });

          // Skip if already seen (idempotent)
          if (seenTrades.has(key)) continue;
          seenTrades.add(key);

          // Track max timestamp for cursor update
          maxTimestamp = Math.max(maxTimestamp, ts);

          // Accept ANY outcome - not just YES/NO
          // The tokenId is the canonical identifier for the outcome we want to trade
          let outcomeLabel: string;
          if (typeof t.outcome === "string" && t.outcome.trim() !== "") {
            outcomeLabel = t.outcome;
          } else if (typeof t.outcomeIndex === "number") {
            // Fallback to index-based label if no outcome string
            outcomeLabel = t.outcomeIndex === 0 ? "Outcome1" : "Outcome2";
          } else {
            // Skip trade if we can't determine any outcome info
            console.warn(
              `[copy] Skipping trade with no outcome info for wallet ${addr.slice(0, 10)}...`,
            );
            continue;
          }

          walletTrades.push({
            // tokenId from API - this is the ACTUAL token the whale bought
            tokenId: t.asset || t.tokenId || "",
            conditionId: t.conditionId || "",
            marketId: t.marketId || "",
            outcome: outcomeLabel, // Use actual outcome label (YES/NO or team name, etc.)
            side: t.side?.toUpperCase() === "SELL" ? "SELL" : "BUY",
            // Calculate USD value
            sizeUsd: Number(t.size) * Number(t.price) || 0,
            price: Number(t.price) || 0,
            trader: addr,
            timestamp: ts,
          });
        }

        // Update cursor for this wallet (only if we processed new trades)
        // Note: cursor is not updated if all trades were skipped - this is intentional
        if (maxTimestamp > cursor) {
          walletCursors.set(addr.toLowerCase(), maxTimestamp);
        }
      } catch (error) {
        // Log error but continue - individual wallet failure shouldn't stop others
        console.error(
          `[copy] Error fetching trades for wallet ${addr.slice(0, 10)}...:`,
          error instanceof Error ? error.message : error,
        );
      }

      return walletTrades;
    });

    // Await batch results
    const batchResults = await Promise.all(batchPromises);
    for (const walletTrades of batchResults) {
      trades.push(...walletTrades);
    }

    // Rate limit between batches (avoid hammering API)
    if (i + batchSize < addresses.length && batchDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
    }
  }

  // Prune old seen trades to prevent unbounded memory growth
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
  walletCursors.clear();
}

/**
 * Get current cursor for a wallet (for debugging)
 */
export function getWalletCursor(address: string): number {
  return walletCursors.get(address.toLowerCase()) || 0;
}

/**
 * Get deduplication stats (for debugging)
 */
export function getDeduplicationStats(): {
  seenCount: number;
  walletCursorCount: number;
} {
  return {
    seenCount: seenTrades.size,
    walletCursorCount: walletCursors.size,
  };
}
