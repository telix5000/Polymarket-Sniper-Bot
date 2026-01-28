/**
 * StoreRegistry - Central registry for all stores with health check aggregation
 *
 * Provides:
 * - Single place to register all stores
 * - Aggregated health checks across all stores
 * - Combined metrics reporting
 * - Consistent logging context
 */

import type { HealthCheckable, HealthStatus, LogContext } from "./types";
import { formatLogContext } from "./types";

// ============================================================================
// Types
// ============================================================================

/** Aggregated health status for all stores */
export interface AggregatedHealthStatus {
  /** Overall health (all stores must be healthy) */
  healthy: boolean;

  /** Count of healthy stores */
  healthyCount: number;

  /** Count of unhealthy stores */
  unhealthyCount: number;

  /** Individual store statuses */
  stores: Record<string, HealthStatus>;

  /** Timestamp of the check */
  checkedAt: number;
}

/** Metrics summary across all stores */
export interface AggregatedMetrics {
  /** Total entries across all stores */
  totalEntries: number;

  /** Number of registered stores */
  storeCount: number;

  /** Breakdown by store */
  byStore: Record<string, { entryCount: number; hitRatio: number }>;
}

// ============================================================================
// StoreRegistry Implementation
// ============================================================================

/**
 * Central registry for all stores
 *
 * Usage:
 *   const registry = getStoreRegistry();
 *   registry.register(getMarketCache());
 *   registry.register(getPositionStore());
 *   registry.register(getMarketDataStore());
 *
 *   // Check health
 *   const health = registry.healthCheck();
 *   if (!health.healthy) {
 *     console.warn("Some stores are unhealthy:", health);
 *   }
 */
export class StoreRegistry {
  private stores = new Map<string, HealthCheckable>();
  private readonly name = "StoreRegistry";

  // ═══════════════════════════════════════════════════════════════════════════
  // Registration
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Register a store for health checking
   */
  register(store: HealthCheckable): void {
    const name = store.getName();
    if (this.stores.has(name)) {
      console.warn(
        this.formatLog("register", {
          warning: `Store '${name}' already registered, replacing`,
        }),
      );
    }
    this.stores.set(name, store);
  }

  /**
   * Unregister a store
   */
  unregister(name: string): boolean {
    return this.stores.delete(name);
  }

  /**
   * Get a registered store by name
   */
  getStore<T extends HealthCheckable>(name: string): T | null {
    return (this.stores.get(name) as T) ?? null;
  }

  /**
   * Get names of all registered stores
   */
  getStoreNames(): string[] {
    return Array.from(this.stores.keys());
  }

  /**
   * Get count of registered stores
   */
  getStoreCount(): number {
    return this.stores.size;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Health Checks
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Perform health check on all registered stores
   */
  healthCheck(): AggregatedHealthStatus {
    const stores: Record<string, HealthStatus> = {};
    let healthyCount = 0;
    let unhealthyCount = 0;

    for (const [name, store] of this.stores) {
      try {
        const status = store.healthCheck();
        stores[name] = status;
        if (status.healthy) {
          healthyCount++;
        } else {
          unhealthyCount++;
        }
      } catch (err) {
        stores[name] = {
          healthy: false,
          message: `${name}: ERROR - Health check failed: ${err instanceof Error ? err.message : String(err)}`,
          checkedAt: Date.now(),
        };
        unhealthyCount++;
      }
    }

    return {
      healthy: unhealthyCount === 0,
      healthyCount,
      unhealthyCount,
      stores,
      checkedAt: Date.now(),
    };
  }

  /**
   * Check if all stores are healthy
   */
  isHealthy(): boolean {
    return this.healthCheck().healthy;
  }

  /**
   * Get health summary as a formatted string
   */
  getHealthSummary(): string {
    const health = this.healthCheck();
    const lines = [
      `=== Store Health Check (${health.healthy ? "✓ HEALTHY" : "✗ UNHEALTHY"}) ===`,
    ];

    for (const [_name, status] of Object.entries(health.stores)) {
      const icon = status.healthy ? "✓" : "✗";
      lines.push(`  ${icon} ${status.message}`);
    }

    lines.push(
      `=== ${health.healthyCount} healthy, ${health.unhealthyCount} unhealthy ===`,
    );
    return lines.join("\n");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Metrics
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get aggregated metrics from all stores that support it
   */
  getMetrics(): AggregatedMetrics {
    let totalEntries = 0;
    const byStore: Record<string, { entryCount: number; hitRatio: number }> =
      {};

    for (const [name, store] of this.stores) {
      // Check if store has getMetrics method
      if ("getMetrics" in store && typeof store.getMetrics === "function") {
        try {
          const metrics = (
            store as unknown as {
              getMetrics: () => { entryCount: number; hitRatio: number };
            }
          ).getMetrics();
          totalEntries += metrics.entryCount ?? 0;
          byStore[name] = {
            entryCount: metrics.entryCount ?? 0,
            hitRatio: metrics.hitRatio ?? 0,
          };
        } catch {
          // Store doesn't support metrics, skip
        }
      }
    }

    return {
      totalEntries,
      storeCount: this.stores.size,
      byStore,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Clear all stores
   */
  clearAll(): void {
    for (const store of this.stores.values()) {
      if ("clear" in store && typeof store.clear === "function") {
        (store as { clear: () => void }).clear();
      }
    }
  }

  /**
   * Reset the registry (unregister all stores)
   */
  reset(): void {
    this.stores.clear();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Logging
  // ═══════════════════════════════════════════════════════════════════════════

  private formatLog(
    operation: string,
    extra?: Record<string, unknown>,
  ): string {
    const ctx: LogContext = {
      component: this.name,
      operation,
      ...extra,
    };
    return formatLogContext(ctx);
  }
}

// ============================================================================
// Singleton Management
// ============================================================================

let globalRegistry: StoreRegistry | null = null;

/**
 * Get the global StoreRegistry instance
 */
export function getStoreRegistry(): StoreRegistry {
  if (!globalRegistry) {
    globalRegistry = new StoreRegistry();
  }
  return globalRegistry;
}

/**
 * Initialize a new global StoreRegistry (for testing or reset)
 */
export function initStoreRegistry(): StoreRegistry {
  globalRegistry = new StoreRegistry();
  return globalRegistry;
}
