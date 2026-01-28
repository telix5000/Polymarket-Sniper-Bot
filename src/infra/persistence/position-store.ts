/**
 * PositionStore - Consolidated store for position data
 *
 * Provides a consistent interface for storing and retrieving position data
 * with health checks and metrics. This wraps the existing position caching
 * logic with better observability.
 *
 * Features:
 * - Stores positions by token ID
 * - Tracks position metrics (count, total value, etc.)
 * - Health checks for stale data detection
 * - Consistent logging
 */

import { BaseStore, type BaseStoreMetrics } from "./base-store";
import type { HealthStatus } from "./types";

// ============================================================================
// Types
// ============================================================================

/** Position data stored in the cache */
export interface StoredPosition {
  tokenId: string;
  conditionId?: string;
  marketId?: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  pnlPct: number;
  pnlUsd: number;
  gainCents: number;
  value: number;
}

/** Extended metrics for PositionStore */
export interface PositionStoreMetrics extends BaseStoreMetrics {
  /** Total value of all positions */
  totalValueUsd: number;

  /** Total unrealized P&L */
  totalPnlUsd: number;

  /** Number of profitable positions */
  profitableCount: number;

  /** Number of losing positions */
  losingCount: number;

  /** Age of data in milliseconds */
  dataAgeMs: number;
}

// ============================================================================
// PositionStore Implementation
// ============================================================================

/**
 * Store for position data with metrics tracking
 */
export class PositionStore extends BaseStore<string, StoredPosition> {
  // Track when positions were last synced from API
  private lastSyncAt = 0;

  // Threshold for considering data stale (30 seconds by default)
  private readonly staleThresholdMs: number;

  constructor(options?: { maxEntries?: number; staleThresholdMs?: number }) {
    super("PositionStore", {
      maxEntries: options?.maxEntries ?? 500,
      ttlMs: 0, // Positions don't expire, they're refreshed by sync
      trackMetrics: true,
    });
    this.staleThresholdMs = options?.staleThresholdMs ?? 30000;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Position-Specific Operations
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sync positions from API response
   * Replaces all existing positions with new data
   */
  syncPositions(positions: StoredPosition[]): void {
    this.clear();

    for (const pos of positions) {
      this.set(pos.tokenId, pos);
    }

    this.lastSyncAt = Date.now();
  }

  /**
   * Get all positions as an array
   */
  getAllPositions(): StoredPosition[] {
    const positions: StoredPosition[] = [];
    for (const key of this.keys()) {
      const pos = this.get(key);
      if (pos) positions.push(pos);
    }
    return positions;
  }

  /**
   * Get position by token ID
   */
  getPosition(tokenId: string): StoredPosition | null {
    return this.get(tokenId);
  }

  /**
   * Check if we have a position for a token
   */
  hasPosition(tokenId: string): boolean {
    return this.has(tokenId);
  }

  /**
   * Check if position data is stale
   */
  isStale(): boolean {
    if (this.lastSyncAt === 0) return true;
    return Date.now() - this.lastSyncAt > this.staleThresholdMs;
  }

  /**
   * Get age of position data in milliseconds
   */
  getDataAge(): number {
    if (this.lastSyncAt === 0) return Infinity;
    return Date.now() - this.lastSyncAt;
  }

  /**
   * Get timestamp of last sync
   */
  getLastSyncAt(): number {
    return this.lastSyncAt;
  }

  /**
   * Get total value of all positions
   */
  getTotalValue(): number {
    let total = 0;
    for (const key of this.keys()) {
      const pos = this.get(key);
      if (pos) total += pos.value;
    }
    return total;
  }

  /**
   * Get total unrealized P&L
   */
  getTotalPnl(): number {
    let total = 0;
    for (const key of this.keys()) {
      const pos = this.get(key);
      if (pos) total += pos.pnlUsd;
    }
    return total;
  }

  /**
   * Get count of profitable vs losing positions
   */
  getProfitabilityBreakdown(): {
    profitable: number;
    losing: number;
    breakeven: number;
  } {
    let profitable = 0;
    let losing = 0;
    let breakeven = 0;

    for (const key of this.keys()) {
      const pos = this.get(key);
      if (pos) {
        if (pos.pnlUsd > 0.01) profitable++;
        else if (pos.pnlUsd < -0.01) losing++;
        else breakeven++;
      }
    }

    return { profitable, losing, breakeven };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Override Base Methods
  // ═══════════════════════════════════════════════════════════════════════════

  override clear(): void {
    super.clear();
    // Note: Don't reset lastSyncAt here, as clear() is called during sync
  }

  /**
   * Full reset including sync timestamp
   */
  reset(): void {
    super.clear();
    this.lastSyncAt = 0;
  }

  override getMetrics(): PositionStoreMetrics {
    const base = super.getMetrics();
    const breakdown = this.getProfitabilityBreakdown();

    return {
      ...base,
      totalValueUsd: this.getTotalValue(),
      totalPnlUsd: this.getTotalPnl(),
      profitableCount: breakdown.profitable,
      losingCount: breakdown.losing,
      dataAgeMs: this.getDataAge(),
    };
  }

  override healthCheck(): HealthStatus {
    const metrics = this.getMetrics();
    const isStale = this.isStale();

    const healthy = !isStale;
    const ageStr =
      metrics.dataAgeMs < Infinity
        ? `${(metrics.dataAgeMs / 1000).toFixed(1)}s old`
        : "never synced";

    return {
      healthy,
      message: healthy
        ? `${this.name}: ${metrics.entryCount} positions, $${metrics.totalValueUsd.toFixed(2)} value (${ageStr})`
        : `${this.name}: WARN - Data stale (${ageStr})`,
      details: {
        positionCount: metrics.entryCount,
        totalValueUsd: metrics.totalValueUsd,
        totalPnlUsd: metrics.totalPnlUsd,
        profitableCount: metrics.profitableCount,
        losingCount: metrics.losingCount,
        dataAgeMs: metrics.dataAgeMs,
        isStale,
      },
      checkedAt: Date.now(),
    };
  }
}

// ============================================================================
// Singleton Management
// ============================================================================

let globalPositionStore: PositionStore | null = null;

/**
 * Get the global PositionStore instance
 */
export function getPositionStore(): PositionStore {
  if (!globalPositionStore) {
    globalPositionStore = new PositionStore();
  }
  return globalPositionStore;
}

/**
 * Initialize a new global PositionStore (for testing or reset)
 */
export function initPositionStore(options?: {
  maxEntries?: number;
  staleThresholdMs?: number;
}): PositionStore {
  globalPositionStore = new PositionStore(options);
  return globalPositionStore;
}
