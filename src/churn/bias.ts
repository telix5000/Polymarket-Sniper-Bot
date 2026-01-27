/**
 * Churn Engine - Bias Accumulator Module
 *
 * Bias is permission, not prediction.
 * Bias source: LEADERBOARD FLOW ONLY.
 *
 * For each market/token, track leaderboard trader trades over BIAS_WINDOW_SECONDS.
 * Compute: net_usd = sum(buys_usd) - sum(sells_usd)
 *
 * Bias rules:
 * - If net_usd >= BIAS_MIN_NET_USD AND trades >= BIAS_MIN_TRADES → LONG
 * - If net_usd <= -BIAS_MIN_NET_USD AND trades >= BIAS_MIN_TRADES → SHORT
 * - Else → NONE
 *
 * Bias expires if no leaderboard activity for BIAS_STALE_SECONDS.
 */

import axios from "axios";
import type { ChurnConfig } from "./config";

/**
 * Bias direction
 */
export type BiasDirection = "LONG" | "SHORT" | "NONE";

/**
 * Leaderboard trade record
 */
export interface LeaderboardTrade {
  tokenId: string;
  marketId?: string;
  wallet: string;
  side: "BUY" | "SELL";
  sizeUsd: number;
  timestamp: number;
}

/**
 * Token bias state
 */
export interface TokenBias {
  tokenId: string;
  marketId?: string;
  direction: BiasDirection;
  netUsd: number;
  tradeCount: number;
  lastActivityTime: number;
  isStale: boolean;
}

/**
 * Bias change event
 */
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
 * Bias Accumulator
 * Tracks leaderboard flow to determine bias per token
 */
export class BiasAccumulator {
  private trades: Map<string, LeaderboardTrade[]> = new Map();
  private leaderboardWallets: Set<string> = new Set();
  private lastLeaderboardFetch = 0;
  private readonly config: ChurnConfig;
  private biasChangeCallbacks: ((event: BiasChangeEvent) => void)[] = [];

  // API endpoints
  private readonly GAMMA_API = "https://gamma-api.polymarket.com";
  private readonly DATA_API = "https://data-api.polymarket.com";

  constructor(config: ChurnConfig) {
    this.config = config;
  }

  /**
   * Register callback for bias changes
   */
  onBiasChange(callback: (event: BiasChangeEvent) => void): void {
    this.biasChangeCallbacks.push(callback);
  }

  /**
   * Fetch top leaderboard wallets
   */
  async refreshLeaderboard(): Promise<string[]> {
    const now = Date.now();
    // Only fetch every 5 minutes
    if (now - this.lastLeaderboardFetch < 5 * 60 * 1000) {
      return Array.from(this.leaderboardWallets);
    }

    try {
      const url = `${this.GAMMA_API}/leaderboard?limit=${this.config.leaderboardTopN}`;
      const { data } = await axios.get(url, { timeout: 10000 });

      if (Array.isArray(data)) {
        this.leaderboardWallets.clear();
        for (const entry of data) {
          if (entry.address) {
            this.leaderboardWallets.add(entry.address.toLowerCase());
          }
        }
        this.lastLeaderboardFetch = now;
      }
    } catch {
      // Keep existing wallets on error
    }

    return Array.from(this.leaderboardWallets);
  }

  /**
   * Fetch recent trades for leaderboard wallets
   */
  async fetchLeaderboardTrades(): Promise<LeaderboardTrade[]> {
    const wallets = await this.refreshLeaderboard();
    const newTrades: LeaderboardTrade[] = [];
    const now = Date.now();
    const windowStart = now - this.config.biasWindowSeconds * 1000;

    // Limit concurrent requests
    const batch = wallets.slice(0, 10);

    for (const wallet of batch) {
      try {
        const url = `${this.DATA_API}/trades?user=${wallet}&limit=20`;
        const { data } = await axios.get(url, { timeout: 5000 });

        if (!Array.isArray(data)) continue;

        for (const trade of data) {
          const timestamp = new Date(
            trade.timestamp || trade.createdAt,
          ).getTime();

          // Only trades within window
          if (timestamp < windowStart) continue;

          const tokenId = trade.asset || trade.tokenId;
          if (!tokenId) continue;

          const sizeUsd = Number(trade.size) * Number(trade.price) || 0;
          if (sizeUsd <= 0) continue;

          newTrades.push({
            tokenId,
            marketId: trade.marketId,
            wallet: wallet,
            side: trade.side?.toUpperCase() === "SELL" ? "SELL" : "BUY",
            sizeUsd,
            timestamp,
          });
        }
      } catch {
        // Continue on error
      }
    }

    // Add to accumulator and prune old trades
    this.addTrades(newTrades);

    return newTrades;
  }

  /**
   * Add trades and maintain window
   */
  private addTrades(trades: LeaderboardTrade[]): void {
    const now = Date.now();
    const windowStart = now - this.config.biasWindowSeconds * 1000;

    for (const trade of trades) {
      const existing = this.trades.get(trade.tokenId) || [];
      existing.push(trade);
      this.trades.set(trade.tokenId, existing);
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
   */
  getBias(tokenId: string): TokenBias {
    const now = Date.now();
    const windowStart = now - this.config.biasWindowSeconds * 1000;
    const staleThreshold = now - this.config.biasStaleSeconds * 1000;

    const tokenTrades = this.trades.get(tokenId) || [];
    const recentTrades = tokenTrades.filter((t) => t.timestamp >= windowStart);

    // Calculate net USD
    let netUsd = 0;
    let lastActivityTime = 0;

    for (const trade of recentTrades) {
      if (trade.side === "BUY") {
        netUsd += trade.sizeUsd;
      } else {
        netUsd -= trade.sizeUsd;
      }
      if (trade.timestamp > lastActivityTime) {
        lastActivityTime = trade.timestamp;
      }
    }

    const tradeCount = recentTrades.length;
    const isStale = lastActivityTime > 0 && lastActivityTime < staleThreshold;

    // Determine direction
    let direction: BiasDirection = "NONE";
    if (!isStale && tradeCount >= this.config.biasMinTrades) {
      if (netUsd >= this.config.biasMinNetUsd) {
        direction = "LONG";
      } else if (netUsd <= -this.config.biasMinNetUsd) {
        direction = "SHORT";
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
      if (bias.direction !== "NONE") {
        biases.push(bias);
      }
    }

    return biases;
  }

  /**
   * Check if bias allows entry for a token
   */
  canEnter(tokenId: string): { allowed: boolean; reason?: string } {
    if (!this.config.allowEntriesOnlyWithBias) {
      return { allowed: true };
    }

    const bias = this.getBias(tokenId);

    if (bias.direction === "NONE") {
      if (bias.isStale) {
        return { allowed: false, reason: "BIAS_STALE" };
      }
      if (bias.tradeCount < this.config.biasMinTrades) {
        return {
          allowed: false,
          reason: `BIAS_INSUFFICIENT_TRADES (${bias.tradeCount} < ${this.config.biasMinTrades})`,
        };
      }
      return {
        allowed: false,
        reason: `BIAS_NONE (net_usd=${bias.netUsd.toFixed(2)})`,
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
