/**
 * BiasAccumulator - Tracks whale wallet trades and computes bias signals
 *
 * This class fetches trades from leaderboard wallets and maintains a rolling
 * window of whale activity. It computes bias signals that inform trading decisions.
 */

import axios from "axios";
import { type BiasDirection } from "../core";
import { reportError } from "../infra/github-reporter";

// ═══════════════════════════════════════════════════════════════════════════
// DEBUG LOGGING - Uses DEBUG env var from environment
// ═══════════════════════════════════════════════════════════════════════════
const DEBUG = process.env.DEBUG === "true" || process.env.DEBUG === "1";

function debug(message: string, ...args: any[]): void {
  if (DEBUG) {
    console.log(`🔍 [DEBUG] ${message}`, ...args);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface LeaderboardTrade {
  tokenId: string;
  marketId?: string;
  wallet: string;
  side: "BUY" | "SELL";
  sizeUsd: number;
  timestamp: number;
  price?: number; // Trade price in [0,1] for price-range filtering
}

export interface TokenBias {
  tokenId: string;
  marketId?: string;
  direction: BiasDirection;
  netUsd: number;
  tradeCount: number;
  lastActivityTime: number;
  isStale: boolean;
}

export interface BiasChangeEvent {
  tokenId: string;
  marketId?: string;
  previousDirection: BiasDirection;
  newDirection: BiasDirection;
  netUsd: number;
  tradeCount: number;
  timestamp: number;
}

/**
 * Minimal config interface for BiasAccumulator
 * Contains only the fields actually used by this class
 */
export interface BiasAccumulatorConfig {
  leaderboardTopN: number;
  biasWindowSeconds: number;
  biasMinNetUsd: number;
  biasMinTrades: number;
  biasStaleSeconds: number;
  allowEntriesOnlyWithBias: boolean;
  copyAnyWhaleBuy: boolean;
  whalePriceMin?: number;
  whalePriceMax?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// BIAS ACCUMULATOR CLASS
// ═══════════════════════════════════════════════════════════════════════════

export class BiasAccumulator {
  private trades: Map<string, LeaderboardTrade[]> = new Map();
  private leaderboardWallets: Set<string> = new Set();
  private lastLeaderboardFetch = 0;
  private readonly config: BiasAccumulatorConfig;
  private biasChangeCallbacks: ((event: BiasChangeEvent) => void)[] = [];

  // Price range filtering state
  private priceFilterEnabled = false;
  private priceFilterInvalid = false; // true if min > max
  private priceFilterLoggedOnce = false;

  // Funnel metrics tracking
  private funnelStats = {
    tradesIngested: 0,
    tradesFilteredByPrice: 0,
    uniqueTokensWithTrades: 0,
  };

  // API endpoints - using data-api v1 for leaderboard (gamma-api leaderboard is deprecated)
  private readonly DATA_API = "https://data-api.polymarket.com";

  constructor(config: BiasAccumulatorConfig) {
    this.config = config;
    this.initPriceRangeFilter();
  }

  /**
   * Get funnel statistics for diagnostics
   */
  getFunnelStats(): {
    tradesIngested: number;
    tradesFilteredByPrice: number;
    uniqueTokensWithTrades: number;
  } {
    return {
      ...this.funnelStats,
      uniqueTokensWithTrades: this.trades.size,
    };
  }

  /**
   * Initialize and validate price range filter settings
   */
  private initPriceRangeFilter(): void {
    const { whalePriceMin, whalePriceMax } = this.config;

    // Check if any price range filtering is configured
    if (whalePriceMin !== undefined || whalePriceMax !== undefined) {
      // Validate min <= max if both are set
      if (
        whalePriceMin !== undefined &&
        whalePriceMax !== undefined &&
        whalePriceMin > whalePriceMax
      ) {
        console.warn(
          `⚠️ [Price Filter] WHALE_PRICE_MIN (${whalePriceMin}) > WHALE_PRICE_MAX (${whalePriceMax}) - filter DISABLED`,
        );
        this.priceFilterInvalid = true;
        this.priceFilterEnabled = false;
      } else {
        this.priceFilterEnabled = true;
        const minStr =
          whalePriceMin !== undefined
            ? `${(whalePriceMin * 100).toFixed(0)}¢`
            : "none";
        const maxStr =
          whalePriceMax !== undefined
            ? `${(whalePriceMax * 100).toFixed(0)}¢`
            : "none";
        console.log(
          `🎯 [Price Filter] Whale trades filtered to price range: min=${minStr}, max=${maxStr}`,
        );
      }
    }
  }

  /**
   * Check if a trade passes the price range filter
   * Returns true if trade should be included, false if filtered out
   */
  private passesWhalePriceFilter(trade: LeaderboardTrade): boolean {
    // If filter is disabled or invalid, pass all trades
    if (!this.priceFilterEnabled || this.priceFilterInvalid) {
      return true;
    }

    const { whalePriceMin, whalePriceMax } = this.config;
    const price = trade.price;

    // If no price available on trade, pass it through (can't filter)
    if (price === undefined || price === null) {
      return true;
    }

    // Check minimum bound
    if (whalePriceMin !== undefined && price < whalePriceMin) {
      if (!this.priceFilterLoggedOnce) {
        debug(
          `[Price Filter] Trade filtered: price ${(price * 100).toFixed(1)}¢ < min ${(whalePriceMin * 100).toFixed(1)}¢`,
        );
      }
      return false;
    }

    // Check maximum bound
    if (whalePriceMax !== undefined && price > whalePriceMax) {
      if (!this.priceFilterLoggedOnce) {
        debug(
          `[Price Filter] Trade filtered: price ${(price * 100).toFixed(1)}¢ > max ${(whalePriceMax * 100).toFixed(1)}¢`,
        );
      }
      return false;
    }

    return true;
  }

  /**
   * Register callback for bias changes
   */
  onBiasChange(callback: (event: BiasChangeEvent) => void): void {
    this.biasChangeCallbacks.push(callback);
  }

  /**
   * Fetch top leaderboard wallets from v1 API
   * Uses proxyWallet from response (that's where positions are held)
   * Handles pagination since API may limit results per page
   */
  async refreshLeaderboard(): Promise<string[]> {
    const now = Date.now();
    // Only fetch hourly - the math works regardless, this just refreshes our whale list
    if (now - this.lastLeaderboardFetch < 60 * 60 * 1000) {
      return Array.from(this.leaderboardWallets);
    }

    // Define targetCount outside try block so it's accessible in catch
    const targetCount = this.config.leaderboardTopN;

    try {
      // Fetch with pagination to get the full requested count
      // API may limit to 50 per page, so we paginate if needed
      const pageSize = 50; // Max per page (API limit)
      const allEntries: any[] = [];

      let offset = 0;
      while (allEntries.length < targetCount) {
        const remaining = targetCount - allEntries.length;
        const limit = Math.min(pageSize, remaining);

        // Use v1 leaderboard API with PNL ordering to get top performers
        const url = `${this.DATA_API}/v1/leaderboard?category=OVERALL&timePeriod=WEEK&orderBy=PNL&limit=${limit}&offset=${offset}`;
        const { data } = await axios.get(url, { timeout: 10000 });

        if (!Array.isArray(data) || data.length === 0) {
          break; // No more results
        }

        allEntries.push(...data);
        offset += data.length;

        // If we got less than requested, no more pages
        if (data.length < limit) {
          break;
        }
      }

      if (allEntries.length > 0) {
        this.leaderboardWallets.clear();

        // Show top 10 at startup to verify it's working, sorted by last traded
        const isFirstFetch = this.lastLeaderboardFetch === 0;
        if (isFirstFetch) {
          // Fetch last activity for top 10 traders (parallel requests)
          const top10 = allEntries.slice(0, 10);
          const activityPromises = top10.map(async (entry) => {
            const wallet = entry.proxyWallet || entry.address;
            if (!wallet) return { ...entry, lastTraded: 0 };
            try {
              const { data } = await axios.get(
                `${this.DATA_API}/activity?user=${wallet}&limit=1&sortBy=TIMESTAMP&sortDirection=DESC`,
                { timeout: 5000 },
              );
              const lastTraded =
                Array.isArray(data) && data.length > 0
                  ? Number(data[0].timestamp || 0) * 1000
                  : 0;
              return { ...entry, lastTraded };
            } catch (err) {
              // Activity fetch failed - trader may have no activity or API issue
              // Continue gracefully - they'll show with N/A timestamp
              console.debug?.(
                `   Activity fetch for ${wallet.slice(0, 10)}... failed: ${err instanceof Error ? err.message : "Unknown"}`,
              );
              return { ...entry, lastTraded: 0 };
            }
          });

          const top10WithActivity = await Promise.all(activityPromises);

          // Sort by last traded (most recent first)
          top10WithActivity.sort((a, b) => b.lastTraded - a.lastTraded);

          console.log(
            `\n🐋 TOP 10 TRADERS (sorted by last traded, from ${allEntries.length} tracked):`,
          );
          for (const entry of top10WithActivity) {
            const wallet = (entry.proxyWallet || entry.address || "").slice(
              0,
              12,
            );
            const pnl = Number(entry.pnl || 0);
            const vol = Number(entry.vol || 0);
            const name = entry.userName || "anon";
            const lastTradedStr =
              entry.lastTraded > 0
                ? new Date(entry.lastTraded)
                    .toISOString()
                    .replace("T", " ")
                    .slice(0, 19) + " UTC"
                : "N/A";
            console.log(
              `   ${wallet}... | Last: ${lastTradedStr} | PNL: $${pnl >= 1000 ? (pnl / 1000).toFixed(0) + "k" : pnl.toFixed(0)} | Vol: $${vol >= 1000 ? (vol / 1000).toFixed(0) + "k" : vol.toFixed(0)} | @${name}`,
            );
          }
          console.log("");
        }

        for (const entry of allEntries) {
          // Use proxyWallet (where trades happen) or fallback to address
          const wallet = entry.proxyWallet || entry.address;
          if (wallet) {
            this.leaderboardWallets.add(wallet.toLowerCase());
          }
        }
        this.lastLeaderboardFetch = now;
        const trackedCount = this.leaderboardWallets.size;
        console.log(
          `🐋 Tracking ${trackedCount} top traders (requested: ${targetCount})`,
        );

        // Report if we got significantly fewer wallets than requested (potential issue)
        if (trackedCount < targetCount * 0.95) {
          reportError(
            "Leaderboard Wallet Count Mismatch",
            `Got ${trackedCount} unique wallets instead of requested ${targetCount}. May have duplicates or API limit.`,
            "info",
            {
              trackedCount,
              requestedCount: targetCount,
              entriesReturned: allEntries.length,
            },
          );
        }
      }
    } catch (err) {
      // Keep existing wallets on error
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️ Leaderboard fetch failed: ${errorMsg}`);
      reportError("Leaderboard Fetch Failed", errorMsg, "warning", {
        requestedCount: targetCount,
      });
    }

    return Array.from(this.leaderboardWallets);
  }

  /**
   * Fetch recent trades for leaderboard wallets - PARALLEL EXECUTION
   * Only tracks BUY trades - we have our own exit math, don't copy sells
   * Uses rotating batch to cover all wallets over multiple cycles
   */
  async fetchLeaderboardTrades(): Promise<LeaderboardTrade[]> {
    const wallets = await this.refreshLeaderboard();
    const now = Date.now();
    const windowStart = now - this.config.biasWindowSeconds * 1000;

    if (wallets.length === 0) {
      return [];
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ROTATING BATCH: Cover all wallets over multiple cycles
    // Process BATCH_SIZE wallets per cycle, rotating through the full list
    // ═══════════════════════════════════════════════════════════════════════════
    const BATCH_SIZE = 20;
    const startIdx = (this.fetchCount * BATCH_SIZE) % wallets.length;
    const endIdx = Math.min(startIdx + BATCH_SIZE, wallets.length);
    const batchWallets = wallets.slice(startIdx, endIdx);

    // Log when coverage is limited
    if (wallets.length > BATCH_SIZE && this.fetchCount % 10 === 0) {
      const cyclesForFullCoverage = Math.ceil(wallets.length / BATCH_SIZE);
      console.log(
        `📊 [API] Rotating batch: wallets ${startIdx + 1}-${endIdx} of ${wallets.length} (full coverage in ${cyclesForFullCoverage} cycles)`,
      );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DIAGNOSTIC: Track API fetch results
    // ═══════════════════════════════════════════════════════════════════════════
    let totalFetches = 0;
    let successfulFetches = 0;
    let emptyResponses = 0;
    let totalTradesFound = 0;
    let tradesInWindow = 0;

    // Fetch batch wallets in parallel for speed
    // API can handle concurrent requests, and we want to catch whale movement FAST
    const fetchPromises = batchWallets.map(async (wallet) => {
      totalFetches++;
      try {
        // Use ACTIVITY endpoint (like Novus-Tech-LLC does)
        const url = `${this.DATA_API}/activity?user=${wallet}&limit=20`;
        const { data } = await axios.get(url, { timeout: 5000 });

        if (!Array.isArray(data)) {
          emptyResponses++;
          return [];
        }

        if (data.length === 0) {
          emptyResponses++;
          return [];
        }

        successfulFetches++;

        const trades: LeaderboardTrade[] = [];
        for (const activity of data) {
          // Only look at TRADE type activities
          if (activity.type !== "TRADE") continue;

          totalTradesFound++;

          // Only track BUY trades - we don't copy sells, we have our own exit math
          if (activity.side?.toUpperCase() !== "BUY") continue;

          const rawTimestamp = activity.timestamp;
          let timestamp: number;
          if (typeof rawTimestamp === "number") {
            // If the numeric timestamp is very large, assume it's already in ms
            timestamp =
              rawTimestamp > 1e12 ? rawTimestamp : rawTimestamp * 1000;
          } else if (
            typeof rawTimestamp === "string" &&
            /^\d+$/.test(rawTimestamp)
          ) {
            const numericTimestamp = Number(rawTimestamp);
            timestamp =
              numericTimestamp > 1e12
                ? numericTimestamp
                : numericTimestamp * 1000;
          } else {
            // Fallback for ISO strings or other date representations
            timestamp = new Date(rawTimestamp).getTime();
          }

          // Only trades within window
          if (timestamp < windowStart) continue;

          tradesInWindow++;

          // TASK 4: Validate token ID mapping - add diagnostics
          const tokenId = activity.asset || activity.tokenId;
          const conditionId = activity.conditionId ?? activity.marketId;
          const outcome = activity.outcome; // YES/NO

          // Reject if tokenId is empty or invalid
          if (!tokenId || tokenId.trim() === "") {
            debug(
              `[Whale Trade] Rejected: empty tokenId | conditionId: ${conditionId || "N/A"} | outcome: ${outcome || "N/A"} | wallet: ${(wallet ?? "unknown").slice(0, 10)}...`,
            );
            continue;
          }

          const tradePrice = Number(activity.price) || 0;
          const sizeUsd =
            activity.usdcSize ?? (Number(activity.size) * tradePrice || 0);
          if (sizeUsd <= 0) continue;

          // Log candidate construction for diagnostics
          if (DEBUG) {
            debug(
              `[Whale Trade] Candidate: tokenId=${tokenId.slice(0, 12)}... | conditionId=${conditionId?.slice(0, 12) || "N/A"} | outcome=${outcome || "N/A"} | size=$${sizeUsd.toFixed(0)}`,
            );
          }

          trades.push({
            tokenId,
            marketId: activity.conditionId ?? activity.marketId,
            wallet: wallet,
            side: "BUY", // Only BUY trades
            sizeUsd,
            timestamp,
            price: tradePrice > 0 ? tradePrice : undefined,
          });
        }
        return trades;
      } catch (err) {
        // Log errors - keep visible in production, but also debug
        const errMsg = err instanceof Error ? err.message : String(err);
        // Only log to console if it's not a timeout/network issue (those are noisy)
        if (!errMsg.includes("timeout") && !errMsg.includes("ECONNRESET")) {
          console.warn(
            `[API] Fetch failed for ${wallet.slice(0, 10)}...: ${errMsg}`,
          );
        } else {
          debug(`[API] Fetch failed for ${wallet.slice(0, 10)}...: ${errMsg}`);
        }
        return [];
      }
    });

    // Wait for all fetches to complete in parallel
    const results = await Promise.all(fetchPromises);
    const newTrades = results.flat();

    // ═══════════════════════════════════════════════════════════════════════════
    // DIAGNOSTIC: Log API fetch results - show first 5, then every 10th, or when trades found
    // ═══════════════════════════════════════════════════════════════════════════
    if (
      this.fetchCount < 5 ||
      this.fetchCount % 10 === 0 ||
      newTrades.length > 0
    ) {
      const cyclesForFullCoverage = Math.ceil(wallets.length / BATCH_SIZE);
      console.log(
        `📊 [API Poll #${this.fetchCount}] Batch ${startIdx + 1}-${endIdx} of ${wallets.length} wallets (cycle ${(this.fetchCount % cyclesForFullCoverage) + 1}/${cyclesForFullCoverage}) | ` +
          `Success: ${successfulFetches} | Trades found: ${totalTradesFound} | In window: ${tradesInWindow} | New BUYs: ${newTrades.length}`,
      );
    }

    // Debug: Show individual trades found
    if (DEBUG && newTrades.length > 0) {
      for (const trade of newTrades.slice(0, 5)) {
        debug(
          `  Trade: ${trade.tokenId.slice(0, 12)}... | $${trade.sizeUsd.toFixed(0)} | wallet: ${trade.wallet.slice(0, 10)}...`,
        );
      }
      if (newTrades.length > 5) {
        debug(`  ... and ${newTrades.length - 5} more trades`);
      }
    }

    this.fetchCount++;

    // Add to accumulator and prune old trades
    this.addTrades(newTrades);

    return newTrades;
  }

  private fetchCount = 0;

  /**
   * Add trades and maintain window
   * Deduplicates by txHash+tokenId+wallet to prevent counting the same trade twice
   * (e.g., from both on-chain events and API polling)
   *
   * Also applies price-range filtering if WHALE_PRICE_MIN/MAX are configured
   */
  private addTrades(trades: LeaderboardTrade[]): void {
    const now = Date.now();
    const windowStart = now - this.config.biasWindowSeconds * 1000;

    // Track ingested trades in funnel
    this.funnelStats.tradesIngested += trades.length;

    // Apply price range filtering
    let filteredCount = 0;
    const filteredTrades = trades.filter((trade) => {
      if (this.passesWhalePriceFilter(trade)) {
        return true;
      }
      filteredCount++;
      return false;
    });

    // Track filtered trades in funnel
    this.funnelStats.tradesFilteredByPrice += filteredCount;

    // Log filtering summary (once per batch if any filtered)
    if (filteredCount > 0 && this.priceFilterEnabled) {
      const { whalePriceMin, whalePriceMax } = this.config;
      const minStr =
        whalePriceMin !== undefined
          ? `${(whalePriceMin * 100).toFixed(0)}¢`
          : "none";
      const maxStr =
        whalePriceMax !== undefined
          ? `${(whalePriceMax * 100).toFixed(0)}¢`
          : "none";
      console.log(
        `🎯 [Price Filter] Filtered ${filteredCount}/${trades.length} whale trades (range: ${minStr}-${maxStr})`,
      );
      this.priceFilterLoggedOnce = true;
    }

    for (const trade of filteredTrades) {
      const existing = this.trades.get(trade.tokenId) || [];

      // Deduplication: check if this trade already exists
      // Use a composite key of timestamp + wallet + size to identify duplicates
      // (On-chain and API trades may have slightly different timestamps)
      const isDuplicate = existing.some(
        (t) =>
          t.wallet.toLowerCase() === trade.wallet.toLowerCase() &&
          Math.abs(t.sizeUsd - trade.sizeUsd) < 0.01 && // Same size (within rounding)
          Math.abs(t.timestamp - trade.timestamp) < 60000, // Within 1 minute
      );

      if (!isDuplicate) {
        existing.push(trade);
        this.trades.set(trade.tokenId, existing);
      }
    }

    // Prune old trades from all tokens
    for (const [tokenId, tokenTrades] of this.trades.entries()) {
      const recent = tokenTrades.filter((t) => t.timestamp >= windowStart);
      if (recent.length === 0) {
        this.trades.delete(tokenId);
      } else {
        this.trades.set(tokenId, recent);
      }
    }
  }

  /**
   * Get bias for a specific token
   * Since we only track BUY trades, positive netUsd = whales are buying = LONG signal
   */
  getBias(tokenId: string): TokenBias {
    const now = Date.now();
    const windowStart = now - this.config.biasWindowSeconds * 1000;
    const staleThreshold = now - this.config.biasStaleSeconds * 1000;

    const tokenTrades = this.trades.get(tokenId) || [];
    const recentTrades = tokenTrades.filter((t) => t.timestamp >= windowStart);

    // Sum up BUY volume (we only track BUYs)
    let netUsd = 0;
    let lastActivityTime = 0;

    for (const trade of recentTrades) {
      // All trades are BUYs now (we filter in fetchLeaderboardTrades)
      netUsd += trade.sizeUsd;
      if (trade.timestamp > lastActivityTime) {
        lastActivityTime = trade.timestamp;
      }
    }

    const tradeCount = recentTrades.length;
    const isStale = lastActivityTime > 0 && lastActivityTime < staleThreshold;

    // Determine direction - STRICT eligibility check
    // In copyAnyWhaleBuy mode: allow 1 trade minimum
    // Otherwise: require ALL criteria (flow >= min, trades >= min, not stale)
    let direction: BiasDirection = "NONE";

    if (this.config.copyAnyWhaleBuy) {
      // Copy-any-buy mode: just need 1 trade and not stale
      if (tradeCount >= 1 && !isStale) {
        direction = "LONG";
      }
    } else {
      // Conservative mode: ALL criteria must be met
      if (
        !isStale &&
        tradeCount >= this.config.biasMinTrades &&
        netUsd >= this.config.biasMinNetUsd
      ) {
        direction = "LONG";
      }
    }

    return {
      tokenId,
      marketId: recentTrades[0]?.marketId,
      direction,
      netUsd,
      tradeCount,
      lastActivityTime,
      isStale,
    };
  }

  /**
   * Get all tokens with active bias
   */
  getActiveBiases(): TokenBias[] {
    const biases: TokenBias[] = [];

    for (const tokenId of this.trades.keys()) {
      const bias = this.getBias(tokenId);

      // COPY_ANY_WHALE_BUY mode: return ANY token with at least 1 whale buy
      // This is the key fix - we don't need 3 trades or $300 flow to copy
      if (this.config.copyAnyWhaleBuy) {
        // Return as LONG if we have at least 1 trade (all trades are BUYs)
        if (bias.tradeCount >= 1 && !bias.isStale) {
          // Override direction to LONG since we're in copy-any-buy mode
          biases.push({
            ...bias,
            direction: "LONG",
          });
        }
      } else {
        // Conservative mode: require full bias confirmation
        // Only add if direction is LONG (which means ALL criteria passed)
        if (bias.direction === "LONG") {
          biases.push(bias);
        }
      }
    }

    return biases;
  }

  /**
   * Check if bias allows entry for a token
   */
  canEnter(tokenId: string): { allowed: boolean; reason?: string } {
    // COPY_ANY_WHALE_BUY mode: allow entry if we've seen ANY whale buy on this token
    // No need for $300 flow or 3 trades - just one whale buy is enough
    if (this.config.copyAnyWhaleBuy) {
      const bias = this.getBias(tokenId);
      // Allow if we've seen at least 1 trade (which must be a BUY since we only track buys)
      // Also check staleness for consistency with getActiveBiases()
      if (bias.tradeCount >= 1 && !bias.isStale) {
        return { allowed: true };
      }
      if (bias.isStale) {
        return {
          allowed: false,
          reason: `BIAS_STALE (last: ${Math.round((Date.now() - bias.lastActivityTime) / 1000)}s ago)`,
        };
      }
      return { allowed: false, reason: "NO_WHALE_BUY_SEEN" };
    }

    if (!this.config.allowEntriesOnlyWithBias) {
      return { allowed: true };
    }

    const bias = this.getBias(tokenId);

    // Strict eligibility: check ALL criteria
    if (bias.direction === "NONE") {
      if (bias.isStale) {
        return {
          allowed: false,
          reason: `BIAS_STALE (last: ${Math.round((Date.now() - bias.lastActivityTime) / 1000)}s ago)`,
        };
      }
      if (bias.tradeCount < this.config.biasMinTrades) {
        return {
          allowed: false,
          reason: `BIAS_BELOW_MIN_TRADES (${bias.tradeCount} < ${this.config.biasMinTrades})`,
        };
      }
      if (bias.netUsd < this.config.biasMinNetUsd) {
        return {
          allowed: false,
          reason: `BIAS_BELOW_MIN_FLOW ($${bias.netUsd.toFixed(0)} < $${this.config.biasMinNetUsd})`,
        };
      }
      return {
        allowed: false,
        reason: `BIAS_NONE (net=$${bias.netUsd.toFixed(0)}, trades=${bias.tradeCount})`,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a manual trade observation (for testing or direct integration)
   */
  recordTrade(trade: LeaderboardTrade): void {
    if (!this.leaderboardWallets.has(trade.wallet.toLowerCase())) {
      return; // Ignore non-leaderboard wallets
    }

    const previousBias = this.getBias(trade.tokenId);
    this.addTrades([trade]);
    const newBias = this.getBias(trade.tokenId);

    // Fire callback if direction changed
    if (previousBias.direction !== newBias.direction) {
      const event: BiasChangeEvent = {
        tokenId: trade.tokenId,
        marketId: trade.marketId,
        previousDirection: previousBias.direction,
        newDirection: newBias.direction,
        netUsd: newBias.netUsd,
        tradeCount: newBias.tradeCount,
        timestamp: Date.now(),
      };

      for (const callback of this.biasChangeCallbacks) {
        callback(event);
      }
    }
  }

  /**
   * Add wallet to leaderboard manually (for testing)
   */
  addLeaderboardWallet(wallet: string): void {
    this.leaderboardWallets.add(wallet.toLowerCase());
  }

  /**
   * Get the count of tracked leaderboard wallets
   */
  getTrackedWalletCount(): number {
    return this.leaderboardWallets.size;
  }

  /**
   * Get the set of tracked whale wallets (for on-chain monitoring)
   * Returns a reference to the internal Set - updates automatically when leaderboard refreshes
   */
  getWhaleWallets(): Set<string> {
    return this.leaderboardWallets;
  }

  /**
   * Clear all data (for testing)
   */
  clear(): void {
    this.trades.clear();
    this.leaderboardWallets.clear();
    this.lastLeaderboardFetch = 0;
  }

  /**
   * Convert to JSON log entry
   */
  toLogEntry(): object {
    const activeBiases = this.getActiveBiases();
    return {
      type: "bias_state",
      timestamp: new Date().toISOString(),
      leaderboardWallets: this.leaderboardWallets.size,
      totalTokensTracked: this.trades.size,
      activeBiases: activeBiases.map((b) => ({
        tokenId: b.tokenId.slice(0, 12) + "...",
        direction: b.direction,
        netUsd: parseFloat(b.netUsd.toFixed(2)),
        tradeCount: b.tradeCount,
        isStale: b.isStale,
      })),
    };
  }
}
