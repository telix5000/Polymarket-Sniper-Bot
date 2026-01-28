/**
 * BaseStore - Abstract base class for in-memory stores
 *
 * Provides common functionality for:
 * - LRU eviction
 * - TTL-based expiration
 * - Metrics tracking
 * - Health checks
 */

import type {
  Store,
  StoreOptions,
  StoreMetricsBase,
  HealthStatus,
  MetricsReportable,
} from "./types";

// ============================================================================
// BaseStore Implementation
// ============================================================================

/** Entry wrapper with metadata */
interface StoreEntry<V> {
  value: V;
  createdAt: number;
  accessedAt: number;
}

/** Extended metrics for BaseStore */
export interface BaseStoreMetrics extends StoreMetricsBase {
  /** Number of evictions due to capacity */
  evictions: number;

  /** Number of expirations due to TTL */
  expirations: number;

  /** Maximum entries allowed */
  maxEntries: number;
}

/**
 * Abstract base class for in-memory stores with LRU eviction and TTL support
 */
export abstract class BaseStore<K extends string | number, V>
  implements Store<K, V>, MetricsReportable<BaseStoreMetrics>
{
  protected readonly store = new Map<K, StoreEntry<V>>();
  protected readonly accessOrder: K[] = [];

  protected readonly maxEntries: number;
  protected readonly ttlMs: number;
  protected readonly trackMetrics: boolean;

  // Metrics
  protected hits = 0;
  protected misses = 0;
  protected evictions = 0;
  protected expirations = 0;
  protected lastUpdateAt = 0;

  constructor(
    protected readonly name: string,
    options: StoreOptions = {},
  ) {
    this.maxEntries = options.maxEntries ?? 1000;
    this.ttlMs = options.ttlMs ?? 0; // 0 = no TTL
    this.trackMetrics = options.trackMetrics ?? true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Store Interface Implementation
  // ═══════════════════════════════════════════════════════════════════════════

  get(key: K): V | null {
    const entry = this.store.get(key);

    if (!entry) {
      if (this.trackMetrics) this.misses++;
      return null;
    }

    // Check TTL
    if (this.ttlMs > 0 && Date.now() - entry.createdAt > this.ttlMs) {
      this.delete(key);
      if (this.trackMetrics) {
        this.misses++;
        this.expirations++;
      }
      return null;
    }

    // Update access time and LRU order
    entry.accessedAt = Date.now();
    this.touchKey(key);

    if (this.trackMetrics) this.hits++;
    return entry.value;
  }

  has(key: K): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;

    // Check TTL
    if (this.ttlMs > 0 && Date.now() - entry.createdAt > this.ttlMs) {
      this.delete(key);
      return false;
    }

    return true;
  }

  set(key: K, value: V): void {
    // Evict if at capacity
    while (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const lruKey = this.accessOrder.shift();
      if (lruKey !== undefined) {
        // Use internal delete to allow subclasses to clean up secondary indices
        // Note: accessOrder is already updated by shift(), so we call store.delete directly
        // and let subclasses override onEvict() for custom cleanup
        this.onEvict(lruKey);
        this.store.delete(lruKey);
        if (this.trackMetrics) this.evictions++;
      }
    }

    const now = Date.now();
    this.store.set(key, {
      value,
      createdAt: now,
      accessedAt: now,
    });

    this.touchKey(key);
    this.lastUpdateAt = now;
  }

  delete(key: K): boolean {
    const idx = this.accessOrder.indexOf(key);
    if (idx !== -1) {
      this.accessOrder.splice(idx, 1);
    }
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.accessOrder.length = 0;
  }

  keys(): K[] {
    // Filter out expired keys
    if (this.ttlMs > 0) {
      const now = Date.now();
      const validKeys: K[] = [];
      for (const [key, entry] of this.store) {
        if (now - entry.createdAt <= this.ttlMs) {
          validKeys.push(key);
        }
      }
      return validKeys;
    }
    return Array.from(this.store.keys());
  }

  size(): number {
    // Return count of non-expired entries
    if (this.ttlMs > 0) {
      return this.keys().length;
    }
    return this.store.size;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HealthCheckable Interface Implementation
  // ═══════════════════════════════════════════════════════════════════════════

  getName(): string {
    return this.name;
  }

  healthCheck(): HealthStatus {
    const metrics = this.getMetrics();
    const utilizationPct = (metrics.entryCount / metrics.maxEntries) * 100;

    // Consider unhealthy if > 95% full
    const healthy = utilizationPct < 95;

    return {
      healthy,
      message: healthy
        ? `${this.name}: OK (${metrics.entryCount}/${metrics.maxEntries} entries, ${(metrics.hitRatio * 100).toFixed(1)}% hit rate)`
        : `${this.name}: WARN - Near capacity (${utilizationPct.toFixed(1)}% full)`,
      details: {
        entryCount: metrics.entryCount,
        maxEntries: metrics.maxEntries,
        hitRatio: metrics.hitRatio,
        evictions: metrics.evictions,
      },
      checkedAt: Date.now(),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MetricsReportable Interface Implementation
  // ═══════════════════════════════════════════════════════════════════════════

  getMetrics(): BaseStoreMetrics {
    const total = this.hits + this.misses;
    return {
      entryCount: this.size(),
      hits: this.hits,
      misses: this.misses,
      hitRatio: total > 0 ? this.hits / total : 0,
      lastUpdateAt: this.lastUpdateAt,
      evictions: this.evictions,
      expirations: this.expirations,
      maxEntries: this.maxEntries,
    };
  }

  resetMetrics(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.expirations = 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Protected Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Update LRU access order for a key
   */
  protected touchKey(key: K): void {
    const idx = this.accessOrder.indexOf(key);
    if (idx !== -1) {
      this.accessOrder.splice(idx, 1);
    }
    this.accessOrder.push(key);
  }

  /**
   * Get raw entry (including metadata) - for subclasses
   */
  protected getEntry(key: K): StoreEntry<V> | undefined {
    return this.store.get(key);
  }

  /**
   * Check if an entry has expired based on TTL
   */
  protected isExpired(key: K): boolean {
    if (this.ttlMs === 0) return false;
    const entry = this.store.get(key);
    if (!entry) return true;
    return Date.now() - entry.createdAt > this.ttlMs;
  }

  /**
   * Get age of an entry in milliseconds
   */
  protected getAge(key: K): number {
    const entry = this.store.get(key);
    if (!entry) return Infinity;
    return Date.now() - entry.createdAt;
  }

  /**
   * Hook called before an entry is evicted due to LRU capacity limits.
   * Subclasses can override this to clean up secondary indices.
   * Note: The key has already been removed from accessOrder at this point.
   */
  protected onEvict(_key: K): void {
    // Default implementation does nothing.
    // Subclasses can override to clean up secondary indices.
  }
}
