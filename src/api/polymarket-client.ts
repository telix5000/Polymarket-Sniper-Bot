/**
 * Polymarket API Client
 *
 * A thin API client for fetching position and order data from the Polymarket
 * Data API with simple in-memory caching to reduce API calls.
 *
 * This client is used by trading strategies to get position data without
 * depending on PositionTracker's complex caching/snapshot system.
 *
 * KEY DESIGN PRINCIPLES:
 * 1. SIMPLE CACHING - Active positions are cached and refreshed periodically
 * 2. SMART REFRESH - Only fetch when cache is stale, not on every call
 * 3. ONLY ACTIVE - Complete/redeemable positions are NOT cached (nobody cares)
 * 4. AUTOMATIC CLEANUP - Positions that become complete are removed from cache
 *
 * CACHING BEHAVIOR:
 * - Only ACTIVE positions are cached (not complete, not redeemable)
 * - Cache TTL is configurable (default: 30 seconds)
 * - "Already stacked" detection caches per-token for 5 minutes
 * - When a position goes to $0 or redeemable, it's removed from cache
 */

import { httpGet } from "../utils/fetch-data.util";
import { POLYMARKET_API } from "../constants/polymarket.constants";
import type { ConsoleLogger } from "../utils/logger.util";

/**
 * Position data from the Data API
 * Contains entry price, current price, and P&L information
 */
export interface ApiPosition {
  /** Unique token ID for this position (outcome) */
  tokenId: string;
  /** Market/condition ID */
  conditionId: string;
  /** Outcome name (e.g., "YES", "NO") */
  outcome: string;
  /** Number of shares held */
  size: number;
  /** Average entry price (0-1 scale) */
  avgPrice: number;
  /** Average entry price in cents (avgPrice * 100) */
  avgPriceCents: number;
  /** Current market price (0-1 scale) */
  curPrice: number;
  /** Current market price in cents (curPrice * 100) */
  curPriceCents: number;
  /** Initial value (cost basis): size * avgPrice */
  initialValue: number;
  /** Current value: size * curPrice */
  currentValue: number;
  /** Unrealized P&L in USD */
  cashPnl: number;
  /** Unrealized P&L as percentage */
  percentPnl: number;
  /** Whether this position is redeemable (market resolved) */
  redeemable: boolean;
  /** Whether this position is complete ($0 or fully redeemed) */
  isComplete: boolean;
}

/**
 * Trade/Order item from the Data API
 */
export interface ApiTradeItem {
  /** Unix timestamp in seconds */
  timestamp: number;
  /** Market/condition ID */
  conditionId: string;
  /** Token ID (asset) */
  asset: string;
  /** Trade side: "BUY" or "SELL" */
  side: "BUY" | "SELL";
  /** Number of shares traded */
  size: number;
  /** Price per share (0-1 scale) */
  price: number;
  /** Trade hash/ID */
  transactionHash?: string;
}

/**
 * Raw position data from Data API
 */
interface RawApiPosition {
  asset: string;
  conditionId: string;
  outcome: string;
  size: number | string;
  avgPrice: number | string;
  curPrice: number | string;
  initialValue?: number | string;
  currentValue?: number | string;
  cashPnl?: number | string;
  percentPnl?: number | string;
  redeemable?: boolean;
}

/**
 * Raw trade data from Data API
 */
interface RawApiTrade {
  timestamp: number | string;
  conditionId: string;
  asset: string;
  side: string;
  size: number | string;
  price: number | string;
  transactionHash?: string;
}

/**
 * Configuration for PolymarketClient
 */
export interface PolymarketClientConfig {
  logger: ConsoleLogger;
  /** API timeout in milliseconds (default: 10000ms) */
  apiTimeoutMs?: number;
  /** Position cache TTL in milliseconds (default: 30000ms = 30s) */
  positionCacheTtlMs?: number;
  /** Stacked detection cache TTL in milliseconds (default: 300000ms = 5min) */
  stackedCacheTtlMs?: number;
}

/**
 * Cached "already stacked" result per token
 */
interface StackedCacheEntry {
  isStacked: boolean;
  buyCount: number;
  fetchedAtMs: number;
}

/**
 * Polymarket API Client
 *
 * Provides access to Polymarket Data API with smart caching:
 * - Only ACTIVE positions are cached (complete/redeemable are ignored)
 * - Positions refreshed periodically (default: 30s TTL)
 * - "Already stacked" detection cached per-token (default: 5min TTL)
 *
 * This reduces API calls while keeping data fresh enough for trading decisions.
 */
export class PolymarketClient {
  private logger: ConsoleLogger;
  private apiTimeoutMs: number;
  private positionCacheTtlMs: number;
  private stackedCacheTtlMs: number;

  // === ACTIVE POSITIONS CACHE ===
  // Only stores active positions - complete/redeemable are NOT stored
  // Key: tokenId -> position data
  private activePositions: Map<string, ApiPosition> = new Map();
  private positionsFetchedAtMs: number = 0;
  private cachedAddress: string = "";

  // === STACKED DETECTION CACHE ===
  // Key: "address-tokenId" -> cached stacked result
  private stackedCache: Map<string, StackedCacheEntry> = new Map();

  constructor(config: PolymarketClientConfig) {
    this.logger = config.logger;
    this.apiTimeoutMs = config.apiTimeoutMs ?? 10_000;
    this.positionCacheTtlMs = config.positionCacheTtlMs ?? 30_000; // 30 seconds
    this.stackedCacheTtlMs = config.stackedCacheTtlMs ?? 300_000; // 5 minutes

    this.logger.info(
      `[PolymarketClient] Initialized: positionCacheTTL=${this.positionCacheTtlMs / 1000}s, ` +
        `stackedCacheTTL=${this.stackedCacheTtlMs / 1000}s`,
    );
  }

  /**
   * Get active positions for an address.
   * Returns cached data if fresh, otherwise fetches from API.
   * Only returns ACTIVE positions - complete/redeemable are filtered out.
   *
   * @param address - Wallet address (or proxy address)
   * @param options - Optional behavior
   * @returns Array of ACTIVE positions only
   */
  async getPositions(
    address: string,
    options: {
      /** Force refresh from API (default: false) */
      forceRefresh?: boolean;
    } = {},
  ): Promise<ApiPosition[]> {
    const { forceRefresh = false } = options;
    const normalizedAddress = address.toLowerCase();
    const now = Date.now();

    // Check cache validity
    const cacheAge = now - this.positionsFetchedAtMs;
    const cacheValid =
      this.cachedAddress === normalizedAddress &&
      cacheAge < this.positionCacheTtlMs &&
      this.activePositions.size > 0;

    if (!forceRefresh && cacheValid) {
      this.logger.debug(
        `[PolymarketClient] Using cached positions: ${this.activePositions.size} active (age=${(cacheAge / 1000).toFixed(1)}s)`,
      );
      return Array.from(this.activePositions.values());
    }

    // Fetch fresh from API
    await this.refreshPositions(normalizedAddress);

    return Array.from(this.activePositions.values());
  }

  /**
   * Get a single cached position by tokenId.
   * Returns from cache if available and fresh.
   *
   * @param address - Wallet address
   * @param tokenId - Token ID to get
   * @returns Position or undefined if not found/not active
   */
  async getPosition(
    address: string,
    tokenId: string,
  ): Promise<ApiPosition | undefined> {
    // Ensure cache is fresh
    await this.getPositions(address);
    return this.activePositions.get(tokenId);
  }

  /**
   * Check if a position has been stacked (has multiple BUY orders).
   * Results are cached per-token for stackedCacheTtlMs.
   *
   * @param address - Wallet address
   * @param tokenId - Token ID to check
   * @returns True if the position has been stacked (2+ BUY orders)
   */
  async hasBeenStacked(address: string, tokenId: string): Promise<boolean> {
    const cacheKey = `${address.toLowerCase()}-${tokenId}`;
    const now = Date.now();

    // Check cache first
    const cached = this.stackedCache.get(cacheKey);
    if (cached && now - cached.fetchedAtMs < this.stackedCacheTtlMs) {
      return cached.isStacked;
    }

    // Fetch from API
    const buyOrders = await this.getOrderHistory(address, tokenId, {
      side: "BUY",
      limit: 50,
    });

    // 2+ BUY orders = stacked (initial buy + at least one stack)
    const isStacked = buyOrders.length >= 2;

    // Cache result
    this.stackedCache.set(cacheKey, {
      isStacked,
      buyCount: buyOrders.length,
      fetchedAtMs: now,
    });

    if (isStacked) {
      this.logger.debug(
        `[PolymarketClient] Token ${tokenId.slice(0, 12)}... has ${buyOrders.length} BUY orders - already stacked`,
      );
    }

    return isStacked;
  }

  /**
   * Check if a position has been "hedged up" before (bought additional shares).
   *
   * Uses trade history from API to detect if already hedged up.
   * A position with 2+ BUY orders has been hedged up (1 initial buy + 1+ hedge up buys).
   *
   * This is the SAME logic as hasBeenStacked because both operations are
   * "buy more of existing position". We use a separate method name for clarity
   * in the hedging strategy code, but the underlying detection is identical.
   *
   * CRITICAL: This check survives bot restarts because it uses on-chain trade
   * history, not in-memory tracking. This prevents the bug where the bot would
   * repeatedly hedge up the same position after each restart, spending multiple
   * times HEDGING_ABSOLUTE_MAX_USD.
   *
   * @param address - Wallet address
   * @param tokenId - Token ID to check
   * @returns True if the position has been hedged up (2+ BUY orders)
   */
  async hasBeenHedgedUp(address: string, tokenId: string): Promise<boolean> {
    // Hedge up detection uses the same logic as stacked detection
    // Both are "buy more of existing position" operations
    // Reuse the stacked cache to avoid duplicate API calls
    return this.hasBeenStacked(address, tokenId);
  }

  /**
   * Invalidate caches after a trade (call after stacking, selling, etc.)
   *
   * @param tokenId - Optional token ID to invalidate stacked cache for
   */
  invalidateCache(tokenId?: string): void {
    // Clear position cache - will refresh on next call
    this.positionsFetchedAtMs = 0;

    // Clear stacked cache for specific token if provided
    if (tokenId) {
      for (const key of this.stackedCache.keys()) {
        if (key.endsWith(`-${tokenId}`)) {
          this.stackedCache.delete(key);
        }
      }
    }

    this.logger.debug(
      `[PolymarketClient] Cache invalidated${tokenId ? ` for ${tokenId.slice(0, 12)}...` : ""}`,
    );
  }

  /**
   * Get cache statistics for monitoring
   */
  getCacheStats(): {
    activePositions: number;
    stackedCached: number;
    cacheAgeMs: number;
  } {
    return {
      activePositions: this.activePositions.size,
      stackedCached: this.stackedCache.size,
      cacheAgeMs: Date.now() - this.positionsFetchedAtMs,
    };
  }

  /**
   * Clear all caches (for testing or reset)
   */
  clearCaches(): void {
    this.activePositions.clear();
    this.stackedCache.clear();
    this.positionsFetchedAtMs = 0;
    this.cachedAddress = "";
    this.logger.info("[PolymarketClient] All caches cleared");
  }

  /**
   * Fetch order/trade history for a specific token from API.
   * Note: This method does NOT cache - it always fetches fresh.
   * Use hasBeenStacked() for cached stacked detection.
   *
   * @param address - Wallet address
   * @param tokenId - Token ID to filter trades for
   * @param options - Optional filters
   * @returns Array of trades for this token
   */
  async getOrderHistory(
    address: string,
    tokenId: string,
    options: {
      /** Limit number of results (default: 100) */
      limit?: number;
      /** Filter by side: "BUY" or "SELL" (default: all) */
      side?: "BUY" | "SELL";
    } = {},
  ): Promise<ApiTradeItem[]> {
    const { limit = 100, side } = options;

    const url = `${POLYMARKET_API.TRADES_ENDPOINT(address)}&asset=${encodeURIComponent(tokenId)}&limit=${limit}`;

    try {
      const rawTrades = await httpGet<RawApiTrade[]>(url, {
        timeout: this.apiTimeoutMs,
      });

      if (!rawTrades || !Array.isArray(rawTrades)) {
        return [];
      }

      const trades: ApiTradeItem[] = [];
      for (const raw of rawTrades) {
        const trade = this.transformTrade(raw);
        if (side && trade.side !== side) continue;
        trades.push(trade);
      }

      return trades;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[PolymarketClient] Failed to fetch order history: ${errMsg}`,
      );
      return [];
    }
  }

  // === PRIVATE METHODS ===

  /**
   * Refresh positions from API - only stores ACTIVE positions
   */
  private async refreshPositions(address: string): Promise<void> {
    const url = POLYMARKET_API.POSITIONS_ENDPOINT(address);

    this.logger.debug(`[PolymarketClient] 📡 Fetching positions from API...`);

    try {
      const rawPositions = await httpGet<RawApiPosition[]>(url, {
        timeout: this.apiTimeoutMs,
      });

      // Clear existing cache
      this.activePositions.clear();

      if (!rawPositions || !Array.isArray(rawPositions)) {
        this.logger.debug(`[PolymarketClient] No positions returned from API`);
        this.positionsFetchedAtMs = Date.now();
        this.cachedAddress = address;
        return;
      }

      // Only store ACTIVE positions (not complete, not redeemable)
      let skippedComplete = 0;
      let skippedRedeemable = 0;

      for (const raw of rawPositions) {
        const position = this.transformPosition(raw);

        // Skip complete positions ($0, no shares)
        if (position.isComplete) {
          skippedComplete++;
          continue;
        }

        // Skip redeemable positions (market resolved - nobody cares)
        if (position.redeemable) {
          skippedRedeemable++;
          continue;
        }

        // Store active position
        this.activePositions.set(position.tokenId, position);
      }

      this.positionsFetchedAtMs = Date.now();
      this.cachedAddress = address;

      this.logger.info(
        `[PolymarketClient] 📊 Cached ${this.activePositions.size} active positions ` +
          `(skipped: ${skippedComplete} complete, ${skippedRedeemable} redeemable)`,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[PolymarketClient] Failed to fetch positions: ${errMsg}`,
      );
    }
  }

  /**
   * Transform raw API position data to ApiPosition format
   */
  private transformPosition(raw: RawApiPosition): ApiPosition {
    const size = this.parseNumber(raw.size);
    const avgPrice = this.parseNumber(raw.avgPrice);
    const curPrice = this.parseNumber(raw.curPrice);
    const initialValue =
      raw.initialValue !== undefined
        ? this.parseNumber(raw.initialValue)
        : size * avgPrice;
    const currentValue =
      raw.currentValue !== undefined
        ? this.parseNumber(raw.currentValue)
        : size * curPrice;
    const cashPnl =
      raw.cashPnl !== undefined
        ? this.parseNumber(raw.cashPnl)
        : currentValue - initialValue;
    const percentPnl =
      raw.percentPnl !== undefined
        ? this.parseNumber(raw.percentPnl)
        : initialValue > 0
          ? ((currentValue - initialValue) / initialValue) * 100
          : 0;

    // Determine if position is complete (zero value or fully redeemed)
    const isComplete = size <= 0 || currentValue <= 0;

    return {
      tokenId: raw.asset,
      conditionId: raw.conditionId,
      outcome: raw.outcome ?? "UNKNOWN",
      size,
      avgPrice,
      avgPriceCents: avgPrice * 100,
      curPrice,
      curPriceCents: curPrice * 100,
      initialValue,
      currentValue,
      cashPnl,
      percentPnl,
      redeemable: raw.redeemable === true,
      isComplete,
    };
  }

  /**
   * Transform raw API trade data to ApiTradeItem format
   */
  private transformTrade(raw: RawApiTrade): ApiTradeItem {
    return {
      timestamp:
        typeof raw.timestamp === "string"
          ? parseInt(raw.timestamp, 10)
          : raw.timestamp,
      conditionId: raw.conditionId,
      asset: raw.asset,
      side: (raw.side?.toUpperCase() ?? "BUY") as "BUY" | "SELL",
      size: this.parseNumber(raw.size),
      price: this.parseNumber(raw.price),
      transactionHash: raw.transactionHash,
    };
  }

  /**
   * Parse a number from string or number input
   */
  private parseNumber(value: number | string | undefined): number {
    if (value === undefined) return 0;
    if (typeof value === "number") return value;
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
