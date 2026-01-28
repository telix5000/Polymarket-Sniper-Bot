/**
 * MarketDataStore - Single source of truth for live market data
 *
 * This module provides a thread-safe, in-memory store for real-time market data
 * that is updated by WebSocket connections and can fall back to REST when stale.
 *
 * Features:
 * - Stores best bid/ask/mid/spread per tokenId
 * - Optional shallow depth tracking
 * - Staleness detection per tokenId
 * - Memory protection (max tokens cap)
 * - Deduplication of updates
 */

import { POLYMARKET_WS } from "./constants";

// ============================================================================
// Types
// ============================================================================

/** Market data for a single token */
export interface TokenMarketData {
  tokenId: string;
  bestBid: number; // Best bid price (0-1)
  bestAsk: number; // Best ask price (0-1)
  mid: number; // Mid price (0-1)
  spreadCents: number; // Spread in cents
  bidDepthUsd: number; // Depth on bid side (within window)
  askDepthUsd: number; // Depth on ask side (within window)
  updatedAt: number; // Unix timestamp ms
  source: "WS" | "REST"; // Data source
}

/** Orderbook level for L2 data */
export interface OrderbookLevel {
  price: number;
  size: number;
}

/** Full L2 orderbook snapshot */
export interface OrderbookSnapshot {
  tokenId: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  timestamp: number;
}

/** Market data mode for observability */
export type MarketDataMode = "WS_OK" | "WS_STALE_FALLBACK" | "REST_ONLY";

/** Store metrics for observability */
export interface StoreMetrics {
  totalTokens: number;
  wsUpdates: number;
  restFallbacks: number;
  staleTokens: number;
  mode: MarketDataMode;
  oldestUpdateMs: number;
  newestUpdateMs: number;
}

// ============================================================================
// MarketDataStore Implementation
// ============================================================================

export class MarketDataStore {
  private store = new Map<string, TokenMarketData>();
  private orderbooks = new Map<string, OrderbookSnapshot>();
  private accessOrder: string[] = []; // LRU tracking
  private wsUpdates = 0;
  private restFallbacks = 0;
  private wsConnected = false;

  private readonly maxTokens: number;
  private readonly staleMs: number;
  private readonly depthWindowCents: number;

  constructor(options?: {
    maxTokens?: number;
    staleMs?: number;
    depthWindowCents?: number;
  }) {
    this.maxTokens = options?.maxTokens ?? POLYMARKET_WS.MAX_TOKENS;
    this.staleMs = options?.staleMs ?? POLYMARKET_WS.STALE_MS;
    this.depthWindowCents =
      options?.depthWindowCents ?? POLYMARKET_WS.DEPTH_WINDOW_CENTS;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Public API - Read Operations
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get market data for a token
   * @returns TokenMarketData or null if not found
   */
  get(tokenId: string): TokenMarketData | null {
    const data = this.store.get(tokenId);
    if (data) {
      // Update LRU access order
      this.touchToken(tokenId);
    }
    return data ?? null;
  }

  /**
   * Check if data for a token is stale
   */
  isStale(tokenId: string): boolean {
    const data = this.store.get(tokenId);
    if (!data) return true;
    return Date.now() - data.updatedAt > this.staleMs;
  }

  /**
   * Get the age of data for a token in milliseconds
   */
  getAge(tokenId: string): number {
    const data = this.store.get(tokenId);
    if (!data) return Infinity;
    return Date.now() - data.updatedAt;
  }

  /**
   * Check if we have data for a token (regardless of staleness)
   */
  has(tokenId: string): boolean {
    return this.store.has(tokenId);
  }

  /**
   * Get all tracked token IDs
   */
  getTrackedTokens(): string[] {
    return Array.from(this.store.keys());
  }

  /**
   * Get count of stale tokens
   */
  getStaleCount(): number {
    const now = Date.now();
    let count = 0;
    for (const data of this.store.values()) {
      if (now - data.updatedAt > this.staleMs) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get full L2 orderbook for a token (if available)
   */
  getOrderbook(tokenId: string): OrderbookSnapshot | null {
    return this.orderbooks.get(tokenId) ?? null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Public API - Write Operations
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Update market data from WebSocket message
   * Handles deduplication - won't update if data hasn't changed
   */
  updateFromWs(
    tokenId: string,
    bids: OrderbookLevel[],
    asks: OrderbookLevel[],
  ): boolean {
    if (bids.length === 0 || asks.length === 0) {
      return false;
    }

    const bestBid = bids[0].price;
    const bestAsk = asks[0].price;

    // Deduplication: check if data has actually changed
    const existing = this.store.get(tokenId);
    if (
      existing &&
      existing.bestBid === bestBid &&
      existing.bestAsk === bestAsk &&
      existing.source === "WS"
    ) {
      // Data hasn't changed, just update timestamp and LRU access order
      existing.updatedAt = Date.now();
      this.touchToken(tokenId);
      return false;
    }

    const mid = (bestBid + bestAsk) / 2;
    const spreadCents = (bestAsk - bestBid) * 100;

    // Calculate depth within window
    const { bidDepthUsd, askDepthUsd } = this.calculateDepth(bids, asks, mid);

    const data: TokenMarketData = {
      tokenId,
      bestBid,
      bestAsk,
      mid,
      spreadCents,
      bidDepthUsd,
      askDepthUsd,
      updatedAt: Date.now(),
      source: "WS",
    };

    this.setData(tokenId, data);
    this.wsUpdates++;

    // Store full orderbook for detailed analysis
    this.orderbooks.set(tokenId, {
      tokenId,
      bids,
      asks,
      timestamp: Date.now(),
    });

    return true;
  }

  /**
   * Update market data from REST fallback
   */
  updateFromRest(
    tokenId: string,
    bids: OrderbookLevel[],
    asks: OrderbookLevel[],
  ): boolean {
    if (bids.length === 0 || asks.length === 0) {
      return false;
    }

    const bestBid = bids[0].price;
    const bestAsk = asks[0].price;
    const mid = (bestBid + bestAsk) / 2;
    const spreadCents = (bestAsk - bestBid) * 100;

    const { bidDepthUsd, askDepthUsd } = this.calculateDepth(bids, asks, mid);

    const data: TokenMarketData = {
      tokenId,
      bestBid,
      bestAsk,
      mid,
      spreadCents,
      bidDepthUsd,
      askDepthUsd,
      updatedAt: Date.now(),
      source: "REST",
    };

    this.setData(tokenId, data);
    this.restFallbacks++;

    // Store full orderbook
    this.orderbooks.set(tokenId, {
      tokenId,
      bids,
      asks,
      timestamp: Date.now(),
    });

    return true;
  }

  /**
   * Remove a token from the store
   */
  remove(tokenId: string): boolean {
    this.orderbooks.delete(tokenId);
    this.accessOrder = this.accessOrder.filter((id) => id !== tokenId);
    return this.store.delete(tokenId);
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.store.clear();
    this.orderbooks.clear();
    this.accessOrder = [];
    this.wsUpdates = 0;
    this.restFallbacks = 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Connection State
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Update WebSocket connection state
   */
  setWsConnected(connected: boolean): void {
    this.wsConnected = connected;
  }

  /**
   * Get current WebSocket connection state
   */
  isWsConnected(): boolean {
    return this.wsConnected;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Metrics and Observability
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get current mode based on state
   */
  getMode(): MarketDataMode {
    if (!this.wsConnected) {
      return "REST_ONLY";
    }
    if (this.getStaleCount() > 0) {
      return "WS_STALE_FALLBACK";
    }
    return "WS_OK";
  }

  /**
   * Get store metrics for observability
   */
  getMetrics(): StoreMetrics {
    let oldest = Date.now();
    let newest = 0;

    for (const data of this.store.values()) {
      if (data.updatedAt < oldest) oldest = data.updatedAt;
      if (data.updatedAt > newest) newest = data.updatedAt;
    }

    return {
      totalTokens: this.store.size,
      wsUpdates: this.wsUpdates,
      restFallbacks: this.restFallbacks,
      staleTokens: this.getStaleCount(),
      mode: this.getMode(),
      oldestUpdateMs: this.store.size > 0 ? Date.now() - oldest : 0,
      newestUpdateMs: this.store.size > 0 ? Date.now() - newest : 0,
    };
  }

  /**
   * Log current state (for observability)
   */
  logState(prefix: string = "[MarketDataStore]"): void {
    const metrics = this.getMetrics();
    console.log(
      `${prefix} Mode: ${metrics.mode} | ` +
        `Tokens: ${metrics.totalTokens} | ` +
        `Stale: ${metrics.staleTokens} | ` +
        `WS updates: ${metrics.wsUpdates} | ` +
        `REST fallbacks: ${metrics.restFallbacks}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Calculate depth within price window
   */
  private calculateDepth(
    bids: OrderbookLevel[],
    asks: OrderbookLevel[],
    mid: number,
  ): { bidDepthUsd: number; askDepthUsd: number } {
    const windowPrice = this.depthWindowCents / 100;

    let bidDepthUsd = 0;
    let askDepthUsd = 0;

    // Sum bid depth within window
    for (const level of bids) {
      if (mid - level.price <= windowPrice) {
        bidDepthUsd += level.size * level.price;
      } else {
        break; // Bids are sorted descending
      }
    }

    // Sum ask depth within window
    for (const level of asks) {
      if (level.price - mid <= windowPrice) {
        askDepthUsd += level.size * level.price;
      } else {
        break; // Asks are sorted ascending
      }
    }

    return { bidDepthUsd, askDepthUsd };
  }

  /**
   * Set data with LRU eviction
   */
  private setData(tokenId: string, data: TokenMarketData): void {
    // Evict LRU if at capacity
    while (this.store.size >= this.maxTokens && !this.store.has(tokenId)) {
      const lruToken = this.accessOrder.shift();
      if (lruToken) {
        this.store.delete(lruToken);
        this.orderbooks.delete(lruToken);
      }
    }

    this.store.set(tokenId, data);
    this.touchToken(tokenId);
  }

  /**
   * Update LRU access order
   */
  private touchToken(tokenId: string): void {
    const idx = this.accessOrder.indexOf(tokenId);
    if (idx !== -1) {
      this.accessOrder.splice(idx, 1);
    }
    this.accessOrder.push(tokenId);
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalStore: MarketDataStore | null = null;

/**
 * Get the global MarketDataStore instance
 */
export function getMarketDataStore(): MarketDataStore {
  if (!globalStore) {
    globalStore = new MarketDataStore();
  }
  return globalStore;
}

/**
 * Initialize a new global MarketDataStore (for testing or reset)
 */
export function initMarketDataStore(options?: {
  maxTokens?: number;
  staleMs?: number;
  depthWindowCents?: number;
}): MarketDataStore {
  globalStore = new MarketDataStore(options);
  return globalStore;
}
